import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidPrincipalOrChannelId, LocalStore } from "./local-store.js";
import type { DiscoveredLocalProfile, VerifiedPrincipal } from "./types.js";

export function resolveHomeDir(customHomeDir?: string): string {
  if (customHomeDir) return customHomeDir;
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export const DEFAULT_UPSTREAM_SERVER_URL = "https://agents-chat.com";

export interface IdentityAuthorityOptions {
  store: LocalStore;
  upstreamUrl?: string;
  allowLoopbackHttpUpstream?: boolean;
  fetchImpl?: typeof fetch;
}

function normalizeUpstreamBaseUrl(rawUrl: string | undefined, allowLoopbackHttp = false): string {
  const candidate = (rawUrl || DEFAULT_UPSTREAM_SERVER_URL).trim().replace(/\/+$/, "");
  const parsed = new URL(candidate);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Upstream AgentsChat URL must not contain credentials, query, or hash");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  if (parsed.protocol === "https:") {
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  }
  if (parsed.protocol === "http:" && allowLoopbackHttp && isLoopback) {
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  }
  throw new Error(`Upstream identity authority requires HTTPS (received ${parsed.protocol}//${parsed.host})`);
}

function decodeJwtExpIso(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload?.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
      return new Date(payload.exp * 1000).toISOString();
    }
  } catch {}
  return null;
}

const INTERNAL_NON_PROFILE_PREFIXES = [
  "session-binds",
  "agy-binds",
  "grok-binds",
  "identity-guard",
  "codex-bots",
  "last-seen-msg-ts-",
  "mention-ts-",
  "cursor-",
];

/**
 * Global Identity Authority:
 * All human accounts and agent IDs are allocated & verified by the remote AgentsChat
 * authority (`https://agents-chat.com`), then cached locally in SQLite by SHA-256 digest.
 * Switching an agent or user between Local Server and Cloud Server never creates duplicate
 * or conflicting IDs.
 */
