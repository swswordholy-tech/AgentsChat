/**
 * Atomic, permission-safe write of the agent profile.
 *
 * Extracted from the side-effecting server entrypoint so it can be unit-tested: the
 * property that matters here (the key is never world-readable, even mid-write) is only
 * observable if you can call this directly and interrupt it.
 *
 * The profile holds a live agent key, so 0600 is a security control. Two traps:
 *  - `writeFileSync`'s `mode` applies ONLY when the file is created. A .tmp left behind by
 *    an earlier crash keeps its own permissions, and `renameSync` preserves the source's
 *    mode — so a stale 0644 .tmp yields a 0644 profile. Unlinking it first makes 0600 true
 *    *by construction*: the key is never on disk world-readable, not even in the window
 *    between rename and chmod.
 *  - `chmodSync` used to be the sole enforcement point, and its failure was swallowed by a
 *    bare `catch {}` — the key could sit world-readable with nothing said. Never swallow
 *    it, and verify the result instead of assuming it took.
 */
import {
  lstatSync,
  realpathSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  chmodSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "fs";
import { dirname, join, resolve } from "path";
import { redactSecrets } from "./redact.ts";

/** Where diagnostics go. Injectable so tests can assert on them. */
export type Warn = (message: string) => void;

const defaultWarn: Warn = (m) => process.stderr.write(m);
const MAX_PROFILE_JSON_BYTES = 64 * 1024;
const MAX_PROFILE_PATH_LEN = 4096;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const CONTROL_CHAR_GLOBAL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const WINDOWS_DEVICE_STEM_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const RESERVED_PROTO_STEMS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype).map((k) => k.toLowerCase()),
]);
const DARWIN_SYSTEM_SYMLINKS = new Set(["/var", "/tmp", "/etc"]);

function sanitizeWarnPart(value: unknown): string {
  return redactSecrets(String(value ?? ""))
    .replace(/\b(https?:\/\/?)([^/\s@]*@)/gi, "$1[REDACTED]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]")
    .replace(
      /(?:ac_|mcp_at_|mcp_rt_|mcp_|agent_key_|sk-|whsec_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|mr_|AIza|(?:AKIA|ASIA))[A-Za-z0-9_+/=.-]{8,}/g,
      "[REDACTED]",
    )
    .replace(CONTROL_CHAR_GLOBAL_RE, "?");
}

