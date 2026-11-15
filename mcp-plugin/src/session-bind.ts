/**
 * Unified session binding & single-active-instance lock across harnesses
 * (Claude Code, Antigravity / agy, ZCode, Codex foreground & app-server bridge).
 *
 * 1. Session binding (`~/.agentschat/session-binds.json`):
 *    Maps a harness session/conversation ID (`CLAUDE_CODE_SESSION_ID`,
 *    `ANTIGRAVITY_CONVERSATION_ID`, `ZCODE_SESSION_ID`, or MCP `_meta.session_id`)
 *    to an AgentsChat profile name so each window remembers its bound identity
 *    across restarts without hardcoding `--profile` in global MCP config.
 *
 * 2. Single-active-instance lock (`<lockDir>/<agent_id>.lock`):
 *    Ensures at most ONE live process (foreground window or background bridge)
 *    uses a given `agent_id` at the same time. Checks `process.kill(pid, 0)` so
 *    crashed/closed processes automatically release their lock (never deadlocks).
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync, unlinkSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { safeWriteProfile } from "./profile-store.ts";

export const DEFAULT_SESSION_BINDS_FILENAME = "session-binds.json";
export const LEGACY_AGY_BINDS_FILENAME = "agy-binds.json";

export type HarnessRuntime = "claude-code" | "antigravity" | "zcode" | "dsh" | "codex-bridge" | "custom" | "mcp";

export interface DetectedSession {
  sessionId: string;
  runtime: HarnessRuntime;
  workspacePath?: string;
}

export interface AgentLockRecord {
  pid: number;
  agentId: string;
  profileName?: string | null;
  sessionId?: string | null;
  runtime?: HarnessRuntime | string;
  updatedAt: string;
}

export interface AgentLockCheck {
  locked: boolean;
  holder?: AgentLockRecord;
  stale?: boolean;
}

/** Check whether a local OS process is still alive. Never throws. */
export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    if (e && typeof e === "object" && e.code === "EPERM") return true;
    return false;
  }
}

/** Deterministic per-HOME lock directory in tmpdir (cleared on OS reboot, isolated in tests). */
export function resolveLockDir(homeDir: string, env: Record<string, string | undefined> = process.env): string {
  const explicit = env.AGENTSCHAT_LOCK_DIR?.trim();
  if (
    explicit &&
    explicit.length <= 4096 &&
    !explicit.startsWith("-") &&
    !CONTROL_CHAR_RE.test(explicit) &&
    isAbsolute(explicit) &&
    isSafeDirOrMissing(explicit)
  ) {
    return explicit;
  }
  const hash = createHash("sha256").update(homeDir || ".").digest("hex").slice(0, 12);
  const baseTmp = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(baseTmp, `agentschat-locks-${hash}`);
}

const LOCK_FILE_MAX_BYTES = 64 * 1024;
const LOCK_KEY_MAX_CHARS = 128;
const SESSION_BINDS_MAX_BYTES = 1024 * 1024;
const MAX_SESSION_BINDS_ENTRIES = 1024;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const WINDOWS_DEVICE_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const UNSAFE_BIND_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()),
]);
// NOTE: "profile" MUST NEVER be added here — `profile.json` is the default boot identity slot.
const RESERVED_BIND_SIDECARS = new Set([
  "session-binds",
  "session-binds.meta",
  "session-binds_meta",
  "agy-binds",
  "agy-binds.meta",
  "agy-binds_meta",
  "grok-binds",
  "grok-binds.meta",
  "grok-binds_meta",
  "agy-session-binds",
  "identity-guard",
  "cursor",
  "read-cursors",
  "mention-timestamps",
  "wake-pids",
  "config",
  "codex-bots",
  "dsh",
  "muse",
]);

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readBoundedRegularJson(path: string, maxBytes: number): unknown | null {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isSafeTargetFileOrMissing(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isFile();
  } catch (e: any) {
    return Boolean(e && typeof e === "object" && e.code === "ENOENT");
  }
}

function isAllowedDarwinSystemLink(dirPath: string): boolean {
  if (process.platform !== "darwin") return false;
  if (dirPath !== "/var" && dirPath !== "/tmp" && dirPath !== "/etc") return false;
  try {
    const expected = `/private${dirPath}`;
    return (
      readlinkSync(dirPath) === `private${dirPath}` &&
      realpathSync(dirPath) === expected &&
      !lstatSync("/private").isSymbolicLink() &&
      lstatSync("/private").isDirectory() &&
      !lstatSync(expected).isSymbolicLink() &&
      statSync(expected).isDirectory()
    );
  } catch {
    return false;
  }
}

function hasSafeRawDotDotSegments(rawPath: string): boolean {
  if (!rawPath.includes("..")) return true;
  const baseAbs = isAbsolute(rawPath) ? rawPath : `${process.cwd()}/${rawPath}`;
  const root = parse(baseAbs).root;
  const rawParts = baseAbs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (const part of rawParts) {
    if (part === ".") continue;
    if (part === "..") {
      cur = resolve(cur, "..");
      continue;
    }
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        if (isAllowedDarwinSystemLink(cur)) continue;
        return false;
      }
      if (!st.isDirectory()) return false;
    } catch (e: any) {
      if (e && typeof e === "object" && e.code === "ENOENT") continue;
      return false;
    }
  }
  return true;
}

function isSafeDirOrMissing(dirPath: string): boolean {
  if (!dirPath || CONTROL_CHAR_RE.test(dirPath)) return false;
  if (!hasSafeRawDotDotSegments(dirPath)) return false;
  const abs = resolve(dirPath);
  const root = parse(abs).root;
  const segments = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i]!);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink()) {
        if (isAllowedDarwinSystemLink(cur)) continue;
        return false;
      }
      if (!st.isDirectory()) return false;
    } catch (e: any) {
      if (e && typeof e === "object" && e.code === "ENOENT") return true;
      return false;
    }
  }
  return true;
}

function isValidBindToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !CONTROL_CHAR_RE.test(value);
}

function isValidBoundProfileName(value: string): boolean {
  if (
    !isValidBindToken(value) ||
    value === "." ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    return false;
  }
  const rawStem = value.replace(/\.json$/i, "");
  const stem = rawStem.toLowerCase();
  const normalizedStem = stem.replace(/[^a-z0-9_-]/g, "_");
  return (
    Boolean(stem) &&
    !WINDOWS_DEVICE_STEM_RE.test(rawStem) &&
    !isUnsafeBindKey(value) &&
    !isUnsafeBindKey(stem) &&
    !RESERVED_BIND_SIDECARS.has(stem) &&
    !RESERVED_BIND_SIDECARS.has(normalizedStem)
  );
}

