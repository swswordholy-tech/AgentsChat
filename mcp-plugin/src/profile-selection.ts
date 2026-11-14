import { lstatSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectProfileSelection {
  selector: string;
  source: "project-config" | "project-profile";
  agentId?: string;
  apiUrl?: string;
  wsUrl?: string;
}

const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;
const FORBIDDEN_CREDENTIAL_KEYS = new Set(["token", "key", "api_key", "secret", "password", "authorization"]);

function safeLstat(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

/** Read only this project's binding. Never scan parents or choose a sibling bot. */
export function projectProfileSelector(cwd: string): ProjectProfileSelection | undefined {
  const resolvedCwd = resolve(cwd);
  const projectDir = join(resolvedCwd, ".agentschat");
  const dirStat = safeLstat(projectDir);
  if (!dirStat) return undefined;
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
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
    if (Object.prototype.hasOwnProperty.call(doc, "__proto__") || Object.keys(doc).some((k) => FORBIDDEN_CREDENTIAL_KEYS.has(k.toLowerCase()))) {
      throw new Error("Credentials must not be stored in project .agentschat/config.json");
    }
    for (const field of ["profile", "agent_id", "api_url", "ws_url"]) {
      if (doc[field] !== undefined && (typeof doc[field] !== "string" || !doc[field].trim() || /[\x00-\x1f\x7f]/.test(doc[field]))) {
        throw new Error(`Invalid project ${field}`);
      }
    }
    for (const [field, protocols] of [["api_url", ["https:", "http:"]], ["ws_url", ["wss:", "ws:"]]] as const) {
      if (doc[field] === undefined) continue;
      let url: URL;
      try { url = new URL((doc[field] as string).trim()); } catch { throw new Error(`Invalid project ${field}`); }
      if (!(protocols as readonly string[]).includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          (!url.protocol.endsWith("s:") && !isLoopbackHost(url.hostname)))
        throw new Error(`Invalid project ${field}: require TLS (except loopback) and no credentials/query`);
    }
  }
  const settings = {
    ...(doc.agent_id !== undefined ? { agentId: (doc.agent_id as string).trim() } : {}),
    ...(doc.api_url !== undefined ? { apiUrl: (doc.api_url as string).trim() } : {}),
    ...(doc.ws_url !== undefined ? { wsUrl: (doc.ws_url as string).trim() } : {}),
  };
  if (doc.profile !== undefined) {
    const value = (doc.profile as string).trim();
    if (value === "." || value === "..") throw new Error("Invalid project profile");
    if (value.startsWith("~/") || value.startsWith("~\\")) {
      const homeBase = resolve(homedir());
      const resolvedHomeTarget = resolve(homeBase, value.slice(2));
      const relHome = relative(homeBase, resolvedHomeTarget);
      if (!relHome || relHome.startsWith("..") || isAbsolute(relHome)) {
        throw new Error("Invalid project profile: home-relative path traversal");
      }
      return { selector: value, source: "project-config", ...settings };
    }
    if (!isAbsolute(value) && (value.includes("/") || value.includes("\\"))) {
      const resolvedTarget = resolve(resolvedCwd, value);
      const rel = relative(resolvedCwd, resolvedTarget);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("Invalid project profile: relative path must stay within project directory");
      }
      return { selector: resolvedTarget, source: "project-config", ...settings };
    }
    return { selector: value, source: "project-config", ...settings };
  }
  const profile = join(projectDir, "profile.json");
  const profileStat = safeLstat(profile);
  if (profileStat) {
    if (profileStat.isSymbolicLink() || !profileStat.isFile()) {
      throw new Error("Refusing symlinked or non-regular project .agentschat/profile.json");
    }
    return { selector: profile, source: "project-profile", ...settings };
  }
  // A declared agent/server scope must never silently disappear into a global identity.
  if (Object.keys(settings).length) throw new Error("Project identity/server settings require a profile binding");
}
