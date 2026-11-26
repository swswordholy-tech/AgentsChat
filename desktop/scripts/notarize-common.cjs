"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync } = require("node:fs");

/**
 * Resolve Apple notarytool authentication arguments from environment variables.
 * Never returns or logs raw secrets in labels.
 */
function resolveNotaryAuth(env = process.env) {
  if (env.AGENTSCHAT_SKIP_NOTARIZE === "1" || env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    return { mode: "skip", reason: "signing or notarization explicitly disabled", args: [] };
  }

  const keychainProfile = (env.APPLE_NOTARY_KEYCHAIN_PROFILE || "").trim();
  if (keychainProfile) {
    return {
      mode: "keychain-profile",
      label: `keychain-profile(${keychainProfile})`,
      args: ["--keychain-profile", keychainProfile],
    };
  }

  const apiKey = (env.APPLE_API_KEY || "").trim();
  const apiKeyId = (env.APPLE_API_KEY_ID || "").trim();
  const apiIssuer = (env.APPLE_API_ISSUER || "").trim();
  if (apiKey && apiKeyId && apiIssuer) {
    return {
      mode: "api-key",
      label: `api-key(${apiKeyId})`,
      args: ["--key", apiKey, "--key-id", apiKeyId, "--issuer", apiIssuer],
    };
  }

  const appleId = (env.APPLE_ID || "").trim();
  const password = (env.APPLE_APP_SPECIFIC_PASSWORD || "").trim();
  const teamId = (env.APPLE_TEAM_ID || "").trim();
  if (appleId && password && teamId) {
    return {
      mode: "apple-id",
      label: `apple-id(${teamId})`,
      args: ["--apple-id", appleId, "--password", password, "--team-id", teamId],
    };
  }

  if (env.AGENTSCHAT_REQUIRE_NOTARIZE === "1") {
    throw new Error(
      "[notarize] AGENTSCHAT_REQUIRE_NOTARIZE=1 is set, but no Apple notarization credentials were found in env.",
    );
  }

  return {
    mode: "skip",
    reason:
      "no APPLE_NOTARY_KEYCHAIN_PROFILE, APPLE_API_KEY/ID/ISSUER, or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID configured",
    args: [],
  };
}

function runCmd(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function submitToNotary(artifactPath, auth) {
  if (!existsSync(artifactPath)) {
    throw new Error(`[notarize] Artifact does not exist: ${artifactPath}`);
  }
  console.log(`[notarize] Submitting ${artifactPath} via ${auth.label} (waiting for Apple Notary Service)...`);
  let stdout;
  try {
    stdout = runCmd("xcrun", ["notarytool", "submit", artifactPath, ...auth.args, "--wait", "--output-format", "json"]);
  } catch (err) {
    const out = String(err?.stdout || "").trim();
    const stderr = String(err?.stderr || "").trim();
    throw new Error(`[notarize] notarytool submit failed for ${artifactPath}: ${out || stderr || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`[notarize] Failed to parse notarytool JSON response: ${stdout.slice(0, 500)}`);
  }

  const submissionId = parsed?.id || "unknown";
  const status = parsed?.status || "unknown";
  console.log(`[notarize] Submission ${submissionId} status: ${status}`);

  if (status !== "Accepted") {
    let notaryLog = "";
    if (submissionId !== "unknown") {
      try {
        notaryLog = runCmd("xcrun", ["notarytool", "log", submissionId, ...auth.args]);
      } catch (logErr) {
        notaryLog = String(logErr?.stdout || logErr?.stderr || logErr?.message || "");
      }
    }
    throw new Error(
      `[notarize] Apple Notary rejected ${artifactPath} (id=${submissionId}, status=${status}).\n${notaryLog.slice(0, 4000)}`,
    );
  }

  return { id: submissionId, status };
}

function stapleAndValidate(targetPath, spctlType) {
  console.log(`[notarize] Stapling ticket to ${targetPath}...`);
  runCmd("xcrun", ["stapler", "staple", targetPath]);
  runCmd("xcrun", ["stapler", "validate", targetPath]);

  const spctlArgs =
    spctlType === "dmg"
      ? ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", targetPath]
      : ["--assess", "--type", "execute", "--verbose=4", targetPath];
  const spctlOut = execFileSync("spctl", spctlArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`[notarize] Gatekeeper OK (${spctlType}): ${targetPath}${spctlOut ? ` — ${spctlOut.trim()}` : ""}`);
}

module.exports = {
  resolveNotaryAuth,
  runCmd,
  sha256File,
  submitToNotary,
  stapleAndValidate,
};