export function lockFilePath(lockDir: string, agentId: string): string {
  const trimmed = String(agentId || "").trim();
  let safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (safe.length > LOCK_KEY_MAX_CHARS) {
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    safe = `${safe.slice(0, LOCK_KEY_MAX_CHARS - 13)}_${digest}`;
  }
  if (!safe || isUnsafeBindKey(safe)) {
    safe = `_${safe}`;
  }
  return join(lockDir, `${safe}.lock`);
}

export function readAgentLock(lockDir: string, agentId: string): AgentLockRecord | null {
  if (!agentId || !isSafeDirOrMissing(lockDir)) return null;
  const file = lockFilePath(lockDir, agentId);
  const raw = readBoundedRegularJson(file, LOCK_FILE_MAX_BYTES) as Record<string, unknown> | null;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.prototype.hasOwnProperty.call(raw, "__proto__") ||
    typeof raw.pid !== "number" ||
    typeof raw.agentId !== "string"
  ) {
    return null;
  }
  return raw as unknown as AgentLockRecord;
}

/**
 * Check if `agentId` is currently locked by ANOTHER live process.
 * Returns `{ locked: false }` if unlocked, if the lock holder PID exited,
 * if held by `currentPid`, if held by `lockOwnerPid` (parent bridge/wake turn),
 * or if held by the same `currentSessionId`.
 */
export function checkAgentLock(opts: {
  lockDir: string;
  agentId: string;
  currentPid?: number;
  currentSessionId?: string | null;
  lockOwnerPid?: number | null;
}): AgentLockCheck {
  const { lockDir, agentId } = opts;
  const currentPid = opts.currentPid ?? process.pid;
  if (!agentId || !isSafeDirOrMissing(lockDir)) return { locked: false };
  const file = lockFilePath(lockDir, agentId);
  const record = readAgentLock(lockDir, agentId);
  if (!record) {
    try {
      const st = lstatSync(file);
      const ageMs = Date.now() - st.mtimeMs;
      if (!st.isSymbolicLink() && st.isFile() && (ageMs > 1_000 || ageMs < -1_000)) unlinkSync(file);
    } catch {}
    return { locked: false };
  }
  if (!isPidAlive(record.pid)) {
    try { unlinkSync(file); } catch {}
    return { locked: false, stale: true };
  }
  if (record.pid === currentPid) {
    if (opts.currentSessionId && record.sessionId && opts.currentSessionId !== record.sessionId) {
      return { locked: true, holder: record };
    }
    return { locked: false, holder: record };
  }
  if (opts.lockOwnerPid && record.pid === opts.lockOwnerPid) return { locked: false, holder: record };
  if (opts.currentSessionId && record.sessionId && opts.currentSessionId === record.sessionId) {
    return { locked: false, holder: record };
  }
  return { locked: true, holder: record };
}

/** Write/update the lock for `agentId` owned by `currentPid`. */
export function acquireAgentLock(opts: {
  lockDir: string;
  agentId: string;
  profileName?: string | null;
  sessionId?: string | null;
  runtime?: HarnessRuntime | string;
  currentPid?: number;
}): AgentLockRecord | null {
  if (!opts.agentId) return null;
  const file = lockFilePath(opts.lockDir, opts.agentId);
  if (!isSafeDirOrMissing(opts.lockDir) || !isSafeTargetFileOrMissing(file)) return null;
  const record: AgentLockRecord = {
    pid: opts.currentPid ?? process.pid,
    agentId: opts.agentId,
    profileName: opts.profileName ?? null,
    sessionId: opts.sessionId ?? null,
    runtime: opts.runtime ?? "mcp",
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(opts.lockDir, { recursive: true, mode: 0o700 });
    safeWriteProfile(file, record);
    return record;
  } catch {
    return null;
  }
}

/** Release `<agentId>.lock` only if owned by `currentPid` (or `currentSessionId`). */
export function releaseAgentLock(opts: {
  lockDir: string;
  agentId: string;
  currentPid?: number;
  currentSessionId?: string | null;
}): boolean {
  if (!opts.agentId || !isSafeDirOrMissing(opts.lockDir)) return false;
  const currentPid = opts.currentPid ?? process.pid;
  const file = lockFilePath(opts.lockDir, opts.agentId);
  const existing = readAgentLock(opts.lockDir, opts.agentId);
  if (!existing) {
    try {
      const st = lstatSync(file);
      const ageMs = Date.now() - st.mtimeMs;
      if (!st.isSymbolicLink() && st.isFile() && (ageMs > 1_000 || ageMs < -1_000)) {
        unlinkSync(file);
        return true;
      }
    } catch {}
    return false;
  }
  const samePid = existing.pid === currentPid;
  const sameSession = Boolean(opts.currentSessionId && existing.sessionId && opts.currentSessionId === existing.sessionId);
  const dead = !isPidAlive(existing.pid);
  if (!samePid && !sameSession && !dead) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function isUnsafeBindKey(key: string): boolean {
  return UNSAFE_BIND_KEYS.has(key.toLowerCase());
}

/** Parse a `session-binds.json` (or `agy-binds.json`) payload into `sessionId -> profileName`. */
export function parseSessionBinds(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_SESSION_BINDS_ENTRIES) break;
    const key = k.trim();
    if (!isValidBindToken(key) || key === "." || key === ".." || isUnsafeBindKey(key)) continue;
    if (typeof v === "string") {
      const val = v.trim();
      if (isValidBoundProfileName(val)) {
        out[key] = val;
        count += 1;
      }
    } else if (v && typeof v === "object" && typeof (v as any).profile === "string") {
      const val = (v as any).profile.trim();
      if (isValidBoundProfileName(val)) {
        out[key] = val;
        count += 1;
      }
    }
  }
  return out;
}

export function loadSessionBinds(configDir: string): Record<string, string> {
  if (!isSafeDirOrMissing(configDir)) return {};
  const merged: Record<string, string> = {};
  for (const filename of [LEGACY_AGY_BINDS_FILENAME, DEFAULT_SESSION_BINDS_FILENAME]) {
    const path = join(configDir, filename);
    const parsed = readBoundedRegularJson(path, SESSION_BINDS_MAX_BYTES);
    if (parsed !== null) {
      Object.assign(merged, parseSessionBinds(parsed));
    }
  }
  return merged;
}