export class GlobalIdentityAuthority {
  readonly store: LocalStore;
  readonly upstreamUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: IdentityAuthorityOptions) {
    this.store = opts.store;
    this.upstreamUrl = normalizeUpstreamBaseUrl(opts.upstreamUrl, Boolean(opts.allowLoopbackHttpUpstream));
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  }

  /**
   * Delegate new agent registration strictly to the upstream AgentsChat server so every
   * agent receives a globally unique `agent_id` + `ac_...` secret. Never mints local-only IDs.
   */
  async registerAgentViaUpstream(body: Record<string, unknown>): Promise<{
    status: number;
    data: Record<string, any>;
  }> {
    const res = await this.fetchImpl(`${this.upstreamUrl}/api/account/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 240) || `Upstream HTTP ${res.status}` };
    }

    if (res.ok && isValidPrincipalOrChannelId(parsed?.id) && typeof parsed?.key === "string" && parsed.key.trim()) {
      const caps = Array.isArray(body?.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === "string")
        : [];
      this.store.upsertVerifiedPrincipal({
        id: parsed.id,
        kind: "agent",
        display_name: String(parsed.name || body?.name || parsed.id),
        owner_id: typeof parsed.owner_id === "string" ? parsed.owner_id : null,
        claimed: Boolean(parsed.owner_id),
        capabilities: caps,
        raw_token: parsed.key.trim(),
      });
    }

    return { status: res.status, data: parsed };
  }

  /**
   * Verify a bearer credential (`ac_...` agent token or `eyJ...` human JWT).
   * - Hits local SHA-256 digest cache first for sub-millisecond local messaging.
   * - On cache miss, verifies once against `https://agents-chat.com` and caches the global ID.
   * - If `expectedId` is supplied (e.g. WS `auth` frame `agent_id`), enforces exact ID match.
   */
  async verifyToken(
    rawToken: string | undefined | null,
    expectedId?: string,
    declaredCapabilities?: string[],
  ): Promise<VerifiedPrincipal | null> {
    if (typeof rawToken !== "string") return null;
    const token = rawToken.trim();
    if (!token || token.length > 4096 || /[\x00-\x20\x7f]/.test(token)) return null;

    const cached = this.store.findCachedPrincipalByToken(token);
    if (cached) {
      if (expectedId && cached.id !== expectedId) return null;
      if (declaredCapabilities && declaredCapabilities.length > 0 && cached.capabilities.length === 0) {
        return this.store.upsertVerifiedPrincipal({
          id: cached.id,
          kind: cached.kind,
          display_name: cached.display_name,
          owner_id: cached.owner_id,
          claimed: cached.claimed,
          capabilities: declaredCapabilities,
          raw_token: token,
          expires_at: cached.expires_at,
        });
      }
      return cached;
    }

    const looksLikeJwt = token.startsWith("eyJ") && token.split(".").length === 3;
    if (!looksLikeJwt) {
      return this.verifyAgentTokenUpstream(token, expectedId, declaredCapabilities);
    }
    return this.verifyHumanJwtUpstream(token, expectedId);
  }

  private async verifyAgentTokenUpstream(
    token: string,
    expectedId?: string,
    declaredCapabilities?: string[],
  ): Promise<VerifiedPrincipal | null> {
    try {
      const res = await this.fetchImpl(`${this.upstreamUrl}/api/account/onboarding`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        this.store.invalidateToken(token);
        return null;
      }
      if (res.ok) {
        const data = (await res.json()) as any;
        const agentId = typeof data?.agent_id === "string" ? data.agent_id.trim() : "";
        if (isValidPrincipalOrChannelId(agentId)) {
          if (expectedId && agentId !== expectedId) return null;
          return this.store.upsertVerifiedPrincipal({
            id: agentId,
            kind: "agent",
            display_name: typeof data.display_name === "string" && data.display_name.trim() ? data.display_name.trim() : agentId,
            owner_id: typeof data.owner_id === "string" ? data.owner_id : null,
            claimed: Boolean(data.claimed),
            capabilities: declaredCapabilities || [],
            raw_token: token,
          });
        }
      }
    } catch {
      // Network unreachable with an uncached token: fail closed (never invent or trust unverified IDs)
      return null;
    }
    return null;
  }

  private async verifyHumanJwtUpstream(token: string, expectedId?: string): Promise<VerifiedPrincipal | null> {
    const expIso = decodeJwtExpIso(token);
    if (expIso && Date.parse(expIso) <= Date.now()) {
      return null;
    }
    try {
      const res = await this.fetchImpl(`${this.upstreamUrl}/api/account/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) {
        this.store.invalidateToken(token);
        return null;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const acct = data?.account && typeof data.account === "object" ? data.account : data;
      const rawUserId = String(acct?.id || acct?.user_id || acct?.email || "").trim();
      if (!isValidPrincipalOrChannelId(rawUserId)) return null;
      if (expectedId && rawUserId !== expectedId) return null;
      const displayName = String(acct?.display_name || acct?.name || rawUserId).trim();
      return this.store.upsertVerifiedPrincipal({
        id: rawUserId,
        kind: "user",
        display_name: displayName || rawUserId,
        owner_id: rawUserId,
        claimed: true,
        capabilities: ["human"],
        raw_token: token,
        expires_at: expIso,
      });
    } catch {
      return null;
    }
  }

  /**
   * Discover local MCP agent profiles in `~/.agentschat` (secret-free metadata only)
   * so Desktop users can see their local bots and invite them into local groups in 1 click.
   */
  static discoverLocalAgentProfiles(customHomeDir?: string): DiscoveredLocalProfile[] {
    const home = resolveHomeDir(customHomeDir);
    const dirs = [
      join(home, ".agentschat", "profiles"),
      join(home, ".agentschat"),
      join(home, ".agentchat"),
    ];
    const seenAgentIds = new Set<string>();
    const out: DiscoveredLocalProfile[] = [];

    for (const dir of dirs) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
      } catch {
        continue;
      }
      for (const file of entries) {
        const baseName = file.slice(0, -5);
        const lower = baseName.toLowerCase();
        if (INTERNAL_NON_PROFILE_PREFIXES.some((p) => lower === p || lower.startsWith(p))) continue;
        const fullPath = join(dir, file);
        try {
          const lst = lstatSync(fullPath);
          if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 256_000) continue;
          const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
          const agentId = typeof parsed?.agent_id === "string" ? parsed.agent_id.trim() : "";
          const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
          if (!isValidPrincipalOrChannelId(agentId) || !token || token === "dev-token") continue;
          if (seenAgentIds.has(agentId)) continue;
          seenAgentIds.add(agentId);
          out.push({
            profile_name: baseName,
            agent_id: agentId,
            display_name:
              typeof parsed.display_name === "string" && parsed.display_name.trim()
                ? parsed.display_name.trim()
                : agentId,
            file_path: fullPath,
          });
        } catch {}
      }
    }
    return out;
  }

  /**
   * Persist a newly upstream-registered agent identity into `~/.agentschat/profiles/<name>.json`
   * using strict `0o600` permissions, exclusive-create (`wx`, never overwrites), and symlink refusal.
   */
  static saveLocalAgentProfile(opts: {
    profileName: string;
    agentId: string;
    displayName: string;
    token: string;
    serverUrl?: string;
    customHomeDir?: string;
  }): { filePath: string; profileName: string } {
    const profileName = String(opts.profileName || "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,48}$/.test(profileName)) {
      throw new Error("Profile name must be 1-49 characters (letters, digits, '.', '_', '-')");
    }
    const lower = profileName.toLowerCase();
    if (INTERNAL_NON_PROFILE_PREFIXES.some((p) => lower === p || lower.startsWith(p))) {
      throw new Error(`Profile name '${profileName}' is reserved for internal MCP state`);
    }
    if (!isValidPrincipalOrChannelId(opts.agentId)) {
      throw new Error("Invalid global agent_id");
    }
    const token = String(opts.token || "").trim();
    if (!token || token === "dev-token") {
      throw new Error("Valid upstream-allocated agent token required");
    }

    const home = resolveHomeDir(opts.customHomeDir);
    const baseDir = join(home, ".agentschat");
    const profilesDir = join(baseDir, "profiles");
    mkdirSync(profilesDir, { recursive: true, mode: 0o700 });

    for (const dir of [baseDir, profilesDir]) {
      const lst = lstatSync(dir);
      if (lst.isSymbolicLink() || !lst.isDirectory()) {
        throw new Error(`Refusing to write into symlinked directory: ${dir}`);
      }
    }

    const filePath = join(profilesDir, `${profileName}.json`);
    const payload = {
      agent_id: opts.agentId,
      display_name: String(opts.displayName || opts.agentId).trim() || opts.agentId,
      token,
      server_url: opts.serverUrl || DEFAULT_UPSTREAM_SERVER_URL,
      registered_at: new Date().toISOString(),
    };
    try {
      writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (err: any) {
      if (err?.code === "EEXIST") {
        throw new Error(`Profile '${profileName}' already exists`);
      }
      throw err;
    }
    return { filePath, profileName };
  }
}
