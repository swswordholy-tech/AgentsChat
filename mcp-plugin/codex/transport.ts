import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { BridgeConfig } from "./config.ts";
import { HeartbeatMonitor } from "../src/heartbeat.ts";
import { resolveDrainReconnectDelay } from "../src/reconnect.ts";
import { InboxSync } from "./inbox-sync.ts";

function safeChannel(channel: unknown): channel is string {
  return typeof channel === "string" && channel.trim().length > 0 && channel === channel.trim() && channel.length <= 128 &&
    !/[.\/\\\x00-\x1f\x7f]/.test(channel) && !/^(?:__proto__|constructor|prototype)$/i.test(channel);
}
function requireChannel(channel: unknown): asserts channel is string {
  if (!safeChannel(channel)) throw new Error("Invalid AgentsChat channel");
}
function apiUrl(path: string, base: string): URL {
  const invalid = () => new Error("Invalid AgentsChat API path");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\x00-\x1f\x7f\\]/.test(path)) throw invalid();
  try {
    const pathname = path.split(/[?#]/, 1)[0]!;
    const decoded = decodeURIComponent(pathname);
    if ([pathname, decoded].some(value => value.split("/").includes("..")) || /[\x00-\x1f\x7f\\]/.test(decoded)) throw invalid();
    const origin = new URL(base).origin, resolved = new URL(path, base);
    if (resolved.origin !== origin) throw invalid();
    return resolved;
  } catch { throw invalid(); }
}

export class AgentsChatTransport {
  private socket?: WebSocket;
  private authenticated = false;
  private typing = new Map<string, ReturnType<typeof setInterval>>();
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat?: HeartbeatMonitor;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  private delay = 1000;
  private inboxSync?: InboxSync;
  private syncTimer?: ReturnType<typeof setInterval>;
  constructor(private config: BridgeConfig, private receive: (m: unknown) => void, private log: (s: string) => void = console.error,
    recover?: (m: unknown) => boolean, private syncIntervalMs = 60_000) {
    this.syncIntervalMs = Number.isFinite(syncIntervalMs) && syncIntervalMs > 0
      ? Math.min(Math.floor(syncIntervalMs), 2_147_483_647) : 60_000;
    if (recover) this.inboxSync = new InboxSync(config.stateDir, path => this.api(path), recover,
      () => !this.closed && this.authenticated, log);
  }
  async api(path: string, body?: unknown) {
    const resolved = apiUrl(path, this.config.apiUrl);
    let response: Response;
    try {
      response = await fetch(resolved, { method: body ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error("AgentsChat request failed or timed out"); }
    if (!response.ok) {
      try { await response.body?.cancel?.(); } catch { /* Preserve the HTTP error. */ }
      throw new Error(`AgentsChat HTTP ${response.status}`);
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response body");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) {
          try { await reader.cancel(); } catch { /* Preserve the invalid-response error. */ }
          throw new Error("Response too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      const value = JSON.parse(text + decoder.decode());
      if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) throw new Error("Invalid JSON prototype key");
      return value;
    } catch { throw new Error("Invalid AgentsChat response"); }
    finally { reader?.releaseLock(); }
  }
  setTyping(channel: string, active: boolean) {
    requireChannel(channel);
    clearInterval(this.typing.get(channel)); this.typing.delete(channel);
    if (!active || this.closed) return;
    if (this.typing.size >= 64) throw new Error("AgentsChat typing limit reached");
    const pulse = () => {
      if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
        try { this.socket.send(JSON.stringify({ type: "typing", channel_id: channel, sender_id: this.config.agentId, cross_pod: true })); }
        catch { /* The socket may close between the state check and send. */ }
      }
    };
    pulse();
    const typingTimer = setInterval(pulse, 2000);
    typingTimer.unref?.();
    this.typing.set(channel, typingTimer);
  }
  private clearTyping() {
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
  }
  private rejectPending() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("AgentsChat acknowledgement unavailable")); }
    this.pending.clear();
  }
  async send(channel: string, text: string) {
    requireChannel(channel);
    // Use the authenticated connection and wait for the server's delivery ACK.
    // Never fall back after an attempted send: an ACK may have been lost.
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
      if (this.pending.size >= 256) throw new Error("AgentsChat pending message limit reached");
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("AgentsChat acknowledgement timed out")); }, 15000);
        timer.unref?.();
        this.pending.set(id, { resolve, reject, timer });
        try { this.socket!.send(JSON.stringify({ type: "message", id, channel_id: channel,
          sender_id: this.config.agentId, sender_type: "agent", content_type: "text", content: text }), error => {
          if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("AgentsChat socket send failed")); }
        }); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error("AgentsChat socket send failed")); }
      });
      return;
    }
    await this.api(`/api/channels/${encodeURIComponent(channel)}/messages`, {
      sender_id: this.config.agentId, content_type: "text", content: text,
    });
  }
  start() {
    if (this.closed) return;
    clearTimeout(this.retry); this.retry = undefined;
    clearInterval(this.syncTimer); this.syncTimer = undefined;
    this.heartbeat?.stop(); this.heartbeat = undefined;
    this.authenticated = false; this.clearTyping(); this.rejectPending();
    const previous = this.socket; this.socket = undefined;
    previous?.terminate();
    const socket = new WebSocket(this.config.wsUrl, { maxPayload: 1_048_576, handshakeTimeout: 15_000 });
    this.socket = socket;
    const current = () => !this.closed && this.socket === socket;
    const send = (value: unknown) => {
      if (current() && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify(value)); } catch { /* A concurrent close is handled below. */ }
      }
    };
    const join = (channel: string) => {
      if (safeChannel(channel) && (!this.config.channels.length || this.config.channels.includes(channel))) {
        this.inboxSync?.watch(channel);
        send({ type: "join_channel", channel_id: channel, agent_id: this.config.agentId });
      }
    };
    this.heartbeat = new HeartbeatMonitor({ getReadyState: () => socket.readyState,
      sendPing: () => send({ type: "ping" }), reconnect: () => socket.terminate() }, 15_000, 45_000, 30_000);
    this.heartbeat.start();
    socket.on("open", () => send({ type: "auth", agent_id: this.config.agentId, token: this.config.token, capabilities: ["chat", "codex"] }));
    socket.on("message", raw => {
      if (!current()) return;
      let data: any; try { data = JSON.parse(String(raw)); } catch { return; }
      if (!data || typeof data !== "object" || Array.isArray(data) || Object.hasOwn(data, "__proto__")) return;
      if (data.type !== "auth_error") this.heartbeat?.receivedPong();
      if (data.type === "auth_ok") {
        this.authenticated = true; this.delay = 1000; this.log(`AgentsChat connected as ${this.config.agentId}`);
        if (this.inboxSync && !this.syncTimer) {
          this.syncTimer = setInterval(() => { void this.inboxSync!.sync(); }, this.syncIntervalMs);
          this.syncTimer.unref?.();
        }
        void this.api("/api/channels/mine").then((body: any) => {
          if (!current()) return;
          const channels = Array.isArray(body) ? body : body.channels;
          if (!Array.isArray(channels)) throw new Error("Invalid membership response");
          const ids = channels.map((c: any) => c?.id ?? c?.channel_id).filter((id: any) => safeChannel(id) &&
            (!this.config.channels.length || this.config.channels.includes(id)));
          this.inboxSync?.memberships(ids);
          for (const id of ids) join(id);
          void this.inboxSync?.sync();
        }).catch(() => { if (current()) { this.log("Membership sync failed; reconnecting"); socket.terminate(); } });
      } else if (data.type === "message_ack") {
        const id = data.message_id ?? data.id, pending = this.pending.get(id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(); }
      } else if (data.type === "channel_created" && typeof data.channel_id === "string") join(data.channel_id);
      else if (["message", "thread_reply"].includes(data.type)) this.receive(data);
      else if (data.type === "shard_moved" || data.type === "please_reconnect") {
        this.delay = resolveDrainReconnectDelay(data);
        socket.terminate();
      } else if (data.type === "auth_error") {
        this.log("AgentsChat authentication rejected; check profile token (backing off 30s)");
        this.delay = 30_000;
        socket.close();
      } else if (data.type === "error") this.log("AgentsChat returned an error; check account and channel permissions");
    });
    socket.on("error", () => this.log("AgentsChat socket error"));
    socket.on("close", () => {
      if (!current()) return;
      clearInterval(this.syncTimer); this.syncTimer = undefined;
      this.authenticated = false; this.clearTyping(); this.rejectPending(); this.heartbeat?.stop(); this.log("AgentsChat disconnected; reconnecting with history reconciliation");
      this.retry = setTimeout(() => this.start(), this.delay);
      this.retry.unref?.();
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }
  stop() {
    this.closed = true; this.authenticated = false; this.clearTyping(); this.rejectPending();
    clearTimeout(this.retry); this.retry = undefined;
    clearInterval(this.syncTimer); this.syncTimer = undefined;
    this.heartbeat?.stop(); this.heartbeat = undefined;
    const socket = this.socket; this.socket = undefined;
    socket?.terminate();
  }
}