function resolveAgentIdForProfileName(configDir: string, name: string): string | null {
  if (!name || name === "." || name.includes("..") || name.includes("/") || name.includes("\\") || CONTROL_CHAR_RE.test(name)) return null;
  if (!isSafeDirOrMissing(configDir)) return null;
  const rawStem = name.replace(/\.json$/i, "");
  const stem = rawStem.toLowerCase();
  const base = rawStem.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (
    !base ||
    base.length > LOCK_KEY_MAX_CHARS ||
    WINDOWS_DEVICE_STEM_RE.test(rawStem) ||
    WINDOWS_DEVICE_STEM_RE.test(base) ||
    isUnsafeBindKey(base) ||
    RESERVED_BIND_SIDECARS.has(stem) ||
    RESERVED_BIND_SIDECARS.has(base.toLowerCase())
  ) {
    return null;
  }
  const profilesDir = join(configDir, "profiles");
  const candidates = isSafeDirOrMissing(profilesDir)
    ? [join(profilesDir, `${base}.json`), join(configDir, `${base}.json`)]
    : [join(configDir, `${base}.json`)];
  for (const candidate of candidates) {
    const parsed = readBoundedRegularJson(candidate, SESSION_BINDS_MAX_BYTES) as { agent_id?: unknown } | null;
    if (typeof parsed?.agent_id === "string" && parsed.agent_id.trim()) {
      return parsed.agent_id.trim();
    }
  }
  return null;
}

export function saveSessionBind(configDir: string, sessionId: string, profileName: string): void {
  const sid = sessionId.trim();
  const prof = profileName.trim();
  if (!isValidBindToken(sid) || sid === "." || sid === ".." || isUnsafeBindKey(sid) || !isValidBoundProfileName(prof)) {
    return;
  }
  if (!isSafeDirOrMissing(configDir)) return;
  const path = join(configDir, DEFAULT_SESSION_BINDS_FILENAME);
  if (!isSafeTargetFileOrMissing(path)) return;
  const targetAgentId = resolveAgentIdForProfileName(configDir, prof);
  const isSameProfileOrAgent = (existingProf: string): boolean => {
    if (existingProf === prof) return true;
    if (!targetAgentId) return false;
    return resolveAgentIdForProfileName(configDir, existingProf) === targetAgentId;
  };
  let current: Record<string, string> = {};
  const existingParsed = readBoundedRegularJson(path, SESSION_BINDS_MAX_BYTES);
  if (existingParsed !== null) {
    current = parseSessionBinds(existingParsed);
  }
  // Enforce 1:1 (profileName & agent_id) <-> sessionId mapping so re-binding a
  // profile (or an alias file such as `profile.json` + `<Name>.json` sharing one
  // `agent_id`) replaces any stale conversation bound to the same identity.
  for (const [existingSid, existingProf] of Object.entries(current)) {
    if (existingSid !== sid && isSameProfileOrAgent(existingProf)) {
      delete current[existingSid];
    }
  }
  delete current[sid];
  current[sid] = prof;
  mkdirSync(configDir, { recursive: true });
  safeWriteProfile(path, current);

  const legacyPath = join(configDir, LEGACY_AGY_BINDS_FILENAME);
  if (isSafeTargetFileOrMissing(legacyPath)) {
    const legacyParsed = readBoundedRegularJson(legacyPath, SESSION_BINDS_MAX_BYTES);
    if (legacyParsed !== null) {
      try {
        const legacy = parseSessionBinds(legacyParsed);
        let changed = false;
        for (const [existingSid, existingProf] of Object.entries(legacy)) {
          if (existingSid !== sid && isSameProfileOrAgent(existingProf)) {
            delete legacy[existingSid];
            changed = true;
          }
        }
        if (changed) safeWriteProfile(legacyPath, legacy);
      } catch {}
    }
  }
}

export function removeSessionBind(configDir: string, sessionId: string): boolean {
  const sid = sessionId.trim();
  if (!isValidBindToken(sid) || sid === "." || sid === ".." || isUnsafeBindKey(sid)) return false;
  if (!isSafeDirOrMissing(configDir)) return false;
  let removed = false;
  for (const filename of [DEFAULT_SESSION_BINDS_FILENAME, LEGACY_AGY_BINDS_FILENAME]) {
    const path = join(configDir, filename);
    if (!isSafeTargetFileOrMissing(path)) continue;
    const raw = readBoundedRegularJson(path, SESSION_BINDS_MAX_BYTES);
    if (raw === null) continue;
    try {
      const current = parseSessionBinds(raw);
      if (Object.hasOwn(current, sid)) {
        delete current[sid];
        safeWriteProfile(path, current);
        removed = true;
      }
    } catch {}
  }
  return removed;
}

/** Find the sessionId bound to a given `profileName` (e.g. for Antigravity/ZCode inbound routing). */
export function findBoundSessionForProfile(
  configDir: string,
  profileName: string | null | undefined,
  filter?: (sessionId: string) => boolean,
): string | null {
  if (!profileName) return null;
  const target = profileName.trim();
  if (!target) return null;
  const binds = loadSessionBinds(configDir);
  const matches: string[] = [];
  for (const [sid, prof] of Object.entries(binds)) {
    if (prof === target && (!filter || filter(sid))) matches.push(sid);
  }
  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

function isSafeDetectedSessionId(sid: string): boolean {
  return isValidBindToken(sid) && sid !== "." && !sid.includes("..") && !sid.includes("/") && !sid.includes("\\") && !isUnsafeBindKey(sid);
}

function cleanDetectedWorkspacePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.length > 4096 || s.startsWith("-") || CONTROL_CHAR_RE.test(s)) return undefined;
  return s;
}

