const CHANNEL_PREFIX = "agentchat:channel:";
const THREAD_SEPARATOR = ":thread:";
const UNSAFE_ID_CHAR_RE = /[\x00-\x1f\x7f]/;

function cleanConversationSegment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || UNSAFE_ID_CHAR_RE.test(trimmed) || trimmed.includes(THREAD_SEPARATOR)) {
    return null;
  }
  return trimmed;
}

export function buildConversationId(channelId: string, threadId?: string | number | null) {
  const cleanChannel = typeof channelId === "string" ? channelId.trim() : "";
  if (!cleanChannel || UNSAFE_ID_CHAR_RE.test(cleanChannel) || cleanChannel.includes(THREAD_SEPARATOR)) {
    throw new Error("Invalid AgentChat channelId for conversation");
  }
  const base = `${CHANNEL_PREFIX}${cleanChannel}`;
  if (threadId === undefined || threadId === null || threadId === "") return base;
  const rawThread = String(threadId).trim();
  if (!rawThread) return base;
  if (UNSAFE_ID_CHAR_RE.test(rawThread) || rawThread.includes(THREAD_SEPARATOR)) {
    throw new Error("Invalid AgentChat threadId for conversation");
  }
  return `${base}${THREAD_SEPARATOR}${rawThread}`;
}

export function parseConversationId(conversationId: string) {
  if (typeof conversationId !== "string" || !conversationId.startsWith(CHANNEL_PREFIX)) return null;
  if (UNSAFE_ID_CHAR_RE.test(conversationId)) return null;

  const raw = conversationId.slice(CHANNEL_PREFIX.length);
  const separatorIndex = raw.indexOf(THREAD_SEPARATOR);

  if (separatorIndex === -1) {
    const channelId = cleanConversationSegment(raw);
    if (!channelId) return null;
    return { channelId, threadId: undefined as string | undefined };
  }

  const channelId = cleanConversationSegment(raw.slice(0, separatorIndex));
  if (!channelId) return null;

  const rest = raw.slice(separatorIndex + THREAD_SEPARATOR.length);
  if (rest.includes(THREAD_SEPARATOR)) return null;
  const threadTrimmed = rest.trim();
  return {
    channelId,
    threadId: threadTrimmed.length > 0 ? threadTrimmed : undefined,
  };
}
