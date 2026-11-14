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
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export type Warn = (message: string) => void;

const MAX_CURSOR_BYTES = 4 * 1024 * 1024;
let tmpCounter = 0;

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
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
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
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (typeof v !== "string") {
        throw new Error(`cursor value for ${k} must be a string`);
      }
      if (!k || /[\x00-\x1f\x7f]/.test(k) || /[\x00-\x1f\x7f]/.test(v) || v.length > 256) {
        throw new Error(`cursor entry for ${k} contains invalid characters or length`);
      }
      entries.push([k, v]);
    }
    return new Map(entries);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: could not read ${file} — resetting that state: ${e}\n`);
    }
    return new Map();
  }
}

/** Write the cursor to disk atomically (0600 tmp + rename). Returns true iff it actually landed. Never throws. */
export function persistCursor(file: string, cursor: Map<string, string>, warn: Warn): boolean {
  try {
    const existing = lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: target is not a regular file\n`);
      return false;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: ${e}\n`);
      return false;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${++tmpCounter}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cursor)), { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      chmodSync(tmp, 0o600);
    }
    renameSync(tmp, file);
    return true;
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup error */
    }
    warn(`[agentchat] WARNING: failed to persist read cursor to ${file}: ${e}\n`);
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