/** Detect session ID from environment variables or MCP request `_meta` (ZCode). */
export function detectRuntimeSession(
  env: Record<string, string | undefined> = process.env,
  meta?: Record<string, any> | null,
): DetectedSession | null {
  // 1. ZCode MCP request `_meta` (injected on every tools/call by ZCode's NodeMcpAdapter)
  const zcodeCtx = meta?.["com.zcode/request-context"];
  const metaSessionId =
    (typeof meta?.session_id === "string" && meta.session_id.trim()) ||
    (typeof zcodeCtx?.session_id === "string" && zcodeCtx.session_id.trim()) ||
    "";
  if (isSafeDetectedSessionId(metaSessionId)) {
    const workspacePath =
      cleanDetectedWorkspacePath(meta?.workspace_path) ||
      cleanDetectedWorkspacePath(zcodeCtx?.workspace_path);
    return { sessionId: metaSessionId, runtime: "zcode", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 2. ZCode environment variable
  const zcodeEnvSid = env.ZCODE_SESSION_ID?.trim() || "";
  if (isSafeDetectedSessionId(zcodeEnvSid)) {
    const workspacePath = cleanDetectedWorkspacePath(env.ZCODE_PROJECT_DIR);
    return { sessionId: zcodeEnvSid, runtime: "zcode", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 3. Antigravity explicit environment variable
  const agySid = env.ANTIGRAVITY_CONVERSATION_ID?.trim() || "";
  if (isSafeDetectedSessionId(agySid)) {
    return { sessionId: agySid, runtime: "antigravity" };
  }

  // 4. Claude Code environment variable
  const claudeSid = (env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "").trim();
  if (isSafeDetectedSessionId(claudeSid)) {
    const workspacePath = cleanDetectedWorkspacePath(env.CLAUDE_PROJECT_DIR);
    return { sessionId: claudeSid, runtime: "claude-code", ...(workspacePath ? { workspacePath } : {}) };
  }

  // 5. Explicit generic session ID override
  const explicitSid = (env.AGENTSCHAT_SESSION_ID || env.AGENTCHAT_SESSION_ID || "").trim();
  if (isSafeDetectedSessionId(explicitSid)) {
    return { sessionId: explicitSid, runtime: "custom" };
  }

  // 6. Antigravity parent language_server discovery (macOS & Linux).
  // Skip expensive ps/lsof parent-tree probing when running against a loopback mock
  // hub in tests with a stripped env (unless explicit Antigravity env vars are set).
  const hasExplicitAgyEnv =
    env.__CFBundleIdentifier === "com.google.antigravity" ||
    Boolean(env.AGY_BROWSER_WS_URL) ||
    Boolean(env.ANTIGRAVITY_LS_ADDRESS) ||
    Boolean(env.ANTIGRAVITY_CSRF_TOKEN);
  const isMockHubSubprocess =
    !hasExplicitAgyEnv &&
    typeof env.AGENTCHAT_REST_URL === "string" &&
    /^http:\/\/127\.0\.0\.1:\d+/.test(env.AGENTCHAT_REST_URL);
  if (!isMockHubSubprocess && (env === process.env || hasExplicitAgyEnv)) {
    const agyHost = discoverAntigravityHost();
    if (agyHost && agyHost.openConversations.length === 1) {
      return { sessionId: agyHost.openConversations[0]!, runtime: "antigravity" };
    }
  }

  return null;
}

export interface AntigravityHostInfo {
  lsPid: number;
  csrfToken: string;
  ports: number[];
  openConversations: string[];
}

let cachedAgyHost: { at: number; info: AntigravityHostInfo | null } | null = null;

/**
 * Inspect ancestor processes (or local user processes) to see if this MCP server
 * was spawned by Antigravity's `language_server`. Extracts `--csrf_token`,
 * listening loopback ports, and open `presence/<conversation_id>.lock` files.
 */
/**
 * Parse `lsof -Pan -p <language_server_pid>` output into listening loopback ports
 * and currently open Antigravity IDE conversation UUIDs.
 *
 * Important distinctions verified on live Antigravity `language_server` processes:
 * 1. `language_server` keeps all historical `~/.gemini/antigravity-cli/conversations/*.db`
 *    files open read-only (`61r..137r`); those archived CLI DBs are NOT open IDE windows.
 * 2. Active IDE windows hold an open FD on `/<appDataDir>/presence/<uuid>.lock`, whereas
 *    closed tabs immediately release their presence lock while SQLite may keep their
 *    `/<appDataDir>/conversations/<uuid>.db` cached in its pool. Prefer active presence
 *    locks whenever present, falling back to non-CLI `.db` handles only when no presence
 *    locks exist.
 */
export function parseAntigravityLsofOutput(
  stdout: string,
  appDataDir = "antigravity",
): { ports: number[]; openConversations: string[] } {
  const ports: number[] = [];
  const presenceConversations: string[] = [];
  const dbConversations: string[] = [];
  const cleanAppDir = (appDataDir || "antigravity").trim().replace(/^\/+|\/+$/g, "");
  const isCliTarget = cleanAppDir === "antigravity-cli";

  for (const line of (stdout || "").split(/\r?\n/)) {
    const portMatch = line.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/);
    if (portMatch) {
      const p = Number(portMatch[1]);
      if (Number.isSafeInteger(p) && p >= 1 && p <= 65535 && !ports.includes(p)) ports.push(p);
    }
    if (!isCliTarget && line.includes("/antigravity-cli/")) continue;

    const presMatch = line.match(/\/presence\/([0-9a-fA-F-]{36})\.lock$/);
    if (presMatch) {
      const cid = presMatch[1]!;
      if (!presenceConversations.includes(cid)) presenceConversations.push(cid);
      continue;
    }

    const dbMatch = line.match(/\/conversations\/([0-9a-fA-F-]{36})\.db$/);
    if (dbMatch) {
      if (cleanAppDir && line.includes("/.gemini/") && !line.includes(`/${cleanAppDir}/conversations/`)) {
        continue;
      }
      const cid = dbMatch[1]!;
      if (!dbConversations.includes(cid)) dbConversations.push(cid);
    }
  }

  // Antigravity allocates https_server_port first and http_server_port second;
  // sort descending so the plaintext HTTP Connect-RPC port is tried first.
  ports.sort((a, b) => b - a);
  const openConversations =
    presenceConversations.length > 0 ? presenceConversations : dbConversations;
  return { ports, openConversations };
}

function extractCliFlagValue(cmd: string, flag: string): string {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`);
  const m = cmd.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

/**
 * Parse Windows `netstat -ano` output into listening loopback (`127.0.0.1` / `[::1]`)
 * TCP ports owned by `targetPid`, sorted descending so plaintext HTTP Connect-RPC
 * ports allocated after HTTPS are tried first.
 *
 * Matches foreign address `0.0.0.0:0` / `[::]:0` / `*:*` rather than English
 * `"LISTENING"` text so localized Windows builds (German, French, Spanish, Chinese, etc.)
 * work identically.
 */
export function parseWindowsNetstatOutput(stdout: string, targetPid: number): number[] {
  if (!stdout || !Number.isSafeInteger(targetPid) || targetPid <= 0) return [];
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(
      /^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):(\d+)\s+(?:0\.0\.0\.0:0|\[::\]:0|\*:\*)\s+\S+\s+(\d+)\s*$/i,
    );
    if (!m) continue;
    const port = Number(m[1]);
    const pid = Number(m[2]);
    if (pid === targetPid && Number.isSafeInteger(port) && port >= 1 && port <= 65535 && !ports.includes(port)) {
      ports.push(port);
    }
  }
  ports.sort((a, b) => b - a);
  return ports;
}

/**
 * Pure parser for the JSON emitted by `discoverWindowsAntigravityHost`'s PowerShell probe
 * (`{ lsPid, lsCmd, ports, lockedPresence, lockedDbs }`), with optional `netstat -ano`
 * fallback output when `Get-NetTCPConnection` is unavailable.
 */
export function parseWindowsAntigravityProbeJson(
  stdout: string,
  netstatStdout = "",
): AntigravityHostInfo | null {
  const trimmed = (stdout || "").trim();
  if (!trimmed || trimmed === "{}") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
    return null;
  }
  const lsPid = Number(parsed?.lsPid);
  const lsCmd = typeof parsed?.lsCmd === "string" ? parsed.lsCmd : "";
  if (!Number.isSafeInteger(lsPid) || lsPid <= 0 || !lsCmd) return null;

  const csrfToken = extractCliFlagValue(lsCmd, "--csrf_token");
  if (!csrfToken) return null;

  const portSet = new Set<number>();
  const rawPorts = Array.isArray(parsed?.ports)
    ? parsed.ports
    : typeof parsed?.ports === "number"
      ? [parsed.ports]
      : [];
  for (const p of rawPorts) {
    const num = Number(p);
    if (Number.isSafeInteger(num) && num >= 1 && num <= 65535) portSet.add(num);
  }
  if (portSet.size === 0 && netstatStdout) {
    for (const p of parseWindowsNetstatOutput(netstatStdout, lsPid)) {
      portSet.add(p);
    }
  }
  const ports = [...portSet].sort((a, b) => b - a);

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const toUuidList = (val: unknown): string[] => {
    const arr = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
    const out: string[] = [];
    for (const item of arr) {
      const s = String(item || "").trim();
      if (uuidRe.test(s) && !out.includes(s)) out.push(s);
    }
    return out;
  };
  const lockedPresence = toUuidList(parsed?.lockedPresence);
  const lockedDbs = toUuidList(parsed?.lockedDbs);
  const openConversations = lockedPresence.length > 0 ? lockedPresence : lockedDbs;

  return { lsPid, csrfToken, ports, openConversations };
}

function runWindowsPowerShell(script: string, timeoutMs = 4000): string | null {
  for (const bin of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    const res = spawnSync(
      bin,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
    );
    if (!res.error && res.status === 0 && typeof res.stdout === "string") {
      return res.stdout;
    }
    if (!res.error) break;
  }
  return null;
}

function discoverWindowsAntigravityHost(currentPid: number): AntigravityHostInfo | null {
  // Walk up to 8 ancestor hops on Windows because npm/cmd shims (`language_server.exe` ->
  // `cmd.exe` -> `node npx` -> `cmd.exe` -> `node server.js`) add extra intermediate hops.
  // Active IDE windows hold an open OS file handle on `~/.gemini/<appDataDir>/presence/<uuid>.lock`
  // while historical closed tabs leave unlocked `.lock` files on disk; probing with
  // `[System.IO.File]::Open(..., FileShare.None)` triggers a kernel `SharingViolation`
  // (`IOException`) if and only if another process currently holds an open handle, requiring
  // zero administrator privileges and never mutating file contents or mtime.
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = ${Math.trunc(currentPid)}`,
    "$lsPid = 0",
    "$lsCmd = ''",
    "for ($h = 0; $h -lt 8 -and $p -gt 0; $h++) {",
    "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$p\"",
    "  if (-not $proc) { break }",
    "  $cmd = [string]$proc.CommandLine",
    "  $name = [string]$proc.Name",
    "  if ($h -gt 0 -and ($cmd -match 'bun(?:\\.exe)?\\s+test' -or $cmd -match 'node(?:\\.exe)?\\s+--test')) { break }",
    "  if (($cmd -match 'language_server' -or $name -match 'language_server') -and $cmd -match '--csrf_token') {",
    "    $lsPid = [int]$proc.ProcessId",
    "    $lsCmd = $cmd",
    "    break",
    "  }",
    "  $nextP = [int]$proc.ParentProcessId",
    "  if ($nextP -le 0 -or $nextP -eq $p) { break }",
    "  $p = $nextP",
    "}",
    "if ($lsPid -le 0) { Write-Output '{}'; exit 0 }",
    "$ports = @()",
    "if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {",
    "  $ports = @(Get-NetTCPConnection -OwningProcess $lsPid -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '::1' } | ForEach-Object { [int]$_.LocalPort } | Select-Object -Unique)",
    "}",
    "$appDir = 'antigravity'",
    "if ($lsCmd -match '--app_data_dir(?:=|\\s+)(?:\"([^\"]+)\"|''([^'']+)''|([^\\s\"'']+))') {",
    "  $appDir = if ($Matches[1]) { $Matches[1] } elseif ($Matches[2]) { $Matches[2] } else { $Matches[3] }",
    "}",
    "$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }",
    "$baseDir = Join-Path (Join-Path $homeDir '.gemini') $appDir",
    "$lockedPresence = @()",
    "$presDir = Join-Path $baseDir 'presence'",
    "if (Test-Path -LiteralPath $presDir) {",
    "  Get-ChildItem -LiteralPath $presDir -Filter '*.lock' -File | ForEach-Object {",
    "    if ($_.BaseName -match '^[0-9a-fA-F-]{36}$') {",
    "      try {",
    "        $s = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "        $s.Dispose()",
    "      } catch [System.IO.IOException] {",
    "        $lockedPresence += $_.BaseName",
    "      } catch {}",
    "    }",
    "  }",
    "}",
    "$lockedDbs = @()",
    "if ($lockedPresence.Count -eq 0 -and $appDir -ne 'antigravity-cli') {",
    "  $convDir = Join-Path $baseDir 'conversations'",
    "  if (Test-Path -LiteralPath $convDir) {",
    "    Get-ChildItem -LiteralPath $convDir -Filter '*.db' -File | ForEach-Object {",
    "      if ($_.BaseName -match '^[0-9a-fA-F-]{36}$') {",
    "        try {",
    "          $s = [System.IO.File]::Open($_.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
    "          $s.Dispose()",
    "        } catch [System.IO.IOException] {",
    "          $lockedDbs += $_.BaseName",
    "        } catch {}",
    "      }",
    "    }",
    "  }",
    "}",
    "[pscustomobject]@{ lsPid = $lsPid; lsCmd = $lsCmd; ports = $ports; lockedPresence = $lockedPresence; lockedDbs = $lockedDbs } | ConvertTo-Json -Compress",
  ].join("; ");

  const stdout = runWindowsPowerShell(psScript, 4000);
  if (!stdout) return null;

  let info = parseWindowsAntigravityProbeJson(stdout);
  if (info && info.ports.length === 0) {
    const ns = spawnSync("netstat", ["-ano"], { encoding: "utf8", timeout: 2000, windowsHide: true });
    if (ns.status === 0 && ns.stdout) {
      info = parseWindowsAntigravityProbeJson(stdout, ns.stdout);
    }
  }
  return info;
}

export function discoverAntigravityHost(opts?: {
  currentPid?: number;
  cacheMs?: number;
}): AntigravityHostInfo | null {
  if (!opts?.currentPid) {
    const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim() || "";
    const envCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim() || "";
    if (envAddr && envCsrf) {
      const portMatch = envAddr.match(/:(\d+)$/);
      const ports = portMatch ? [Number(portMatch[1])] : [];
      const openConversations = (process.env.ANTIGRAVITY_OPEN_CONVERSATIONS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));
      return { lsPid: process.ppid, csrfToken: envCsrf, ports, openConversations };
    }
    const hasExplicitAgyEnv =
      process.env.__CFBundleIdentifier === "com.google.antigravity" ||
      Boolean(process.env.AGY_BROWSER_WS_URL);
    if (
      !hasExplicitAgyEnv &&
      typeof process.env.AGENTCHAT_REST_URL === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+/.test(process.env.AGENTCHAT_REST_URL)
    ) {
      return null;
    }
  }

  const now = Date.now();
  const cacheMs =
    typeof opts?.cacheMs === "number" && Number.isFinite(opts.cacheMs) && opts.cacheMs >= 0
      ? opts.cacheMs
      : 5_000;
  if (cachedAgyHost && now < cachedAgyHost.at) cachedAgyHost = null;
  if (cachedAgyHost && now - cachedAgyHost.at < cacheMs) return cachedAgyHost.info;

  try {
    const startPid = opts?.currentPid ?? process.pid;
    if (process.platform === "win32") {
      const winInfo = discoverWindowsAntigravityHost(startPid);
      cachedAgyHost = { at: now, info: winInfo };
      return winInfo;
    }

    // Walk up from currentPid using fast per-PID `ps -p` queries so we never scan
    // the whole system process table or match an indirect test runner several hops
    // below language_server.
    let pid = startPid;
    let lsPid = 0;
    let lsCmd = "";
    for (let hop = 0; hop < 4 && pid > 1; hop++) {
      const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], { encoding: "utf8", timeout: 1000 });
      if (ps.status !== 0 || !ps.stdout) break;
      const line = ps.stdout.trim().split(/\r?\n/)[0]?.trim() || "";
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      const ppid = Number(m[1]);
      const cmd = m[2]!;
      if (hop > 0 && (cmd.includes("bun test") || cmd.includes("node --test"))) break;
      if (cmd.includes("language_server") && cmd.includes("--csrf_token")) {
        lsPid = pid;
        lsCmd = cmd;
        break;
      }
      pid = ppid;
    }

    if (!lsPid) {
      cachedAgyHost = { at: now, info: null };
      return null;
    }

    const csrfToken = extractCliFlagValue(lsCmd, "--csrf_token");
    if (!csrfToken) {
      cachedAgyHost = { at: now, info: null };
      return null;
    }

    const appDataDir = extractCliFlagValue(lsCmd, "--app_data_dir") || "antigravity";

    const lsof = spawnSync("lsof", ["-Pan", "-p", String(lsPid)], { encoding: "utf8", timeout: 1500 });
    const { ports, openConversations } =
      lsof.status === 0 && lsof.stdout
        ? parseAntigravityLsofOutput(lsof.stdout, appDataDir)
        : { ports: [], openConversations: [] };

    const info: AntigravityHostInfo = { lsPid, csrfToken, ports, openConversations };
    cachedAgyHost = { at: now, info };
    return info;
  } catch {
    cachedAgyHost = { at: now, info: null };
    return null;
  }
}

