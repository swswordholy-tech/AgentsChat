import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadBots, defaultRegistry, type BotConfig } from "./bots-config.ts";
import { assertDirectoryAncestors, atomicReplaceRegularFile } from "./config.ts";
import { codexPresent } from "./processes.ts";
let values: { config?: string; "watch-codex"?: boolean; check?: boolean; status?: boolean; help?: boolean } = {};
const root = join(homedir(), ".agentschat/codex-bots");
let registry = "";
const statusFile = join(root, "status.json"), lock = join(root, "manager.lock");
export interface Worker { child?: ChildProcess; config: BotConfig; fingerprint: string; failures: number; next: number; status: string }
const workers = new Map<string, Worker>();
let stopping = false, missing = 0, saveSeq = 0, timer: ReturnType<typeof setTimeout> | undefined;
export function removeDeadLock(file: string) {
  let raw: string;
  try {
    assertDirectoryAncestors(dirname(file));
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) return;
    raw = readFileSync(file, "utf8").trim();
  } catch { return; }
  const pid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 0) {
    try { unlinkSync(file); } catch {}
    return;
  }
  try { process.kill(pid, 0); } catch (e: any) { if (e.code === "ESRCH") try { unlinkSync(file); } catch {} }
}
export function save(rootDir = root) {
  const statusFile = join(rootDir, "status.json");
  const tmp = `${statusFile}.${process.pid}.${++saveSeq}.tmp`;
  let created = false;
  try {
    assertDirectoryAncestors(rootDir);
    const dir = lstatSync(rootDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return;
    try { if (lstatSync(statusFile).isSymbolicLink()) return; }
    catch (e: any) { if (e.code !== "ENOENT") return; }
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, updated_at: new Date().toISOString(), bots: [...workers.values()].map(w => ({ name: w.config.name, agent_id: w.config.agentId, workdir: w.config.cwd, effort: w.config.effort, model: w.config.model, pid: w.child?.pid, status: w.status })) }, null, 2), { mode: 0o600, flag: "wx" });
    created = true;
    atomicReplaceRegularFile(tmp, statusFile, () => {
      assertDirectoryAncestors(rootDir);
      const currentDir = lstatSync(rootDir);
      const currentFile = lstatSync(statusFile, { throwIfNoEntry: false });
      if (currentDir.isSymbolicLink() || !currentDir.isDirectory() ||
        (currentFile && (currentFile.isSymbolicLink() || !currentFile.isFile()))) throw new Error("Unsafe status destination");
    });
  } catch {
    if (created) try { unlinkSync(tmp); } catch {}
  }
}
export async function stop(w: Worker) {
  const child = w.child;
  if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(done => {
    const timeout = setTimeout(() => killGroup(child), 20_000);
    timeout.unref?.();
    const exited = () => { clearTimeout(timeout); killGroup(child); done(); };
    child.once("exit", exited);
    try { child.kill("SIGTERM"); }
    catch { clearTimeout(timeout); child.removeListener("exit", exited); done(); }
  });
  w.child = undefined; w.status = "stopped";
}
function killGroup(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}
export function start(w: Worker, spawnWorker = spawn) {
  removeDeadLock(join(w.config.stateDir, "bridge.lock")); w.status = "starting";
  const child = spawnWorker(process.execPath, [resolve(process.argv[1]!), "--codex-bridge", "--managed-worker"], { cwd: w.config.cwd, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  w.child = child;
  child.once("spawn", () => {
    if (child.connected) try { child.send(w.config, () => {}); } catch {}
  });
  let buffer = "";
  const escapedAgentId = w.config.agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const connectedRe = new RegExp(`(?:^|[\\r\\n])AgentsChat connected as ${escapedAgentId}(?![A-Za-z0-9_.-])`);
  child.stderr?.on("data", data => {
    buffer = (buffer + String(data)).slice(-8192);
    if (connectedRe.test(buffer)) { w.status = "connected"; w.failures = 0; buffer = ""; save(); }
    else if (/(?:^|[\r\n]).*\bdisconnected\b/i.test(buffer)) { w.status = "reconnecting"; buffer = ""; save(); }
  });
  child.stdout?.resume();
  const failed = () => { if (w.child !== child) return; killGroup(child); w.child = undefined; w.status = "retrying"; w.next = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++w.failures, 6)); save(); };
  child.once("error", failed); child.once("exit", failed);
}
async function tick() {
  try {
    const configs = loadBots(registry);
    for (const [name, worker] of workers) {
      const c = configs.find(c => c.name === name);
      if (!c || createHash("sha256").update(JSON.stringify(c)).digest("hex") !== worker.fingerprint) { await stop(worker); workers.delete(name); }
    }
    for (const c of configs) if (!workers.has(c.name)) workers.set(c.name, { config: c, fingerprint: createHash("sha256").update(JSON.stringify(c)).digest("hex"), failures: 0, next: 0, status: "waiting" });
  } catch { console.error("Invalid registry; keeping last valid configuration"); }
  if (stopping) return;
  let active: boolean;
  try { active = !values["watch-codex"] || await codexPresent(); } catch { console.error("Process detection unavailable"); return; }
  missing = active ? 0 : missing + 1;
  for (const w of workers.values()) {
    if (stopping) break;
    const now = Date.now();
    if (w.next - now > 60_000) w.next = now + 60_000;
    if (active && !w.child && now >= w.next) start(w);
    else if (!active && missing >= 2 && w.child) await stop(w);
  }
  save();
}
export function removeOwnedLock(file: string) {
  try {
    assertDirectoryAncestors(dirname(file));
    const stat = lstatSync(file);
    if (!stat.isSymbolicLink() && stat.isFile() && stat.size <= 64 * 1024 && readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
  } catch {}
}
async function main() {
  if (values.help) { console.log("agentschat-mcp --codex-bots [--config FILE] [--watch-codex] [--check|--status]\nCentral registry: ~/.agentschat/codex-bots.json; profiles: ~/.agentschat/profiles\nWatch polls external Codex processes every 5 seconds."); return; }
  if (values.status) {
    try {
      assertDirectoryAncestors(root);
      const stat = lstatSync(statusFile);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_048_576) throw new Error("Unsafe status file");
      const raw = readFileSync(statusFile, "utf8"), status = JSON.parse(raw);
      if (!status || typeof status !== "object" || Array.isArray(status) ||
        Object.prototype.hasOwnProperty.call(status, "__proto__") ||
        (status.pid !== undefined && (typeof status.pid !== "number" || !Number.isSafeInteger(status.pid) || status.pid <= 0)) ||
        !Array.isArray(status.bots) ||
        status.bots.some((b: unknown) => !b || typeof b !== "object" || Array.isArray(b) || Object.prototype.hasOwnProperty.call(b, "__proto__"))) throw new Error("Invalid status file");
      console.log(raw);
    } catch { console.error("Bot manager status unavailable; status file is missing, unsafe, or unreadable"); process.exitCode = 1; }
    return;
  }
  const configs = loadBots(registry);
  if (values.check) { console.log(JSON.stringify(configs.map(c => ({ name: c.name, agent_id: c.agentId, workdir: c.cwd, profile: c.profileFile })))); return; }
  for (const directory of [join(homedir(), ".agentschat"), root]) {
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Unsafe manager directory");
  }
  assertDirectoryAncestors(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = lstatSync(root);
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error("Unsafe manager directory");
  removeDeadLock(lock);
  if (lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Unsafe manager lock");
  const fd = openSync(lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
  let running: Promise<void> = Promise.resolve();
  const loop = () => { running = tick().catch(() => console.error("Supervisor tick failed")).finally(() => { if (!stopping) timer = setTimeout(loop, 5000); }); };
  const shutdown = async () => { if (stopping) return; stopping = true; clearTimeout(timer); await running; await Promise.all([...workers.values()].map(stop)); save(); removeOwnedLock(lock); };
  process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown()); loop();
}
if (import.meta.main || process.argv.includes("--codex-bots") || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  ({ values } = parseArgs({ options: { "codex-bots": { type: "boolean" }, config: { type: "string" }, "watch-codex": { type: "boolean" }, check: { type: "boolean" }, status: { type: "boolean" }, help: { type: "boolean" } } }));
  registry = resolve(values.config ?? defaultRegistry());
  main().catch(() => { console.error("Bot manager failed; check registry, profile permissions, and existing manager"); process.exitCode = 1; });
}
