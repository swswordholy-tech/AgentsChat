import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MuseAgentChatConfig {
  agentId: string;
  token: string;
  wsUrl: string;
  restUrl: string;
  displayName?: string;
  defaultChannelId?: string;
}

export const DEFAULT_WS_URL = "wss://agents-chat.com/ws";
export const DEFAULT_REST_URL = "https://agents-chat.com";
export const PROFILE_PATH = join(homedir(), ".agentschat", "muse.json");
const MAX_PROFILE_BYTES = 64 * 1024;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function validateEndpointUrl(raw: string, kind: "ws" | "rest"): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Muse ${kind} URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Embedded credentials are not allowed in Muse ${kind} URL`);
  }
  if (kind === "ws") {
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error(`Invalid Muse ws URL protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === "ws:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("Remote Muse ws URL must use wss://");
    }
  } else {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Invalid Muse rest URL protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("Remote Muse rest URL must use https://");
    }
  }
  return trimmed;
}

export function redact(value: string | undefined): string {
  if (!value) return "(missing)";
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** Never print a token. Use this for logs / debug output. */
export function safeConfig(config: MuseAgentChatConfig): Record<string, unknown> {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token),
  };
}

interface ProfileFile {
  agentId?: string;
  token?: string;
  wsUrl?: string;
  restUrl?: string;
  displayName?: string;
  defaultChannelId?: string;
}

function readProfile(path = PROFILE_PATH): ProfileFile {
  try {
    if (!existsSync(path)) return {};
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_PROFILE_BYTES) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ProfileFile)
      : {};
  } catch {
    return {};
  }
}

/**
 * Precedence: explicit args > environment > ~/.agentschat/muse.json > defaults.
 * A missing agentId/token is a hard error — the caller must register first
 * (see README: `muse-agentchat --register-only --name my-bot`) and must
 * never fall back to an unrelated account.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, profilePath?: string): MuseAgentChatConfig {
  const profile = readProfile(profilePath);
  const rawAgentId = (env.AGENTCHAT_AGENT_ID ?? profile.agentId ?? "").trim();
  const rawToken = (env.AGENTCHAT_TOKEN ?? profile.token ?? "").trim();
  if (!rawAgentId || !rawToken || /[\x00-\x1f\x7f]/.test(rawAgentId) || /[\x00-\x1f\x7f]/.test(rawToken)) {
    throw new Error(
      "Missing AgentsChat identity: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " +
        `or create ${profilePath ?? PROFILE_PATH} via 'muse-agentchat --register-only --name <name>'. ` +
        "Tokens are never printed; see README for registration.",
    );
  }
  const wsUrl = validateEndpointUrl(env.AGENTCHAT_WS_URL ?? profile.wsUrl ?? DEFAULT_WS_URL, "ws");
  const restUrl = validateEndpointUrl(env.AGENTCHAT_REST_URL ?? profile.restUrl ?? DEFAULT_REST_URL, "rest");
  const rawDisplay = (env.AGENTCHAT_DISPLAY_NAME ?? profile.displayName)?.trim();
  const rawChannel = (env.AGENTCHAT_CHANNEL_ID ?? profile.defaultChannelId)?.trim();
  return {
    agentId: rawAgentId,
    token: rawToken,
    wsUrl,
    restUrl,
    displayName: rawDisplay || undefined,
    defaultChannelId: rawChannel || undefined,
  };
}
