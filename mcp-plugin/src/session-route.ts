/**
 * Wake routing for a single-process / single-identity bridge.
 *
 * A wake can only land in a harness Session, but the bridge knows AgentsChat
 * identities, not Session ids. `session-binds.json` is the join: it maps
 * `sessionId -> profileName`, and each profile file carries that identity's
 * `agent_id`. Inverting the pair answers "which Session owns the agent that just
 * received this DM?", so the wake payload can carry an explicit target instead of
 * the receiver guessing "the newest idle Session" — a guess that is wrong whenever
 * an older Session happens to be idle.
 *
 * Deliberately conservative: every missing or malformed piece resolves to
 * `undefined`, which leaves the receiver on its existing fallback. Routing must
 * never turn a delivery problem into a lost message.
 */
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSessionBinds } from "./session-bind.ts";

const MAX_PROFILE_BYTES = 64 * 1024;
const RESERVED_PROFILE_KEY = /^(?:__proto__|constructor|prototype)$/i;

export interface AgentSessionRoute {
  /** Harness session the wake should be delivered to. */
  sessionId: string;
  /** AgentsChat profile bound to that session. */
  profileName: string;
  /** Identity the profile file declares. */
  agentId: string;
}

/** Same config root the MCP server uses for profiles and `session-binds.json`. */
export function agentschatConfigDir(env: Record<string, string | undefined> = process.env): string {
  const custom = typeof env.AGENTSCHAT_CONFIG_DIR === "string" ? env.AGENTSCHAT_CONFIG_DIR.trim() : "";
  if (custom) return custom;
  const home = (env.HOME || env.USERPROFILE || homedir()).trim() || homedir();
  return join(home, ".agentschat");
}

function isSafeAgentId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    id !== "." &&
    id !== ".." &&
    !RESERVED_PROFILE_KEY.test(id) &&
    !/[/\\\s\x00-\x1f\x7f]/.test(id)
  );
}

/**
 * Resolve a bind entry's profile name to its file.
 *
 * Mirrors the server's nested-first convention (`<configDir>/profiles/<name>.json`)
 * and the flat legacy layout. Only plain profile names resolve — a name that
 * contains a path separator is skipped rather than guessed, because a wrong path
 * would silently route a wake into the wrong identity.
 */
function isSafeRegularProfileFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isFile() && st.size <= MAX_PROFILE_BYTES;
  } catch {
    return false;
  }
}

function isSafeRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

function profilePathForName(configDir: string, name: string): string | undefined {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 133 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(name) ||
    !isSafeRealDir(configDir)
  ) {
    return undefined;
  }
  const base = name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!base || base.length > 128 || RESERVED_PROFILE_KEY.test(base)) return undefined;
  const profilesDir = join(configDir, "profiles");
  if (isSafeRealDir(profilesDir)) {
    const nested = join(profilesDir, `${base}.json`);
    if (isSafeRegularProfileFile(nested)) return nested;
  }
  const flat = join(configDir, `${base}.json`);
  return isSafeRegularProfileFile(flat) ? flat : undefined;
}

function readAgentId(path: string): string | undefined {
  try {
    if (!isSafeRegularProfileFile(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { agent_id?: unknown };
    const id = typeof parsed?.agent_id === "string" ? parsed.agent_id.trim() : "";
    return isSafeAgentId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Session currently bound to `agentId`, or `undefined` when unknown.
 *
 * The last matching bind wins: binds are appended as sessions are bound, and
 * re-binding an existing session keeps its position, so the final match is the
 * most recently established route for this identity.
 */
export function resolveSessionForAgent(
  agentId: string | null | undefined,
  opts: {
    configDir?: string;
    env?: Record<string, string | undefined>;
    filter?: (sessionId: string) => boolean;
  } = {},
): AgentSessionRoute | undefined {
  const targetAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!isSafeAgentId(targetAgentId)) return undefined;
  const configDir = opts.configDir ?? agentschatConfigDir(opts.env);
  let binds: Record<string, string>;
  try {
    binds = loadSessionBinds(configDir);
  } catch {
    return undefined;
  }
  for (const [sessionId, profileName] of Object.entries(binds).reverse()) {
    if (opts.filter && !opts.filter(sessionId)) continue;
    const path = profilePathForName(configDir, profileName);
    if (path === undefined) continue;
    if (readAgentId(path) !== targetAgentId) continue;
    return { sessionId, profileName, agentId: targetAgentId };
  }
  return undefined;
}
