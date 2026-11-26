"use strict";

const { execFile } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const { promisify } = require("node:util");
const { resolveNotaryAuth, runCmd, sha256File, stapleAndValidate } = require("./notarize-common.cjs");

const execFileAsync = promisify(execFile);

async function submitDmgAsync(dmgPath, auth) {
  if (!existsSync(dmgPath)) {
    throw new Error(`[notarize] DMG does not exist: ${dmgPath}`);
  }
  console.log(`[notarize] Verifying Developer ID signature on ${dmgPath}...`);
  runCmd("codesign", ["--verify", "--verbose=2", dmgPath]);

  console.log(`[notarize] Submitting ${dmgPath} via ${auth.label} (waiting for Apple Notary Service)...`);
  let stdout;
  try {
    const res = await execFileAsync(
      "xcrun",
      ["notarytool", "submit", dmgPath, ...auth.args, "--wait", "--output-format", "json"],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    const out = String(err?.stdout || "").trim();
    const stderr = String(err?.stderr || "").trim();
    throw new Error(`[notarize] notarytool submit failed for ${dmgPath}: ${out || stderr || err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`[notarize] Failed to parse notarytool JSON response: ${stdout.slice(0, 500)}`);
  }

  const submissionId = parsed?.id || "unknown";
  const status = parsed?.status || "unknown";
  console.log(`[notarize] DMG submission ${submissionId} (${basename(dmgPath)}) status: ${status}`);

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
      `[notarize] Apple Notary rejected ${dmgPath} (id=${submissionId}, status=${status}).\n${notaryLog.slice(0, 4000)}`,
    );
  }

  stapleAndValidate(dmgPath, "dmg");
  return {
    file: basename(dmgPath),
    submissionId,
    status,
    sha256: sha256File(dmgPath),
  };
}

async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== "darwin") {
    return [];
  }

  const dmgs = (buildResult?.artifactPaths || []).filter((p) => typeof p === "string" && p.endsWith(".dmg"));
  if (dmgs.length === 0) {
    return [];
  }

  const auth = resolveNotaryAuth(process.env);
  if (auth.mode === "skip") {
    console.log(`[notarize] Skipping .dmg notarization: ${auth.reason}`);
    return [];
  }

  const records = await Promise.all(dmgs.map((dmgPath) => submitDmgAsync(dmgPath, auth)));

  const zips = (buildResult?.artifactPaths || []).filter((p) => typeof p === "string" && p.endsWith(".zip"));
  const zipRecords = zips.map((zipPath) => ({
    file: basename(zipPath),
    sha256: sha256File(zipPath),
  }));

  const outDir = buildResult?.outDir || dirname(dmgs[0]);
  const manifestPath = join(outDir, "macos-notarization.json");
  const manifest = {
    app: "AgentsChat Desktop",
    notarizedAt: new Date().toISOString(),
    authMode: auth.mode,
    dmgs: records,
    zips: zipRecords,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[notarize] Wrote notarization manifest: ${manifestPath}`);

  return [];
}

module.exports = afterAllArtifactBuild;
module.exports.afterAllArtifactBuild = afterAllArtifactBuild;
module.exports.default = afterAllArtifactBuild;