/**
 * Identify which Antigravity conversation (`<conversationId>`) just invoked an MCP tool.
 * Immediately before invoking any MCP tool, Antigravity's `language_server` appends a
 * `PLANNER_RESPONSE` JSONL entry containing the tool call (`call_mcp_tool` or
 * `mcp_agentschat_<tool>`) to `<brainDir>/<cid>/.system_generated/logs/transcript.jsonl`.
 */
export function detectAntigravityCallerSession(opts?: {
  toolName?: string;
  args?: Record<string, unknown> | null;
  brainDir?: string;
  openConversations?: string[];
  nowMs?: number;
  maxAgeMs?: number;
}): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const brainDir =
    opts?.brainDir?.trim() ||
    process.env.AGENTSCHAT_AGY_BRAIN_DIR?.trim() ||
    join(home, ".gemini", "antigravity", "brain");
  const brainStat = safeLstat(brainDir);
  if (!brainStat || brainStat.isSymbolicLink() || !brainStat.isDirectory() || !isSafeDirOrMissing(brainDir)) return null;

  const nowMs = opts?.nowMs ?? Date.now();
  const maxAgeMs = opts?.maxAgeMs ?? 30_000;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const candidateSet = new Set<string>();
  for (const cid of opts?.openConversations ?? []) {
    if (uuidRe.test(cid)) candidateSet.add(cid);
  }
  try {
    for (const entry of readdirSync(brainDir)) {
      if (uuidRe.test(entry)) candidateSet.add(entry);
    }
  } catch {}
  if (candidateSet.size === 0) return null;

  const toolName = opts?.toolName?.trim() || "";
  const argStrings: string[] = [];
  if (opts?.args && typeof opts.args === "object") {
    for (const val of Object.values(opts.args)) {
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (trimmed.length >= 2 && trimmed.length <= 200) {
          argStrings.push(trimmed);
        }
      }
    }
  }

  let bestCid: string | null = null;
  let bestScore = -1;
  let bestMtime = -1;
  const recentCids: { cid: string; mtimeMs: number }[] = [];

  for (const cid of candidateSet) {
    const cidDir = join(brainDir, cid);
    const sysDir = join(cidDir, ".system_generated");
    const logsDir = join(sysDir, "logs");
    if (
      !isSafeDirOrMissing(cidDir) ||
      !isSafeDirOrMissing(sysDir) ||
      !isSafeDirOrMissing(logsDir)
    ) {
      continue;
    }
    const transcriptPath = join(logsDir, "transcript.jsonl");
    const st = safeLstat(transcriptPath);
    if (!st || st.isSymbolicLink() || !st.isFile() || st.size <= 0 || nowMs - st.mtimeMs > maxAgeMs) continue;
    recentCids.push({ cid, mtimeMs: st.mtimeMs });

    let tail = "";
    let fd: number | null = null;
    try {
      fd = openSync(transcriptPath, "r");
      const readLen = Math.min(st.size, 16_384);
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, st.size - readLen);
      tail = buf.toString("utf8", 0, bytesRead);
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }

    const lines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
      const line = lines[i]!;
      if (!line.includes('"PLANNER_RESPONSE"')) continue;
      let score = 0;
      if (toolName) {
        const hasToolMatch =
          line.includes(`"mcp_agentschat_${toolName}"`) ||
          line.includes(`\\"ToolName\\":\\"${toolName}\\"`) ||
          line.includes(`"ToolName":"\\"${toolName}\\""`) ||
          line.includes(`"ToolName":"${toolName}"`) ||
          line.includes(`"name":"${toolName}"`) ||
          line.includes(`\\"tool_name\\":\\"${toolName}\\"`) ||
          line.includes(`"tool_name":"${toolName}"`);
        if (!hasToolMatch) continue;
        score += 1000;
      } else {
        score += 100;
      }
      if (i === lines.length - 1) score += 50;
      for (const s of argStrings) {
        if (line.includes(s)) score += 200;
      }
      if (score > bestScore || (score === bestScore && st.mtimeMs > bestMtime)) {
        bestScore = score;
        bestMtime = st.mtimeMs;
        bestCid = cid;
      }
      break;
    }
  }

  if (bestCid) return bestCid;
  if (recentCids.length === 1 && nowMs - recentCids[0]!.mtimeMs <= 5_000) {
    return recentCids[0]!.cid;
  }
  return null;
}

