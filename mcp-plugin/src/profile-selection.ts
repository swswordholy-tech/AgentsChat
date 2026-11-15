import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export interface ProjectProfileSelection {
  selector: string;
  source: "project-config" | "project-profile";
  agentId?: string;
  apiUrl?: string;
  wsUrl?: string;
}

const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;
const MAX_PROJECT_PROFILE_BYTES = 1_048_576;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "oauth_token",
  "api_token",
  "key",
  "api_key",
  "agent_key",
  "private_key",
  "secret",
  "client_secret",
  "webhook_secret",
  "password",
  "authorization",
  "bearer",
  "cookie",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED_SIDECAR_STEMS = new Set([
  "grok-binds",
  "session-binds",
  "agy-binds",
  "cursor",
  "read-cursors",
  "wake-pids",
  "config",
  "codex-bots",
]);

function safeLstat(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function isAllowedDarwinSystemLink(dirPath: string): boolean {
  if (process.platform !== "darwin") return false;
  if (dirPath !== "/var" && dirPath !== "/tmp" && dirPath !== "/etc") return false;
  try {
    return readlinkSync(dirPath) === `private${dirPath}`;
  } catch {
    return false;
  }
}

function hasSafeDirChain(dirPath: string): boolean {
  const abs = resolve(dirPath);
  const root = parse(abs).root;
  const rel = abs.slice(root.length);
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i]!);
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch (err: any) {
      if (err && err.code === "ENOENT") return true;
      return false;
    }
    if (st.isSymbolicLink()) {
      if (isAllowedDarwinSystemLink(cur)) continue;
      return false;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

function isUnsafeMetadataOrLinkLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    lower === "metadata.google.internal" ||
    lower === "metadata" ||
    lower === "metadata.goog" ||
    lower.endsWith(".metadata.goog") ||
    lower === "instance-data"
  ) {
    return true;
  }
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    const tailParts = tail.startsWith("0:") ? tail.slice(2) : tail;
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(tailParts)) return true;
    const hexMatch = tailParts.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      if (((hi >> 8) & 0xff) === 169 && (hi & 0xff) === 254) return true;
    }
  }
  return false;
}

function isSafeProjectAgentId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    id !== "." &&
    id !== ".." &&
    !/[\/\\\s\x00-\x1f\x7f]/.test(id) &&
    !PROTOTYPE_KEYS.has(id.toLowerCase())
  );
}

/** Read only this project's binding. Never scan parents or choose a sibling bot. */
export function projectProfileSelector(cwd: string): ProjectProfileSelection | undefined {
  const resolvedCwd = resolve(cwd);
  const projectDir = join(resolvedCwd, ".agentschat");
  const dirStat = safeLstat(projectDir);
  if (!dirStat) return undefined;
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !hasSafeDirChain(projectDir)) {
    throw new Error("Refusing symlinked or non-directory project .agentschat");
  }

  const config = join(projectDir, "config.json");
  let doc: any = {};
  const configStat = safeLstat(config);
  if (configStat) {
    if (configStat.isSymbolicLink() || !configStat.isFile() || configStat.size > MAX_PROJECT_CONFIG_BYTES) {
      throw new Error("Invalid project .agentschat/config.json; repair it before choosing an identity");
    }
    let raw: string;
    try {
      raw = readFileSync(config, "utf8");
      doc = JSON.parse(raw);
    } catch {
      throw new Error("Invalid project .agentschat/config.json; repair it before choosing an identity");
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Invalid project identity configuration");
    if (
      Object.prototype.hasOwnProperty.call(doc, "__proto__") ||
      Object.keys(doc).some((k) => PROTOTYPE_KEYS.has(k.toLowerCase()) || FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase()))
    ) {
      throw new Error("Credentials must not be stored in project .agentschat/config.json");
    }
    for (const field of ["profile", "agent_id", "api_url", "ws_url"]) {
      if (doc[field] !== undefined && (typeof doc[field] !== "string" || !doc[field].trim() || /[\x00-\x1f\x7f]/.test(doc[field]))) {
        throw new Error(`Invalid project ${field}`);
      }
    }
    if (doc.agent_id !== undefined && !isSafeProjectAgentId((doc.agent_id as string).trim())) {
      throw new Error("Invalid project agent_id");
    }
    for (const [field, protocols] of [["api_url", ["https:", "http:"]], ["ws_url", ["wss:", "ws:"]]] as const) {
      if (doc[field] === undefined) continue;
      let url: URL;
      try { url = new URL((doc[field] as string).trim()); } catch { throw new Error(`Invalid project ${field}`); }
      const portBad = url.port !== "" && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535);
      if (
        portBad ||
        !(protocols as readonly string[]).includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        isUnsafeMetadataOrLinkLocalHost(url.hostname) ||
        (!url.protocol.endsWith("s:") && !isLoopbackHost(url.hostname))
      ) {
        throw new Error(`Invalid project ${field}: require TLS (except loopback), safe host, and no credentials/query`);
      }
    }
  }
  const settings = {
    ...(doc.agent_id !== undefined ? { agentId: (doc.agent_id as string).trim() } : {}),
    ...(doc.api_url !== undefined ? { apiUrl: (doc.api_url as string).trim() } : {}),
    ...(doc.ws_url !== undefined ? { wsUrl: (doc.ws_url as string).trim() } : {}),
  };
  if (doc.profile !== undefined) {
    const value = (doc.profile as string).trim();
    const stemLower = value.replace(/\.json$/i, "").toLowerCase();
    if (
      value === "." ||
      value === ".." ||
      PROTOTYPE_KEYS.has(stemLower) ||
      (!value.includes("/") && !value.includes("\\") && RESERVED_SIDECAR_STEMS.has(stemLower))
    ) {
      throw new Error("Invalid project profile");
    }
    if (value.startsWith("~/") || value.startsWith("~\\")) {
      const homeBase = resolve(homedir());
      const resolvedHomeTarget = resolve(homeBase, value.slice(2));
      const relHome = relative(homeBase, resolvedHomeTarget);
      if (!relHome || relHome.startsWith("..") || isAbsolute(relHome) || !hasSafeDirChain(dirname(resolvedHomeTarget))) {
        throw new Error("Invalid project profile: home-relative path traversal");
      }
      return { selector: value, source: "project-config", ...settings };
    }
    if (!isAbsolute(value) && (value.includes("/") || value.includes("\\"))) {
      const resolvedTarget = resolve(resolvedCwd, value);
      const rel = relative(resolvedCwd, resolvedTarget);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !hasSafeDirChain(dirname(resolvedTarget))) {
        throw new Error("Invalid project profile: relative path must stay within project directory");
      }
      return { selector: resolvedTarget, source: "project-config", ...settings };
    }
    if (isAbsolute(value) && !hasSafeDirChain(dirname(value))) {
      throw new Error("Invalid project profile: symlinked parent directory");
    }
    return { selector: value, source: "project-config", ...settings };
  }
  const profile = join(projectDir, "profile.json");
  const profileStat = safeLstat(profile);
  if (profileStat) {
    if (profileStat.isSymbolicLink() || !profileStat.isFile() || profileStat.size > MAX_PROJECT_PROFILE_BYTES) {
      throw new Error("Refusing symlinked or non-regular project .agentschat/profile.json");
    }
    return { selector: profile, source: "project-profile", ...settings };
  }
  // A declared agent/server scope must never silently disappear into a global identity.
  if (Object.keys(settings).length) throw new Error("Project identity/server settings require a profile binding");
}
