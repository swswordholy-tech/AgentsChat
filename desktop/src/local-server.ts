import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { GlobalIdentityAuthority } from "./identity-authority.js";
import { isValidPrincipalOrChannelId, LocalStore } from "./local-store.js";
import type { LocalMessage, LocalServerStatus, VerifiedPrincipal } from "./types.js";

export interface LocalMiniServerOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  upstreamUrl?: string;
  allowLoopbackHttpUpstream?: boolean;
  fetchImpl?: typeof fetch;
  staticUiDir?: string;
  onMessageReceived?: (msg: LocalMessage, channelName: string) => void;
}

interface AuthedSocket {
  ws: WebSocket;
  sessionId: string;
  principal: VerifiedPrincipal;
}

const CLOUD_ONLY_PATH_PREFIXES = [
  "/api/cloud-agents",
  "/api/loops",
  "/api/okr",
  "/api/memory",
  "/api/skills",
  "/api/arenas",
  "/api/stories",
  "/api/file/upload",
  "/api/upload",
  "/api/stt",
  "/api/tts",
  "/api/voices",
  "/api/hidden-identity",
  "/api/me/entitlements",
  "/api/moderation",
];

function extractBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw || typeof raw !== "string") return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function readJsonBody(req: IncomingMessage, maxBytes = 128_000): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Strict allowlist of public UI assets servable over HTTP — internal Electron preload/shell files
// (preload.cjs, local-preload.cjs, shell.html, cloud-offline.html) must NEVER be exposed over HTTP.
const ALLOWED_PUBLIC_UI_FILES = new Set([
  "local-chat.html",
  "local-chat.css",
  "local-chat.js",
  "tray-icon.png",
  "tray-icon@2x.png",
]);

/**
 * Embedded Local Mini-Server for AgentsChat Desktop (macOS & Windows).
 *
 * Scope by design:
 * - Minimal core chat capabilities (group channels, 1v1 DMs, WS/SSE real-time messaging,
 *   `@mention` wake, typing indicators, message history, local SQLite storage).
 * - Global Identity Authority (`https://agents-chat.com`): all human accounts & agent IDs
 *   are allocated/verified upstream and cached locally by SHA-256 digest so switching
 *   between Local Server and Cloud Server never causes ID collisions.
 * - Full platform capabilities (Cloud Sandbox Agents, `/loop` schedules, Room OKR/DAG,
 *   Cloud Working Memory & Skills, Cross-Network Discovery) require connecting to
 *   `https://agents-chat.com`.
 */
export class LocalMiniServer {
  readonly store: LocalStore;
  readonly authority: GlobalIdentityAuthority;
  private readonly host: string;
  private requestedPort: number;
  private boundPort = 0;
  private readonly staticUiDir: string | null;
  private readonly onMessageReceived?: (msg: LocalMessage, channelName: string) => void;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private socketsByPrincipal = new Map<string, Set<AuthedSocket>>();
  private sseSubscribers = new Map<string, Set<ServerResponse>>();

  constructor(opts: LocalMiniServerOptions = {}) {
    this.host = opts.host || "127.0.0.1";
    this.requestedPort = opts.port ?? 8787;
    this.store = new LocalStore(opts.dbPath || ":memory:");
    this.authority = new GlobalIdentityAuthority({
      store: this.store,
      upstreamUrl: opts.upstreamUrl,
      allowLoopbackHttpUpstream: opts.allowLoopbackHttpUpstream,
      fetchImpl: opts.fetchImpl,
    });
    this.staticUiDir = opts.staticUiDir || null;
    this.onMessageReceived = opts.onMessageReceived;
  }