let cachedIsDshHost: { at: number; value: boolean } | null = null;

function matchesDshCommandLine(cmd: string): boolean {
  return (
    cmd.includes("@deepseek-ai") ||
    cmd.includes("/.dsh/") ||
    cmd.toLowerCase().includes("\\.dsh\\") ||
    /\bdsh(?:\.cmd|\.exe)?\b/i.test(cmd)
  );
}

/** Check if this MCP server was spawned by DeepSeek Harness (`dsh`). */
export function isDshHostProcess(opts?: {
  currentPid?: number;
  env?: Record<string, string | undefined>;
  cacheMs?: number;
}): boolean {
  const env = opts?.env ?? process.env;
  if (
    env.AGENTSCHAT_DSH_HOME?.trim() ||
    env.DSH_HOME?.trim() ||
    env.AGENTSCHAT_DSH_HEALTH_URL?.trim()
  ) {
    return true;
  }
  const now = Date.now();
  const cacheMs =
    typeof opts?.cacheMs === "number" && Number.isFinite(opts.cacheMs) && opts.cacheMs >= 0
      ? opts.cacheMs
      : 15_000;
  if (cachedIsDshHost && now < cachedIsDshHost.at) cachedIsDshHost = null;
  if (cachedIsDshHost && now - cachedIsDshHost.at < cacheMs) return cachedIsDshHost.value;
  try {
    let pid = opts?.currentPid ?? process.pid;
    if (process.platform === "win32") {
      const psOut = runWindowsPowerShell(
        [
          "$ErrorActionPreference = 'SilentlyContinue'",
          `$p = ${Math.trunc(pid)}`,
          "for ($h = 0; $h -lt 8 -and $p -gt 0; $h++) {",
          "  $proc = Get-CimInstance Win32_Process -Filter \"ProcessId=$p\"",
          "  if (-not $proc) { break }",
          "  Write-Output \"$($proc.ParentProcessId)`t$($proc.CommandLine)\"",
          "  $nextP = [int]$proc.ParentProcessId",
          "  if ($nextP -le 0 -or $nextP -eq $p) { break }",
          "  $p = $nextP",
          "}",
        ].join("; "),
        2500,
      );
      if (psOut) {
        const lines = psOut.split(/\r?\n/).filter(Boolean);
        for (let hop = 0; hop < lines.length; hop++) {
          const tab = lines[hop]!.indexOf("\t");
          const cmd = tab >= 0 ? lines[hop]!.slice(tab + 1) : lines[hop]!;
          if (hop > 0 && (/bun(?:\.exe)?\s+test/i.test(cmd) || /node(?:\.exe)?\s+--test/i.test(cmd))) break;
          if (matchesDshCommandLine(cmd)) {
            cachedIsDshHost = { at: now, value: true };
            return true;
          }
        }
      }
      cachedIsDshHost = { at: now, value: false };
      return false;
    }
    for (let hop = 0; hop < 4 && pid > 1; hop++) {
      const ps = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], {
        encoding: "utf8",
        timeout: 1000,
      });
      if (ps.status !== 0 || !ps.stdout) break;
      const line = ps.stdout.trim().split(/\r?\n/)[0]?.trim() || "";
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      const ppid = Number(m[1]);
      const cmd = m[2]!;
      if (hop > 0 && (cmd.includes("bun test") || cmd.includes("node --test"))) break;
      if (matchesDshCommandLine(cmd)) {
        cachedIsDshHost = { at: now, value: true };
        return true;
      }
      pid = ppid;
    }
  } catch {}
  cachedIsDshHost = { at: now, value: false };
  return false;
}

