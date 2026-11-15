/**
 * Persistence of the per-agent read cursor (`last-seen-msg-ts-<agent>.json`).
 *
 * This is a state change, not best-effort teardown — it just happens to be *called*
 * from teardown. Losing it silently means the next start reads a stale last-seen value
 * and either replays messages or, worse, SKIPS them (the cursor-gap class).
 *
 * Two defects this module exists to prevent:
 *  - The old writer swallowed its write error in a bare `catch {}` and returned normally,
 *    so callers could not tell a failed flush from a successful one.
 *  - The old flush cleared the dirty flag BEFORE writing. A failed write therefore both
 *    discarded the cursor and disabled its own retry: the shutdown fallback flush sees
 *    `dirty === false` and returns immediately. One failure = permanent silent loss.
 *
 * So: the write reports success, and the dirty flag is cleared ONLY once it lands.
 */
import { randomBytes } from "crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
   type Stats,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "path";
import { redactSecrets } from "./redact.ts";

export type Warn = (message: string) => void;

export interface PersistCursorFsOps {
  renameSync?: (oldPath: string, newPath: string) => void;
  copyFileSync?: (src: string, dest: string) => void;
}

const MAX_CURSOR_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_ENTRIES = 50_000;
const RESERVED_PROTO_KEY = /^(?:__proto__|constructor|prototype)$/i;
let tmpCounter = 0;

function scrubDiag(value: unknown): string {
  return redactSecrets(String(value ?? ""))
    .replace(/\b(https?:\/\/)([^/\s@]*@)/gi, "$1[REDACTED]@")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>\\]+/gi, "[REDACTED]")
    .replace(
      /(?:ac_|mcp_at_|mcp_rt_|mcp_|agent_key_|sk-|rk_live_|rk_test_|whsec_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|mr_|AIza|AKIA|ASIA)[A-Za-z0-9+/=._-]{8,}/g,
      "[REDACTED]",
    )
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

function isDarwinCanonicalRootLink(dir: string, st: Stats): boolean {
  if (
    process.platform !== "darwin" ||
    (dir !== "/var" && dir !== "/tmp" && dir !== "/etc") ||
    !st.isSymbolicLink()
  ) {
    return false;
  }
  try {
    return (
      realpathSync(dir) === `/private${dir}` &&
      !lstatSync("/private").isSymbolicLink() &&
      lstatSync("/private").isDirectory() &&
      !lstatSync(`/private${dir}`).isSymbolicLink() &&
      lstatSync(`/private${dir}`).isDirectory()
    );
  } catch {
    return false;
  }
}

function hasSafeRawDotDotAncestors(rawDirPath: string): boolean {
  const absRaw = isAbsolute(rawDirPath) ? rawDirPath : `${process.cwd()}${sep}${rawDirPath}`;
  const root = parse(absRaw).root;
  const segments = absRaw.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (!segments.includes("..")) return true;
  let cur = root;
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    try {
      const st = lstatSync(next);
      if (st.isSymbolicLink() && !isDarwinCanonicalRootLink(next, st)) {
        return false;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    }
    cur = next;
  }
  return true;
}