function safeLstat(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function isAllowedDarwinSystemSymlink(dirPath: string): boolean {
  if (process.platform !== "darwin" || !DARWIN_SYSTEM_SYMLINKS.has(dirPath)) return false;
  try {
    const resolved = realpathSync(dirPath);
    if (resolved !== `/private${dirPath}`) return false;
    const privSt = lstatSync("/private");
    if (!privSt.isDirectory() || privSt.isSymbolicLink()) return false;
    const realSt = lstatSync(resolved);
    return realSt.isDirectory() && !realSt.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasSafeRawDotDotAncestors(targetPath: string): boolean {
  if (!targetPath.includes("..")) return true;
  const rawParent = dirname(targetPath);
  const parts = rawParent.split(/[\\/]+/);
  let acc = rawParent.startsWith("/") ? "/" : /^[A-Za-z]:/.test(rawParent) ? parts[0] + "\\" : process.cwd();
  const startIdx = rawParent.startsWith("/") ? 1 : /^[A-Za-z]:/.test(rawParent) ? 1 : 0;
  for (let i = startIdx; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg || seg === ".") continue;
    acc = seg === ".." ? dirname(acc) : join(acc, seg);
    const st = safeLstat(acc);
    if (st) {
      if (st.isSymbolicLink()) {
        if (!isAllowedDarwinSystemSymlink(acc)) return false;
      } else if (!st.isDirectory()) {
        return false;
      }
    }
  }
  return true;
}

function hasSafeAncestorDirs(targetPath: string): boolean {
  if (!hasSafeRawDotDotAncestors(targetPath)) return false;
  let cur = dirname(resolve(targetPath));
  for (let depth = 0; depth < 64; depth += 1) {
    const st = safeLstat(cur);
    if (st) {
      if (st.isSymbolicLink()) {
        if (!isAllowedDarwinSystemSymlink(cur)) return false;
      } else if (!st.isDirectory()) {
        return false;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return true;
}

export function safeWriteProfile(path: string, data: unknown, warn: Warn = defaultWarn): void {
  if (typeof path !== "string" || !path || path.length > MAX_PROFILE_PATH_LEN || path.includes("\x00")) {
    throw new Error(`Refusing to write profile into invalid path: ${sanitizeWarnPart(path)}`);
  }
  const parentDir = dirname(path);
  const parentStat = safeLstat(parentDir);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory() || !hasSafeAncestorDirs(path)) {
    throw new Error(`Refusing to write profile into invalid or symlinked parent directory: ${sanitizeWarnPart(parentDir)}`);
  }

  const pathStat = safeLstat(path);
  if (pathStat?.isSymbolicLink()) {
    throw new Error(`Refusing to write profile through symlink: ${sanitizeWarnPart(path)}`);
  }
  if (pathStat && !pathStat.isFile() && !pathStat.isDirectory()) {
    throw new Error(`Refusing to write profile into non-regular target: ${sanitizeWarnPart(path)}`);
  }

  const tmp = path + ".tmp";

  // Residue from an earlier crash (including dangling symlinks where existsSync is false!)
  // must be unlinked via lstatSync first so exclusive create (`wx`) always starts fresh at 0600.
  const tmpStat = safeLstat(tmp);
  if (tmpStat) {
    try {
      unlinkSync(tmp);
    } catch (e) {
      warn(`[agentchat] WARNING: stale ${sanitizeWarnPart(tmp)} could not be removed: ${sanitizeWarnPart(e)}\n`);
    }
  }

  // Created fresh with exclusive `wx` → refuses symlinks/races and guarantees mode 0600 from instant of creation.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });

  // Re-verify parent and target right before renameSync to narrow TOCTOU symlink swaps.
  const currentParent = safeLstat(parentDir);
  if (!currentParent || currentParent.isSymbolicLink() || !currentParent.isDirectory() || !hasSafeAncestorDirs(path)) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`Refusing to write profile into symlinked parent directory: ${sanitizeWarnPart(parentDir)}`);
  }
  if (safeLstat(path)?.isSymbolicLink()) {
    try { unlinkSync(tmp); } catch {}
    throw new Error(`Refusing to overwrite symlinked profile: ${sanitizeWarnPart(path)}`);
  }

  try {
    renameSync(tmp, path);
  } catch (err: any) {
    if (process.platform === "win32" && (err?.code === "EPERM" || err?.code === "EACCES")) {
      // On Windows NTFS, antivirus or search indexers can momentarily hold `path` open,
      // causing atomic MoveFileEx to return EPERM/EACCES. Fall back to copy+unlink when
      // `path` is not a symlink or directory.
      const winTarget = safeLstat(path);
      if (winTarget?.isSymbolicLink() || winTarget?.isDirectory()) {
        try { unlinkSync(tmp); } catch {}
        throw new Error(`Refusing to overwrite symlinked or directory profile: ${sanitizeWarnPart(path)}`);
      }
      copyFileSync(tmp, path);
      try {
        unlinkSync(tmp);
      } catch {}
    } else {
      throw err;
    }
  }

  // POSIX mode bits (0600) do not exist on Windows NTFS (`statSync().mode & 0o777` is always 0666);
  // Windows protects `%USERPROFILE%\.agentschat` via user-profile NTFS ACL inheritance instead.
  if (process.platform !== "win32") {
    const postStat = safeLstat(path);
    if (!postStat || postStat.isSymbolicLink() || !postStat.isFile()) {
      warn(`[agentchat] WARNING: could not verify permissions of ${sanitizeWarnPart(path)}: non-regular target\n`);
      return;
    }
    try {
      chmodSync(path, 0o600);
    } catch (e) {
      warn(`[agentchat] WARNING: could not chmod ${sanitizeWarnPart(path)} to 0600: ${sanitizeWarnPart(e)}\n`);
    }

    try {
      const verified = safeLstat(path);
      if (!verified || verified.isSymbolicLink() || !verified.isFile()) {
        warn(`[agentchat] WARNING: could not verify permissions of ${sanitizeWarnPart(path)}: non-regular target\n`);
        return;
      }
      const mode = verified.mode & 0o777;
      if (mode !== 0o600) {
        warn(
          `[agentchat] WARNING: ${sanitizeWarnPart(path)} is mode ${mode.toString(8)}, expected 600 — it holds your agent key. Fix: chmod 600 ${sanitizeWarnPart(path)}\n`,
        );
      }
    } catch (e) {
      warn(`[agentchat] WARNING: could not verify permissions of ${sanitizeWarnPart(path)}: ${sanitizeWarnPart(e)}\n`);
    }
  }
}

export interface DefaultProfileCollision {
  collidingName: string;
  collidingPath: string;
  reason: "agent_id" | "display_name";
}

const NON_PROFILE_JSON_FILES = new Set([
  "session-binds.json",
  "session-binds.meta.json",
  "session-binds-meta.json",
  "session-binds_meta.json",
  "agy-session-binds.json",
  "agy-session-binds.meta.json",
  "agy-session-binds_meta.json",
  "agy-binds.json",
  "agy-binds.meta.json",
  "agy-binds-meta.json",
  "agy-binds_meta.json",
  "grok-binds.json",
  "grok-binds-meta.json",
  "grok-binds.meta.json",
  "grok-binds_meta.json",
  "identity-guard.json",
  "cursor.json",
  "read-cursors.json",
  "mention-timestamps.json",
  "wake-pids.json",
  "codex-bots.json",
  "dsh.json",
  "config.json",
  "muse.json",
]);

/**
 * Enforce that `profile.json` never duplicates another named `<Name>.json` profile
 * (by `agent_id` or `display_name`). A duplicate `profile.json` creates an ambiguous
 * shadow alias that causes unconfigured/default boots to collide with a bound named
 * identity.
 */
export function findDefaultProfileCollision(
  configDir: string,
  defaultProfilePath: string,
): DefaultProfileCollision | null {
  if (!defaultProfilePath || !hasSafeAncestorDirs(defaultProfilePath)) return null;
  const defStat = safeLstat(defaultProfilePath);
  if (!defStat || defStat.isSymbolicLink() || !defStat.isFile() || defStat.size > MAX_PROFILE_JSON_BYTES) {
    return null;
  }
  let defParsed: { agent_id?: unknown; display_name?: unknown; token?: unknown };
  try {
    defParsed = JSON.parse(readFileSync(defaultProfilePath, "utf8"));
  } catch {
    return null;
  }
  if (
    !defParsed ||
    typeof defParsed !== "object" ||
    Array.isArray(defParsed) ||
    Object.prototype.hasOwnProperty.call(defParsed, "__proto__")
  ) {
    return null;
  }
  const defAgentId = typeof defParsed.agent_id === "string" ? defParsed.agent_id.trim() : "";
  const defDisplayName =
    typeof defParsed.display_name === "string" ? defParsed.display_name.trim().toLowerCase() : "";
  if (!defAgentId && !defDisplayName) return null;

  const cfgStat = safeLstat(configDir);
  if (!cfgStat || cfgStat.isSymbolicLink() || !cfgStat.isDirectory() || !hasSafeAncestorDirs(join(configDir, "probe"))) {
    return null;
  }

  const resolvedDefault = resolve(defaultProfilePath);
  for (const dir of [join(configDir, "profiles"), configDir]) {
    const dirStat = safeLstat(dir);
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /\.json$/i.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      if (NON_PROFILE_JSON_FILES.has(file.toLowerCase())) continue;
      const candidatePath = join(dir, file);
      if (resolve(candidatePath) === resolvedDefault) continue;
      const baseName = file.replace(/\.json$/i, "");
      const baseLower = baseName.toLowerCase();
      if (
        baseLower === "profile" ||
        RESERVED_PROTO_STEMS.has(baseLower) ||
        WINDOWS_DEVICE_STEM_RE.test(baseName)
      ) {
        continue;
      }

      const candStat = safeLstat(candidatePath);
      if (!candStat || candStat.isSymbolicLink() || !candStat.isFile() || candStat.size > MAX_PROFILE_JSON_BYTES) {
        continue;
      }
      let candidate: { agent_id?: unknown; display_name?: unknown; token?: unknown };
      try {
        candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
      } catch {
        continue;
      }
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.prototype.hasOwnProperty.call(candidate, "__proto__")
      ) {
        continue;
      }
      const candAgentId = typeof candidate.agent_id === "string" ? candidate.agent_id.trim() : "";
      const candToken = typeof candidate.token === "string" ? candidate.token.trim() : "";
      if (!candAgentId || !candToken || CONTROL_CHAR_RE.test(candAgentId) || RESERVED_PROTO_STEMS.has(candAgentId.toLowerCase())) {
        continue;
      }

      if (defAgentId && candAgentId === defAgentId) {
        return { collidingName: baseName, collidingPath: candidatePath, reason: "agent_id" };
      }
      const candDisplayName =
        typeof candidate.display_name === "string" ? candidate.display_name.trim().toLowerCase() : "";
      if (
        defDisplayName &&
        (candDisplayName === defDisplayName || baseName.toLowerCase() === defDisplayName)
      ) {
        return { collidingName: baseName, collidingPath: candidatePath, reason: "display_name" };
      }
    }
  }
  return null;
}