const SAFE_DSH_SESSION_ID_RE = /^session-[a-zA-Z0-9_-]{1,128}$/;
const DSH_HEALTH_MAX_BYTES = 256 * 1024;

function isSafeDirEntryName(entry: string): boolean {
  return (
    entry.length > 0 &&
    entry.length <= 255 &&
    entry !== "." &&
    entry !== ".." &&
    !entry.includes("/") &&
    !entry.includes("\\") &&
    !CONTROL_CHAR_RE.test(entry)
  );
}

function isLoopbackDshHealthUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl !== rawUrl.trim() || CONTROL_CHAR_RE.test(rawUrl)) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password || u.search || u.hash) return false;
  const host = u.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
    return false;
  }
  if (/:0+(?:\/|$)/.test(rawUrl)) return false;
  if (u.port) {
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

async function readBoundedDshHealthJson(res: Response): Promise<unknown> {
  const rawLen = res.headers?.get?.("content-length");
  if (rawLen !== null && rawLen !== undefined && rawLen.trim() !== "") {
    const trimmedLen = rawLen.trim();
    if (!/^\d+$/.test(trimmedLen) || Number(trimmedLen) > DSH_HEALTH_MAX_BYTES) {
      await res.body?.cancel?.().catch(() => {});
      throw new Error("DSH /health response exceeded byte cap");
    }
  }
  const reader = (res as any)?.body?.getReader?.();
  let parsed: unknown;
  if (!reader) {
    const text =
      typeof (res as any)?.text === "function"
        ? await res.text()
        : JSON.stringify(await res.json());
    if (Buffer.byteLength(text, "utf8") > DSH_HEALTH_MAX_BYTES) {
      throw new Error("DSH /health response exceeded byte cap");
    }
    parsed = JSON.parse(text);
  } else {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value instanceof Uint8Array) {
          total += value.byteLength;
          if (total > DSH_HEALTH_MAX_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error("DSH /health response exceeded byte cap");
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {}
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    parsed = JSON.parse(Buffer.from(merged).toString("utf8"));
  }
  if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
    throw new Error("Invalid DSH /health JSON object");
  }
  return parsed;
}

/** mtime of a session directory's log, or 0 when it has none. */
function sessionDirMtime(dir: string): number {
  const dirStat = safeLstat(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 0;
  let newest = 0;
  for (const file of ["session.v4.jsonl.zstd", "session.v4.jsonl"]) {
    const st = safeLstat(join(dir, file));
    if (st && !st.isSymbolicLink() && st.isFile() && st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

/**
 * mtime of `sid`'s session log (`<dshHome>/sessions/<project>/<sid>/…`), or 0.
 *
 * DSH rewrites the log on every durable row, so during a tool call the caller's
 * log is the most recently modified one — the only signal that distinguishes
 * two sessions that are both `running` at the same time.
 */
function sessionLogMtime(dshHome: string, sid: string): number {
  if (!SAFE_DSH_SESSION_ID_RE.test(sid)) return 0;
  const sessionsRoot = join(dshHome, "sessions");
  const rootStat = safeLstat(sessionsRoot);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
  let projects: string[];
  try {
    projects = readdirSync(sessionsRoot);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const project of projects) {
    if (!isSafeDirEntryName(project)) continue;
    const projDir = join(sessionsRoot, project);
    const projStat = safeLstat(projDir);
    if (!projStat || projStat.isSymbolicLink() || !projStat.isDirectory()) continue;
    const mtime = sessionDirMtime(join(projDir, sid));
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** Newest session log within `maxAgeMs`; the fallback when `/health` is unavailable. */
function newestSessionLog(dshHome: string, nowMs: number, maxAgeMs: number): string | null {
  const root = join(dshHome, "sessions");
  const rootStat = safeLstat(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return null;
  }
  let best: { sid: string; mtime: number } | null = null;
  for (const project of projects) {
    if (!isSafeDirEntryName(project)) continue;
    const projDir = join(root, project);
    const projStat = safeLstat(projDir);
    if (!projStat || projStat.isSymbolicLink() || !projStat.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!SAFE_DSH_SESSION_ID_RE.test(entry)) continue;
      const mtime = sessionDirMtime(join(projDir, entry));
      if (mtime === 0 || nowMs - mtime > maxAgeMs) continue;
      if (best === null || mtime > best.mtime) best = { sid: entry, mtime };
    }
  }
  return best?.sid ?? null;
}

/**
 * Identify the active DeepSeek Harness (`dsh`) session (`session-...`) during a tool call.
 *
 * Primary signal: the local DSH inbound plugin's `/health`, whose `roots[].status`
 * names the session(s) currently mid-turn. Secondary (and the only signal when
 * that plugin is absent): the most recently written session log under
 * `<dshHome>/sessions/`. When several sessions are running, the log mtime decides;
 * otherwise the newest root wins — never the oldest.
 */
export async function detectDshCallerSession(opts?: {
  dshHome?: string;
  healthUrl?: string;
  env?: Record<string, string | undefined>;
  nowMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const env = opts?.env ?? process.env;
  if (!opts?.dshHome && !opts?.healthUrl && !isDshHostProcess({ env })) {
    return null;
  }
  const dshHome =
    opts?.dshHome?.trim() ||
    env.AGENTSCHAT_DSH_HOME?.trim() ||
    env.DSH_HOME?.trim() ||
    join(homedir(), ".dsh");
  const healthUrl =
    opts?.healthUrl?.trim() ||
    env.AGENTSCHAT_DSH_HEALTH_URL?.trim() ||
    "http://127.0.0.1:8799/health";
  const nowMs = opts?.nowMs ?? Date.now();

  if (isLoopbackDshHealthUrl(healthUrl)) {
    try {
      const f = opts?.fetchImpl ?? fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 150);
      timer.unref?.();
      try {
        const res = await f(healthUrl, { signal: ctrl.signal, redirect: "error" });
        if (res.ok) {
          const data = (await readBoundedDshHealthJson(res)) as {
            roots?: Array<{ id?: string; status?: string }>;
          };
          const roots = Array.isArray(data?.roots) ? data.roots : [];
          const running = roots
            .filter((r) => typeof r?.id === "string" && SAFE_DSH_SESSION_ID_RE.test(r.id) && r.status === "running")
            .map((r) => r.id!);
          if (running.length === 1) return running[0]!;
          if (running.length > 1) {
            // More than one session is mid-turn; the caller is the one that just
            // wrote a row (its session log mtime is the newest). `roots` is
            // oldest-first, so the newest root is the fallback when logs are
            // unavailable — never `running[0]`, which is the *oldest*.
            const ranked = running
              .map((sid) => ({ sid, mtime: sessionLogMtime(dshHome, sid) }))
              .sort((a, b) => b.mtime - a.mtime);
            if (ranked[0]!.mtime > 0 && ranked[0]!.mtime >= ranked[1]!.mtime) return ranked[0]!.sid;
            return running[running.length - 1]!;
          }
          const allValid = roots
            .filter((r) => typeof r?.id === "string" && SAFE_DSH_SESSION_ID_RE.test(r.id))
            .map((r) => r.id!);
          if (allValid.length === 1) return allValid[0]!;
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {}
  }

  // No health endpoint (older/newer DSH, or the inbound plugin is not
  // installed): the same log-mtime signal still identifies the session that
  // just ran a tool call. DSH writes one directory per session under
  // `<dshHome>/sessions/<project>/session-<uuid>/`.
  const homeStat = safeLstat(dshHome);
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory() || !isSafeDirOrMissing(dshHome)) return null;
  const newestByLog = newestSessionLog(dshHome, nowMs, 30_000);
  if (newestByLog) return newestByLog;
  return null;
}