function hasSafeAncestorDirs(targetFile: string): boolean {
  if (typeof targetFile !== "string" || !targetFile || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(targetFile)) {
    return false;
  }
  const rawParent = dirname(isAbsolute(targetFile) ? targetFile : `${process.cwd()}${sep}${targetFile}`);
  if (!hasSafeRawDotDotAncestors(rawParent)) {
    return false;
  }
  let dir = resolve(rawParent);
  while (true) {
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return false;
    }
    const isDarwinRootLink = isDarwinCanonicalRootLink(dir, st);
    if (!isDarwinRootLink && (st.isSymbolicLink() || !st.isDirectory())) {
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return true;
}

/**
 * Sanitize an agent_id into a cross-platform safe filename slug (no `/`, `\`, `..`,
 * or Windows NTFS invalid chars like `:`), while keeping standard `[A-Za-z0-9._-]+`
 * agent IDs 100% unchanged so existing cursor files continue to match.
 */
export function safeAgentCursorSlug(agentId: string): string {
  const cleaned = String(agentId || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 128);
  if (!cleaned || cleaned === "." || cleaned === ".." || RESERVED_PROTO_KEY.test(cleaned)) return "_";
  return cleaned;
}

export function cursorFileForAgent(configDir: string, agentId: string): string {
  return join(configDir, `last-seen-msg-ts-${safeAgentCursorSlug(agentId)}.json`);
}

/**
 * Read a persisted channel→timestamp map.
 *
 * A missing file is the normal first-run case and stays quiet. Anything else — corrupt
 * JSON, non-object JSON, non-string values, bad permissions — means we are resetting state
 * we were supposed to remember, and this runs ONCE at startup: warn loudly.
 */
export function loadCursor(file: string, warn: Warn): Map<string, string> {
  try {
    if (!hasSafeAncestorDirs(file)) {
      let exists = false;
      try {
        lstatSync(file);
        exists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") exists = true;
      }
      if (!exists) return new Map();
      throw new Error("cursor parent path must be a real directory");
    }
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("cursor path must be a regular file");
    }
    if (st.size > MAX_CURSOR_BYTES) {
      throw new Error(`cursor file exceeds ${MAX_CURSOR_BYTES} byte limit`);
    }
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor root must be a JSON object");
    }
    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (RESERVED_PROTO_KEY.test(k)) continue;
      if (typeof v !== "string") {
        throw new Error(`cursor value for ${scrubDiag(k)} must be a string`);
      }
      if (!k || k.length > 256 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(k) || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v) || v.length > 256) {
        throw new Error(`cursor entry for ${scrubDiag(k)} contains invalid characters or length`);
      }
      if (entries.length >= MAX_CURSOR_ENTRIES) {
        throw new Error(`cursor entry count exceeds ${MAX_CURSOR_ENTRIES}`);
      }
      entries.push([k, v]);
    }
    return new Map(entries);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: could not read ${scrubDiag(file)} — resetting that state: ${scrubDiag(e)}\n`);
    }
    return new Map();
  }
}

/** Write the cursor to disk atomically (0600 tmp + rename, with Windows NTFS EPERM/EACCES fallback). Returns true iff it actually landed. Never throws. */
export function persistCursor(
  file: string,
  cursor: Map<string, string>,
  warn: Warn,
  fsOps?: PersistCursorFsOps,
): boolean {
  try {
    const parentStat = lstatSync(dirname(file));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || !hasSafeAncestorDirs(file)) {
      warn(`[agentchat] WARNING: failed to persist read cursor to ${scrubDiag(file)}: parent is not a real directory\n`);
      return false;
    }
  } catch (e) {
    warn(`[agentchat] WARNING: failed to persist read cursor to ${scrubDiag(file)}: ${scrubDiag(e)}\n`);
    return false;
  }
  try {
    const existing = lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      warn(`[agentchat] WARNING: failed to persist read cursor to ${scrubDiag(file)}: target is not a regular file\n`);
      return false;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: failed to persist read cursor to ${scrubDiag(file)}: ${scrubDiag(e)}\n`);
      return false;
    }
  }
  const validEntries: Array<[string, string]> = [];
  for (const [k, v] of cursor) {
    if (!k || k.length > 256 || RESERVED_PROTO_KEY.test(k) || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(k) || typeof v !== "string" || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(v) || v.length > 256) {
      continue;
    }
    validEntries.push([k, v]);
  }
  const boundedEntries =
    validEntries.length > MAX_CURSOR_ENTRIES
      ? validEntries.slice(validEntries.length - MAX_CURSOR_ENTRIES)
      : validEntries;
  const payloadObj: Record<string, string> = Object.create(null);
  for (const [k, v] of boundedEntries) {
    payloadObj[k] = v;
  }
  const renameFn = fsOps?.renameSync ?? renameSync;
  const copyFn = fsOps?.copyFileSync ?? copyFileSync;
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpCounter}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payloadObj), { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      chmodSync(tmp, 0o600);
    }
    if (!hasSafeAncestorDirs(file)) {
      throw new Error("parent is not a real directory");
    }
    const current = lstatSync(file, { throwIfNoEntry: false });
    if (current && (current.isSymbolicLink() || !current.isFile())) {
      throw new Error("target was replaced by a symlink or non-file");
    }
    try {
      renameFn(tmp, file);
    } catch (renameErr) {
      const code = (renameErr as NodeJS.ErrnoException)?.code;
      if (code === "EPERM" || code === "EACCES") {
        if (!hasSafeAncestorDirs(file)) {
          throw new Error("parent is not a real directory");
        }
        const recheck = lstatSync(file, { throwIfNoEntry: false });
        if (recheck && (recheck.isSymbolicLink() || !recheck.isFile())) {
          throw new Error("target was replaced by a symlink or non-file");
        }
        copyFn(tmp, file);
        if (process.platform !== "win32") {
          chmodSync(file, 0o600);
        }
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore cleanup error */
        }
        return true;
      }
      throw renameErr;
    }
    return true;
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup error */
    }
    warn(`[agentchat] WARNING: failed to persist read cursor to ${scrubDiag(file)}: ${scrubDiag(e)}\n`);
    return false;
  }
}

/**
 * Flush state machine. Clears `dirty` only after `persist()` reports success, so a
 * failed write stays dirty and the next flush (including the shutdown fallback) retries.
 * Returns true iff the cursor was persisted.
 */
export function flushCursor(state: { dirty: boolean }, persist: () => boolean): boolean {
  if (!state.dirty) return false;
  const ok = persist();
  if (ok) state.dirty = false;
  return ok;
}
