import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const require = createRequire(import.meta.url);
const electronBinary = require("electron");

const tempDataDir = mkdtempSync(join(tmpdir(), "agentschat-desktop-smoke-"));

const child = spawn(String(electronBinary), [desktopDir], {
  stdio: "inherit",
  env: {
    ...process.env,
    AGENTSCHAT_DESKTOP_SMOKE_TEST: "1",
    AGENTSCHAT_DESKTOP_DATA_DIR: tempDataDir,
  },
});

function cleanupTempDir() {
  try {
    rmSync(tempDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  } catch {}
}

const timer = setTimeout(() => {
  console.error("[desktop-smoke] Timed out after 25s");
  child.kill();
  cleanupTempDir();
  process.exit(1);
}, 25_000);

child.on("exit", (code) => {
  clearTimeout(timer);
  cleanupTempDir();
  process.exit(code ?? 1);
});
