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

const timer = setTimeout(() => {
  console.error("[desktop-smoke] Timed out after 20s");
  child.kill();
  rmSync(tempDataDir, { recursive: true, force: true });
  process.exit(1);
}, 20_000);

child.on("exit", (code) => {
  clearTimeout(timer);
  rmSync(tempDataDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
