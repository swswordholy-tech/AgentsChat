import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";

import { buildConversationId, parseConversationId } from "./conversation";

export const agentChatMessaging: ChannelMessagingAdapter = {
  normalizeTarget(raw) {
    if (typeof raw !== "string" || /[\x00-\x1f\x7f]/.test(raw)) return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },

  resolveInboundConversation(params) {
    if (!params || typeof params !== "object") return null;
    const rawCandidate = params.conversationId ?? params.to ?? params.from;
    if (typeof rawCandidate !== "string") return null;
    const trimmed = rawCandidate.trim();
    if (!trimmed || /[\x00-\x1f\x7f]/.test(trimmed)) return null;

    // Accept an already-encoded `agentchat:channel:...` ID without double-prefixing.
    const existing = parseConversationId(trimmed);
    const baseChannelId = existing ? existing.channelId : trimmed;
    const effectiveThread = params.threadId ?? existing?.threadId;

    try {
      const conversationId = buildConversationId(baseChannelId, effectiveThread);
      const hasThread =
        effectiveThread !== undefined &&
        effectiveThread !== null &&
        String(effectiveThread).trim().length > 0;
      return {
        conversationId,
        parentConversationId: hasThread ? buildConversationId(baseChannelId) : undefined,
      };
    } catch {
      return null;
    }
  },

  resolveDeliveryTarget(params) {
    if (!params || typeof params !== "object") return null;
    const parsed =
      parseConversationId(params.conversationId) ??
      (params.parentConversationId ? parseConversationId(params.parentConversationId) : null);
    if (!parsed) return null;

    return {
      to: parsed.channelId,
      threadId: parsed.threadId,
    };
  },

  resolveSessionConversation(params) {
    if (!params || typeof params !== "object") return null;
    const parsed = parseConversationId(params.rawId);
    if (!parsed) return null;
    return {
      id: buildConversationId(parsed.channelId, parsed.threadId),
      threadId: parsed.threadId ?? null,
      baseConversationId: buildConversationId(parsed.channelId),
      parentConversationCandidates: parsed.threadId
        ? [buildConversationId(parsed.channelId)]
        : undefined,
    };
  },

  resolveSessionTarget(params) {
    return buildConversationId(params.id, params.threadId);
  },
};
