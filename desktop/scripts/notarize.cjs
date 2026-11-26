"use strict";

const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { resolveNotaryAuth, runCmd, submitToNotary, stapleAndValidate } = require("./notarize-common.cjs");

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const auth = resolveNotaryAuth(process.env);
  if (auth.mode === "skip") {
    console.log(`[notarize] Skipping .app notarization: ${auth.reason}`);
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(context.appOutDir, `${appName}.app`);

  console.log(`[notarize] Verifying Developer ID code signature on ${appPath}...`);
  runCmd("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  const workDir = mkdtempSync(join(tmpdir(), "agentschat-notarize-app-"));
  const zipPath = join(workDir, `${appName}.zip`);
  try {
    runCmd("ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);
    submitToNotary(zipPath, auth);
    stapleAndValidate(appPath, "app");
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = afterSign;
module.exports.afterSign = afterSign;
module.exports.default = afterSign;
