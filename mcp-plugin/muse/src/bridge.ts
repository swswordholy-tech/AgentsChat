import { MuseAgentChatClient } from "./client.ts";
import { buildContext, shouldDispatch } from "./policy.ts";
import { TypingHeartbeat } from "./typing.ts";
import type { ChannelKind, ChatMessage } from "./types.ts";

export interface MuseResponderContext {
  message: ChatMessage;
  channelKind?: ChannelKind;
  /** Bounded recent history for this channel, oldest first. */
  history: ChatMessage[];
  context: string;
}

/** Return a reply, or null to stay silent. The host (Muse) supplies this. */
export type MuseResponder = (ctx: MuseResponderContext) => Promise<string | null>;

export interface MuseBridgeOptions {
  agentId: string;
  displayName?: string;
  channels: string[];
  /** channel_id -> kind, when known (e.g. from REST channel listing). */
  channelKinds?: Record<string, ChannelKind>;
  responder: MuseResponder;
}

/**
 * Host-agnostic bridge: it owns the AgentsChat socket and the dispatch
 * policy, and delegates every actual reply to the Muse responder. That
 * separation is deliberate — this plugin must not invent a Muse model API;
 * the embedding Muse host passes in whatever responder it already has.
 */
export class MuseBridge {
  private readonly client: MuseAgentChatClient;
  private readonly activeReplies = new Map<string, number>();
  private readonly history = new Map<string, ChatMessage[]>();
  private readonly opts: MuseBridgeOptions;
  private readonly typing = new TypingHeartbeat((channelId) => this.client.sendTyping(channelId));

  constructor(client: MuseAgentChatClient, opts: MuseBridgeOptions) {
    this.client = client;
    this.opts = opts;
    this.client.onMessage((m) => this.handleMessage(m));
  }

  async start(): Promise<void> {
    await this.client.connect();
    for (const channelId of this.opts.channels) this.client.joinChannel(channelId);
  }

  /** Re-join channels after a socket reconnect (wire as onReconnect). */
  rejoin(): void {
    for (const channelId of this.opts.channels) this.client.joinChannel(channelId);
  }

  stop(): void {
    this.typing.stopAll();
    this.activeReplies.clear();
    this.client.disconnect();
  }

  get isConnected(): boolean {
    return this.client.isConnected;
  }

  /** Test seam: feed an inbound message without a socket. */
  async handleMessage(message: ChatMessage): Promise<void> {
    if (!message.channel_id || message.content === "__typing__") return;
    if (!this.history.has(message.channel_id) && this.history.size >= 200) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined) this.history.delete(oldest);
    }
    const list = this.history.get(message.channel_id) ?? [];
    list.push(message);
    this.history.set(message.channel_id, list.slice(-50));
    const kinds = this.opts.channelKinds;
    const kind = kinds && Object.prototype.hasOwnProperty.call(kinds, message.channel_id)
      ? kinds[message.channel_id]
      : undefined;
    if (!shouldDispatch(message, { agentId: this.opts.agentId, displayName: this.opts.displayName, channelKind: kind })) {
      return;
    }
    // Show "thinking" from the moment we decide to answer until the reply lands (even if responder throws).
    const active = this.activeReplies.get(message.channel_id) ?? 0;
    this.activeReplies.set(message.channel_id, active + 1);
    if (active === 0) this.typing.start(message.channel_id);
    try {
      const ctx: MuseResponderContext = {
        message,
        channelKind: kind,
        history: [...(this.history.get(message.channel_id) ?? [])],
        context: buildContext(this.history.get(message.channel_id) ?? [], this.opts.agentId),
      };
      const reply = await this.opts.responder(ctx);
      if (reply) {
        if (message.thread_id) {
          this.client.sendMessage(message.channel_id, reply, "text", message.thread_id);
        } else {
          this.client.sendMessage(message.channel_id, reply);
        }
      }
    } finally {
      const remaining = (this.activeReplies.get(message.channel_id) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeReplies.delete(message.channel_id);
        this.typing.stop(message.channel_id);
      } else {
        this.activeReplies.set(message.channel_id, remaining);
      }
    }
  }
}