  async start(): Promise<LocalServerStatus> {
    if (this.httpServer) return this.getStatus();

    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: String(err?.message || "Internal server error") });
        } else {
          res.end();
        }
      });
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    wss.on("connection", (ws) => this.handleWsConnection(ws));

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.httpServer = server;
    this.wss = wss;
    return this.getStatus();
  }

  async stop(): Promise<void> {
    for (const set of this.sseSubscribers.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {}
      }
    }
    this.sseSubscribers.clear();

    for (const set of this.socketsByPrincipal.values()) {
      for (const entry of set) {
        try {
          entry.ws.terminate();
        } catch {}
      }
    }
    this.socketsByPrincipal.clear();

    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {}
      }
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.boundPort = 0;
  }

  closeAll(): Promise<void> {
    return this.stop().then(() => this.store.close());
  }

  getStatus(): LocalServerStatus {
    const connectHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
    const port = this.boundPort || this.requestedPort;
    const channels = this.store.listChannelsForPrincipal(null, false);
    const lanUrls: string[] = [];
    if (this.host === "0.0.0.0" && this.httpServer) {
      const ifaces = networkInterfaces();
      for (const addrs of Object.values(ifaces)) {
        for (const addr of addrs || []) {
          if (addr.family === "IPv4" && !addr.internal && addr.address) {
            lanUrls.push(`http://${addr.address}:${port}`);
          }
        }
      }
    }
    return {
      running: Boolean(this.httpServer),
      host: this.host,
      port,
      httpUrl: `http://${connectHost}:${port}`,
      wsUrl: `ws://${connectHost}:${port}/ws`,
      lanUrls: Array.from(new Set(lanUrls)),
      upstreamUrl: this.authority.upstreamUrl,
      connectedAgents: Array.from(this.socketsByPrincipal.keys()),
      channelCount: channels.length,
    };
  }

  private isOnline(principalId: string): boolean {
    const set = this.socketsByPrincipal.get(principalId);
    return Boolean(set && set.size > 0);
  }

  private broadcastToChannel(channelId: string, frame: Record<string, unknown>): number {
    const members = this.store.listChannelMembers(channelId);
    const json = JSON.stringify(frame);
    let delivered = 0;
    for (const m of members) {
      const sockets = this.socketsByPrincipal.get(m.principal_id);
      if (!sockets) continue;
      for (const entry of sockets) {
        if (entry.ws.readyState === WebSocket.OPEN) {
          try {
            entry.ws.send(json);
            delivered++;
          } catch {}
        }
      }
    }

    const sseSet = this.sseSubscribers.get(channelId);
    if (sseSet && sseSet.size > 0) {
      const eventName = typeof frame.type === "string" ? frame.type : "message";
      const sseChunk = `event: ${eventName}\ndata: ${json}\n\n`;
      for (const res of sseSet) {
        try {
          res.write(sseChunk);
        } catch {
          sseSet.delete(res);
        }
      }
    }
    return delivered;
  }

  // ── HTTP Router ─────────────────────────────────────────────────────────

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;

    // Loopback CORS support for local Electron renderer only
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Agent-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Health & Capability Discovery
    if (pathname === "/health" && method === "GET") {
      const st = this.getStatus();
      sendJson(res, 200, {
        status: "ok",
        mode: "desktop_local_minimal",
        version: "0.1.0",
        build: "desktop-local",
        agents: st.connectedAgents.length,
        channels: st.channelCount,
        lan_urls: st.lanUrls,
        upstream_identity_authority: this.authority.upstreamUrl,
        capabilities: {
          group_chat: true,
          direct_chat: true,
          ws_realtime: true,
          sse_stream: true,
          global_identity_sync: true,
          cloud_agents: false,
          loops: false,
          okr: false,
          cloud_memory: false,
          skills_cloud: false,
        },
      });
      return;
    }

    // 2. Explicit Cloud-Only Capability Boundary
    if (
      CLOUD_ONLY_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
      /^\/api\/channels\/[^/]+\/(?:docs|okr|okr_snapshot|loops|wake-health|cloud-wake-health|proposals)(?:\/|$)/.test(pathname)
    ) {
      sendJson(res, 501, {
        error: `Full platform capability (${pathname}) requires connecting to the remote AgentsChat Cloud server (${this.authority.upstreamUrl}). The embedded Desktop Local Server intentionally provides minimal group & 1v1 chat only.`,
        code: "CLOUD_SERVER_REQUIRED",
        upgrade_url: this.authority.upstreamUrl,
      });
      return;
    }

    // 3. Global Identity Registration (strictly delegated to upstream AgentsChat server)
    if (pathname === "/api/account/register" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
        sendJson(res, 400, { error: String(e?.message || "Invalid JSON") });
        return;
      }
      try {
        const upstream = await this.authority.registerAgentViaUpstream(body || {});
        sendJson(res, upstream.status, upstream.data);
      } catch (e: any) {
        sendJson(res, 502, {
          error: `Cannot reach global identity authority (${this.authority.upstreamUrl}) to allocate a globally unique Agent ID: ${String(e?.message || e)}`,
          code: "UPSTREAM_IDENTITY_UNAVAILABLE",
        });
      }
      return;
    }

    // 4. Onboarding / Identity Introspection (`whoami` & Desktop session check)
    if (pathname === "/api/account/onboarding" && method === "GET") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        agent_id: principal.id,
        display_name: principal.display_name,
        claimed: principal.claimed,
        ...(principal.owner_id ? { owner_id: principal.owner_id } : {}),
        identity_authority: this.authority.upstreamUrl,
      });
      return;
    }

    if (pathname === "/api/account/me" && method === "GET") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        account: {
          id: principal.id,
          name: principal.display_name,
          display_name: principal.display_name,
          type: principal.kind,
          claimed: principal.claimed,
          owner_id: principal.owner_id,
        },
      });
      return;
    }

    const accountMatch = pathname.match(/^\/api\/account\/([^/]+)$/);
    if (accountMatch && method === "GET") {
      const targetId = decodeURIComponent(accountMatch[1]);
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const found = principal.id === targetId ? principal : this.store.getPrincipalById(targetId);
      if (!found) {
        sendJson(res, 404, { error: "Account not found" });
        return;
      }
      sendJson(res, 200, {
        id: found.id,
        name: found.display_name,
        type: found.kind,
        claimed: found.claimed,
      });
      return;
    }

    // 5. Local Discovered MCP Profiles Helper (for Desktop UI 1-click group invite, loopback-only)
    if (pathname === "/api/local/discovered-profiles" && method === "GET") {
      const remoteAddr = req.socket.remoteAddress || "";
      if (remoteAddr !== "127.0.0.1" && remoteAddr !== "::1" && remoteAddr !== "::ffff:127.0.0.1") {
        sendJson(res, 403, { error: "Loopback only" });
        return;
      }
      sendJson(res, 200, {
        profiles: GlobalIdentityAuthority.discoverLocalAgentProfiles(),
        known_principals: this.store.listPrincipals().map((p) => ({
          id: p.id,
          kind: p.kind,
          display_name: p.display_name,
          online: this.isOnline(p.id),
        })),
      });
      return;
    }

    // 5b. Full-text Message Search (scoped strictly to channels readable by the authenticated principal)
    if (pathname === "/api/search" && method === "GET") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) {
        sendJson(res, 400, { error: "Query parameter 'q' is required" });
        return;
      }
      const channelId = url.searchParams.get("channel_id")?.trim() || undefined;
      const limit = Number(url.searchParams.get("limit") || 20);
      const messages = this.store.searchMessages(principal.id, q, { channelId, limit });
      sendJson(res, 200, { query: q, total: messages.length, messages });
      return;
    }

    // 5c. Batch Online Presence (`GET /api/presence?ids=a,b,c`) for `agentschat-mcp` `channel_brief`
    if (pathname === "/api/presence" && method === "GET") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const rawIds = (url.searchParams.get("ids") || "").trim();
      const ids = rawIds
        ? rawIds
            .split(",")
            .map((s) => s.trim())
            .filter((s) => isValidPrincipalOrChannelId(s))
            .slice(0, 100)
        : [];
      const presence: Record<string, "online" | "offline"> = {};
      for (const id of ids) {
        presence[id] = this.isOnline(id) ? "online" : "offline";
      }
      sendJson(res, 200, { presence });
      return;
    }

    // 6. Channels List / Discover / Mine / Create
    if (pathname === "/api/channels/discover" && method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const publicChannels = this.store
        .listChannelsForPrincipal(null, false)
        .filter((ch) => ch.visibility === "public" && ch.type !== "direct")
        .filter((ch) => !q || ch.id.toLowerCase().includes(q) || ch.name.toLowerCase().includes(q) || ch.topic.toLowerCase().includes(q))
        .map((ch) => {
          const members = this.store.listChannelMembers(ch.id);
          const onlineAgentCount = members.filter((m) => m.kind === "agent" && this.isOnline(m.principal_id)).length;
          return {
            ...ch,
            online_agent_count: onlineAgentCount,
          };
        });
      sendJson(res, 200, { channels: publicChannels });
      return;
    }

    if ((pathname === "/api/channels" || pathname === "/api/channels/mine") && method === "GET") {
      const token = extractBearerToken(req);
      const principal = token ? await this.authority.verifyToken(token) : null;
      if (pathname === "/api/channels/mine" && !principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const channels = this.store.listChannelsForPrincipal(
        principal?.id ?? null,
        pathname === "/api/channels/mine",
      );
      sendJson(res, 200, { channels });
      return;
    }

    if (pathname === "/api/channels" && method === "POST") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (e: any) {
        sendJson(res, 400, { error: String(e?.message || "Invalid JSON") });
        return;
      }
      try {
        const requestedMembers = Array.isArray(body.members)
          ? body.members
          : typeof body.target_id === "string"
            ? [body.target_id]
            : [];
        const created = this.store.createChannel({
          id: typeof body.id === "string" ? body.id : undefined,
          name: typeof body.name === "string" ? body.name : undefined,
          type: body.type,
          topic: typeof body.topic === "string" ? body.topic : undefined,
          visibility: body.visibility,
          creatorId: principal.id,
          memberIds: requestedMembers,
        });
        sendJson(res, 201, { ok: true, channel: created });
      } catch (e: any) {
        sendJson(res, 400, { error: String(e?.message || "Failed to create channel") });
      }
      return;
    }

    // 7. Per-Channel Endpoints (`/detail`, `/members`, `/join`, `/leave`, `/invite`, `/messages`, `/stream`)
    const chanMatch = pathname.match(/^\/api\/channels\/([^/]+)(?:\/([^/]+))?$/);
    if (chanMatch) {
      const channelId = decodeURIComponent(chanMatch[1]);
      const action = chanMatch[2] || "";
      if (!isValidPrincipalOrChannelId(channelId)) {
        sendJson(res, 400, { error: "Invalid channel ID" });
        return;
      }
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const channel = this.store.getChannel(channelId);

      if (action === "join" && method === "POST") {
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        if (channel.visibility === "private" && !this.store.isMember(channelId, principal.id)) {
          sendJson(res, 403, { error: "Private channel requires invite from a member" });
          return;
        }
        this.store.addMember(channelId, principal.id, "member");
        sendJson(res, 200, { ok: true, channel_id: channelId, agent_id: principal.id });
        return;
      }

      if (action === "leave" && method === "POST") {
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        const removed = this.store.removeMember(channelId, principal.id);
        sendJson(res, 200, { ok: true, ...(removed ? {} : { note: "not a member" }) });
        return;
      }

      if (action === "invite" && method === "POST") {
        if (!channel) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        if (channel.type === "direct") {
          sendJson(res, 400, { error: "Cannot invite additional members to a 1v1 direct channel" });
          return;
        }
        if (!this.store.isMember(channelId, principal.id)) {
          sendJson(res, 403, { error: "Only channel members can invite participants" });
          return;
        }
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch {
          body = {};
        }
        const targetId = String(body.agent_id || body.member_id || body.target_id || "").trim();
        if (!isValidPrincipalOrChannelId(targetId)) {
          sendJson(res, 400, { error: "Valid agent_id or member_id required" });
          return;
        }
        this.store.addMember(channelId, targetId, "member");
        sendJson(res, 200, { ok: true, channel_id: channelId, invited: targetId, auto_joined: true });
        return;
      }

      if (!channel) {
        sendJson(res, 404, { error: "Channel not found" });
        return;
      }

      // Auto-join public `#welcome` on first read/post by a verified principal for smooth UX
      if (channel.visibility === "public" && channelId === "welcome" && !this.store.isMember(channelId, principal.id)) {
        this.store.addMember(channelId, principal.id, "member");
      }

      if (channel.visibility === "private" && !this.store.isMember(channelId, principal.id)) {
        sendJson(res, 403, { error: "Not a member of this private channel" });
        return;
      }

      if ((action === "" || action === "detail") && method === "GET") {
        const members = this.store.listChannelMembers(channelId);
        sendJson(res, 200, {
          ...channel,
          member_count: members.length,
          members: members.map((m) => m.principal_id),
        });
        return;
      }

      if (action === "" && method === "PATCH") {
        if (!this.store.isMember(channelId, principal.id)) {
          sendJson(res, 403, { error: "Only channel members can update topic" });
          return;
        }
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (e: any) {
          sendJson(res, 400, { error: String(e?.message || "Invalid JSON") });
          return;
        }
        if (typeof body?.topic !== "string") {
          sendJson(res, 400, { error: "String 'topic' field required" });
          return;
        }
        const updated = this.store.updateChannelTopic(channelId, body.topic);
        if (!updated) {
          sendJson(res, 404, { error: "Channel not found" });
          return;
        }
        this.broadcastToChannel(channelId, {
          type: "topic_update",
          channel_id: channelId,
          topic: updated.topic,
          updated_by: principal.id,
        });
        sendJson(res, 200, { ok: true, channel: updated });
        return;
      }

      if (action === "members" && method === "GET") {
        const members = this.store.listChannelMembers(channelId).map((m) => ({
          agent_id: m.principal_id,
          display_name: m.display_name,
          role: m.role,
          type: m.kind,
          capabilities: m.capabilities,
          online: this.isOnline(m.principal_id),
        }));
        sendJson(res, 200, { channel_id: channelId, members });
        return;
      }

      if (action === "pins" && method === "GET") {
        sendJson(res, 200, { channel_id: channelId, pins: [] });
        return;
      }

      if (action === "messages" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") || 50);
        const after = url.searchParams.get("after") || undefined;
        const before = url.searchParams.get("before") || undefined;
        const messages = this.store.getMessages(channelId, { limit, after, before });
        sendJson(res, 200, { channel_id: channelId, messages });
        return;
      }

      if (action === "messages" && method === "POST") {
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (e: any) {
          sendJson(res, 400, { error: String(e?.message || "Invalid JSON") });
          return;
        }
        const rawContent = typeof body.content === "string" ? body.content : typeof body.text === "string" ? body.text : "";
        if (!rawContent.trim()) {
          sendJson(res, 400, { error: "Message content is required" });
          return;
        }
        if (channel.visibility === "public" && !this.store.isMember(channelId, principal.id)) {
          this.store.addMember(channelId, principal.id, "member");
        }
        const saved = this.store.appendMessage({
          channelId,
          senderId: principal.id,
          senderName: principal.display_name,
          senderType: principal.kind === "user" ? "human" : "agent",
          content: rawContent,
          contentType: body.content_type,
          inReplyTo: typeof body.in_reply_to === "string" ? body.in_reply_to : typeof body.reply_to === "string" ? body.reply_to : undefined,
        });
        const delivered = this.broadcastToChannel(channelId, {
          type: "message",
          ...saved,
        });
        this.onMessageReceived?.(saved, channel.name);
        sendJson(res, 201, { ok: true, message: saved, id: saved.id, timestamp: saved.timestamp, delivered_to: delivered });
        return;
      }

      if (action === "stream" && method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ channel_id: channelId })}\n\n`);
        let set = this.sseSubscribers.get(channelId);
        if (!set) {
          set = new Set();
          this.sseSubscribers.set(channelId, set);
        }
        set.add(res);
        const keepAlive = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {}
        }, 20_000);
        keepAlive.unref?.();
        req.on("close", () => {
          clearInterval(keepAlive);
          set?.delete(res);
        });
        return;
      }
    }

    // 7b. Single-Message Read, Edit & Soft-Delete (`GET` / `PATCH` / `DELETE /api/channels/:id/messages/:msgId`)
    const msgItemMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/);
    if (msgItemMatch && (method === "GET" || method === "PATCH" || method === "DELETE")) {
      const channelId = decodeURIComponent(msgItemMatch[1]);
      const messageId = decodeURIComponent(msgItemMatch[2]);
      if (!isValidPrincipalOrChannelId(channelId) || !messageId || messageId.length > 128) {
        sendJson(res, 400, { error: "Invalid channel_id or message_id" });
        return;
      }
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const channel = this.store.getChannel(channelId);
      if (!channel) {
        sendJson(res, 404, { error: "Channel not found" });
        return;
      }
      if (channel.visibility === "private" && !this.store.isMember(channelId, principal.id)) {
        sendJson(res, 403, { error: "Not a member of this private channel" });
        return;
      }
      const existing = this.store.getMessageById(channelId, messageId);
      if (!existing) {
        sendJson(res, 404, { error: "Message not found" });
        return;
      }

      if (method === "GET") {
        sendJson(res, 200, { ok: true, message: existing });
        return;
      }

      if (method === "PATCH") {
        if (existing.sender_id !== principal.id) {
          sendJson(res, 403, { error: "Only the original sender can edit this message" });
          return;
        }
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch (e: any) {
          sendJson(res, 400, { error: String(e?.message || "Invalid JSON") });
          return;
        }
        const newContent = typeof body.content === "string" ? body.content : typeof body.text === "string" ? body.text : "";
        const updated = this.store.editMessage(channelId, messageId, principal.id, newContent);
        if (!updated) {
          sendJson(res, 400, { error: "Non-empty message content required" });
          return;
        }
        this.broadcastToChannel(channelId, {
          type: "message_edited",
          channel_id: channelId,
          message_id: updated.id,
          content: updated.content,
          new_content: updated.content,
          edited_at: updated.edited_at,
        });
        sendJson(res, 200, { ok: true, message: updated });
        return;
      }

      if (method === "DELETE") {
        const members = this.store.listChannelMembers(channelId);
        const me = members.find((m) => m.principal_id === principal.id);
        const isAdmin = me?.role === "admin" || channel.created_by === principal.id;
        if (existing.sender_id !== principal.id && !isAdmin) {
          sendJson(res, 403, { error: "Only the sender or channel admin can delete this message" });
          return;
        }
        const ok = this.store.deleteMessage(channelId, messageId, principal.id, isAdmin);
        if (!ok) {
          sendJson(res, 404, { error: "Message not found" });
          return;
        }
        this.broadcastToChannel(channelId, {
          type: "message_deleted",
          channel_id: channelId,
          message_id: messageId,
          deleted_by: principal.id,
        });
        sendJson(res, 200, { ok: true, deleted: messageId });
        return;
      }
    }

    // 8. Minimal Streamable HTTP `/mcp` read-only context support (`agentschat_get_channel_context` / `agentschat_read_messages`)
    if (pathname === "/mcp" && method === "POST") {
      const principal = await this.authority.verifyToken(extractBearerToken(req));
      if (!principal) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      let rpc: any;
      try {
        rpc = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON-RPC" });
        return;
      }
      if (rpc?.method === "tools/call") {
        const toolName = rpc.params?.name;
        const toolArgs = rpc.params?.arguments || {};
        if (toolName === "agentschat_get_channel_context") {
          const cid = String(toolArgs.channel_id || "welcome");
          const ch = this.store.getChannel(cid);
          if (!ch || (ch.visibility === "private" && !this.store.isMember(cid, principal.id))) {
            sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "Channel inaccessible" } });
            return;
          }
          const members = this.store.listChannelMembers(cid);
          const ctxPayload = {
            channel: ch,
            agents: members
              .filter((m) => m.kind === "agent")
              .map((m) => ({
                id: m.principal_id,
                name: m.display_name,
                capabilities: m.capabilities,
                online: this.isOnline(m.principal_id),
              })),
          };
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify(ctxPayload) }],
              structuredContent: ctxPayload,
            },
          });
          return;
        }
        if (toolName === "agentschat_read_messages") {
          const cid = String(toolArgs.channel_id || "welcome");
          const ch = this.store.getChannel(cid);
          if (!ch || (ch.visibility === "private" && !this.store.isMember(cid, principal.id))) {
            sendJson(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "Channel inaccessible" } });
            return;
          }
          const exactId = typeof toolArgs.message_id === "string" ? toolArgs.message_id : "";
          const messages = exactId
            ? (() => {
                const m = this.store.getMessageById(cid, exactId);
                return m ? [m] : [];
              })()
            : this.store.getMessages(cid, { limit: Number(toolArgs.limit) || 20 });
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              content: [{ type: "text", text: JSON.stringify({ messages }) }],
              structuredContent: { messages },
            },
          });
          return;
        }
      }
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: rpc?.id ?? null,
        error: {
          code: -32601,
          message: `Tool requires remote AgentsChat Cloud server (${this.authority.upstreamUrl})`,
        },
      });
      return;
    }

    // 9. Optional Static Desktop Local Chat UI (strict allowlist + symlink/traversal guard + CSP)
    if (this.staticUiDir && (method === "GET" || method === "HEAD")) {
      const requestedName = pathname === "/" ? "local-chat.html" : pathname.replace(/^\/+/, "");
      if (ALLOWED_PUBLIC_UI_FILES.has(requestedName)) {
        const baseDir = resolve(this.staticUiDir);
        const candidate = resolve(baseDir, requestedName);
        if (candidate.startsWith(baseDir + sep) && existsSync(candidate)) {
          try {
            const lst = lstatSync(candidate);
            if (!lst.isSymbolicLink() && lst.isFile()) {
              const ext = extname(candidate).toLowerCase();
              const mime = MIME_BY_EXT[ext] || "application/octet-stream";
              const content = readFileSync(candidate);
              const headers: Record<string, string> = {
                "Content-Type": mime,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
              };
              if (ext === ".html") {
                headers["Content-Security-Policy"] =
                  "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;";
              }
              res.writeHead(200, headers);
              res.end(method === "HEAD" ? undefined : content);
              return;
            }
          } catch {}
        }
      }
    }

    sendJson(res, 404, { error: "Not found" });
  }

  // ── WebSocket Protocol (`/ws`) ──────────────────────────────────────────

  private handleWsConnection(ws: WebSocket): void {
    let authed: AuthedSocket | null = null;
    const authTimeout = setTimeout(() => {
      if (!authed) {
        try {
          ws.send(JSON.stringify({ type: "error", code: 401, message: "Authentication timeout" }));
          ws.close();
        } catch {}
      }
    }, 15_000);
    authTimeout.unref?.();

    ws.on("message", (raw) => {
      void (async () => {
        let frame: any;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          ws.send(JSON.stringify({ type: "error", code: 400, message: "Invalid JSON frame" }));
          return;
        }
        if (!frame || typeof frame.type !== "string") return;

        if (frame.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
          return;
        }

        if (frame.type === "auth") {
          const token = typeof frame.token === "string" ? frame.token : "";
          const expectedId = typeof frame.agent_id === "string" && frame.agent_id.trim() ? frame.agent_id.trim() : undefined;
          const caps = Array.isArray(frame.capabilities)
            ? frame.capabilities.filter((c: unknown): c is string => typeof c === "string")
            : undefined;
          const principal = await this.authority.verifyToken(token, expectedId, caps);
          if (!principal) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: 401,
                message: `Authentication failed — credentials must be issued by ${this.authority.upstreamUrl}`,
              }),
            );
            ws.close();
            return;
          }
          clearTimeout(authTimeout);
          const sessionId = `local_${randomUUID()}`;
          authed = { ws, sessionId, principal };
          let set = this.socketsByPrincipal.get(principal.id);
          const wasOffline = !set || set.size === 0;
          if (!set) {
            set = new Set();
            this.socketsByPrincipal.set(principal.id, set);
          }
          set.add(authed);

          // Ensure every authenticated principal is in `#welcome`
          this.store.addMember("welcome", principal.id, "member");

          ws.send(
            JSON.stringify({
              type: "auth_ok",
              agent_id: principal.id,
              display_name: principal.display_name,
              session_id: sessionId,
            }),
          );

          if (wasOffline) {
            for (const cid of this.store.listPrincipalChannelIds(principal.id)) {
              this.broadcastToChannel(cid, {
                type: "agent_online",
                channel_id: cid,
                agent_id: principal.id,
                display_name: principal.display_name,
              });
            }
          }
          return;
        }

        if (!authed) {
          ws.send(JSON.stringify({ type: "error", code: 401, message: "Authenticate first with {type:'auth'}" }));
          return;
        }

        const caller = authed.principal;

        if (frame.type === "join_channel" && typeof frame.channel_id === "string") {
          const ch = this.store.getChannel(frame.channel_id);
          if (!ch) {
            ws.send(JSON.stringify({ type: "error", code: 404, message: "Channel not found" }));
            return;
          }
          if (ch.visibility === "private" && !this.store.isMember(ch.id, caller.id)) {
            ws.send(JSON.stringify({ type: "error", code: 403, message: "Private channel requires invite" }));
            return;
          }
          this.store.addMember(ch.id, caller.id, "member");
          ws.send(JSON.stringify({ type: "channel_joined", channel_id: ch.id, agent_id: caller.id }));
          return;
        }

        if (frame.type === "leave_channel" && typeof frame.channel_id === "string") {
          this.store.removeMember(frame.channel_id, caller.id);
          ws.send(JSON.stringify({ type: "channel_left", channel_id: frame.channel_id, agent_id: caller.id }));
          return;
        }

        if ((frame.type === "message" || frame.type === "send_message") && typeof frame.channel_id === "string") {
          const ch = this.store.getChannel(frame.channel_id);
          if (!ch) {
            ws.send(JSON.stringify({ type: "error", code: 404, message: "Channel not found" }));
            return;
          }
          if (ch.visibility === "private" && !this.store.isMember(ch.id, caller.id)) {
            ws.send(JSON.stringify({ type: "error", code: 403, message: "Not a member of this channel" }));
            return;
          }
          if (ch.visibility === "public" && !this.store.isMember(ch.id, caller.id)) {
            this.store.addMember(ch.id, caller.id, "member");
          }
          const content = String(frame.content ?? frame.text ?? "").trim();
          if (!content) return;
          const saved = this.store.appendMessage({
            id: typeof frame.id === "string" ? frame.id : undefined,
            channelId: ch.id,
            senderId: caller.id,
            senderName: caller.display_name,
            senderType: caller.kind === "user" ? "human" : "agent",
            content,
            contentType: frame.content_type,
            inReplyTo: typeof frame.in_reply_to === "string" ? frame.in_reply_to : undefined,
          });
          const delivered = this.broadcastToChannel(ch.id, {
            type: "message",
            ...saved,
          });
          ws.send(
            JSON.stringify({
              type: "message_ack",
              message_id: saved.id,
              channel_id: ch.id,
              delivered_to: delivered,
              timestamp: saved.timestamp,
            }),
          );
          this.onMessageReceived?.(saved, ch.name);
          return;
        }

        if (frame.type === "typing" && typeof frame.channel_id === "string") {
          if (this.store.isMember(frame.channel_id, caller.id)) {
            this.broadcastToChannel(frame.channel_id, {
              type: "typing",
              channel_id: frame.channel_id,
              sender_id: caller.id,
            });
          }
          return;
        }

        if (frame.type === "edit_message" && typeof frame.channel_id === "string" && typeof frame.message_id === "string") {
          const updated = this.store.editMessage(
            frame.channel_id,
            frame.message_id,
            caller.id,
            String(frame.new_content ?? frame.content ?? ""),
          );
          if (updated) {
            this.broadcastToChannel(frame.channel_id, {
              type: "message_edited",
              channel_id: frame.channel_id,
              message_id: updated.id,
              content: updated.content,
              new_content: updated.content,
              edited_at: updated.edited_at,
            });
          }
          return;
        }

        if (frame.type === "set_topic" && typeof frame.channel_id === "string" && typeof frame.topic === "string") {
          if (this.store.isMember(frame.channel_id, caller.id)) {
            const updated = this.store.updateChannelTopic(frame.channel_id, frame.topic);
            if (updated) {
              this.broadcastToChannel(frame.channel_id, {
                type: "topic_update",
                channel_id: frame.channel_id,
                topic: updated.topic,
                updated_by: caller.id,
              });
            }
          }
          return;
        }

        if (frame.type === "delete_message" && typeof frame.channel_id === "string" && typeof frame.message_id === "string") {
          const isAdmin = this.store.getMemberRole(frame.channel_id, caller.id) === "admin";
          if (this.store.deleteMessage(frame.channel_id, frame.message_id, caller.id, isAdmin)) {
            this.broadcastToChannel(frame.channel_id, {
              type: "message_deleted",
              channel_id: frame.channel_id,
              message_id: frame.message_id,
            });
          }
          return;
        }

        if (frame.type === "read_receipt" && typeof frame.channel_id === "string" && typeof frame.last_read_id === "string") {
          this.store.saveReadCursor(frame.channel_id, caller.id, frame.last_read_id);
        }
      })().catch(() => {});
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      if (authed) {
        const closedPrincipalId = authed.principal.id;
        const set = this.socketsByPrincipal.get(closedPrincipalId);
        let wentOffline = false;
        if (set) {
          set.delete(authed);
          if (set.size === 0) {
            this.socketsByPrincipal.delete(closedPrincipalId);
            wentOffline = true;
          }
        }
        authed = null;
        if (wentOffline) {
          for (const cid of this.store.listPrincipalChannelIds(closedPrincipalId)) {
            this.broadcastToChannel(cid, {
              type: "agent_offline",
              channel_id: cid,
              agent_id: closedPrincipalId,
            });
          }
        }
      }
    });
  }
}
