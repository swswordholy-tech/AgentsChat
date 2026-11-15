import type { ChatMessage } from "./agentchat-protocol";

import { buildConversationId } from "./conversation";
import { getMentionCursor, setMentionCursor } from "./state";
import type { AgentChatInboundPolicyResult, AgentChatResolvedAccount } from "./types";

const HISTORY_LIMIT = 50;
const MAX_CONTEXT_BYTES = 15_000;
const MAX_PER_MESSAGE_CHARS = 2_000;
const TRUNCATED_SUFFIX = " …[truncated]";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDirectChannel(channelId: string) {
  return /^dm[-:]/i.test(channelId);
}

function getThreadId(message: ChatMessage): string | number | undefined {
  const value = (message as ChatMessage & { thread_id?: string | number | null }).thread_id;
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function isBlockedMetadataOrLinkLocalHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  return (
    host === "0.0.0.0" ||
    host === "[::]" ||
    /^\[(?:0+:){7}0+\]$/.test(host) ||
    host === "100.100.100.200" ||
    host === "[fd00:ec2::254]" ||
    /^\[fd00:ec2:(?:0+:){0,5}254\]$/i.test(host) ||
    host === "metadata" ||
    host === "instance-data" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata.goog" ||
    host.endsWith(".metadata.goog") ||
    /^169\.254\./.test(host) ||
    /^\[fe[89ab][0-9a-f]:/i.test(host) ||
    /^\[(?:::(?:ffff:(?:0:)?)?|(?:0+:){2,6}(?:ffff:(?:0+:)?|0+:)?)(?:a9fe:[0-9a-f]+|169\.254\.\d+\.\d+|6464:64c8|100\.100\.100\.200|0+:0+|0\.0\.0\.0)\]$/i.test(
      host,
    )
  );
}

function deriveRestBaseUrl(wsUrl: string) {
  if (wsUrl !== wsUrl.trim() || /["<>\\\x00-\x20\x7f]/.test(wsUrl)) {
    throw new Error("Invalid AgentChat history WebSocket URL");
  }
  const url = new URL(wsUrl);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.port === "0") {
    throw new Error("AgentChat history requires a WebSocket URL without credentials");
  }
  // URL canonicalizes numeric IPv4 and IPv4-in-IPv6 spellings before this check.
  if (isBlockedMetadataOrLinkLocalHost(url.hostname)) {
    throw new Error("AgentChat history cannot use metadata or link-local hosts");
  }
  if (url.protocol !== "wss:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("AgentChat history requires wss for remote hosts");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.endsWith("/ws")
    ? url.pathname.slice(0, -3) || "/"
    : url.pathname || "/";
  return url.toString().replace(/\/$/, "");
}

function extractMentionAliases(account: AgentChatResolvedAccount) {
  return Array.from(
    new Set(
      [account.agentId, account.accountId, account.name]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function isMentioned(content: string, account: AgentChatResolvedAccount) {
  const aliases = extractMentionAliases(account);
  if (aliases.some((alias) => content.includes(`@${alias}`))) return true;

  const idCandidates = [account.agentId, account.accountId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return idCandidates.some((id) => {
    const idEsc = escapeRegExp(id);
    const displayMentionRe = new RegExp(`@[^(\n]+\\(${idEsc}\\)`);
    return displayMentionRe.test(content);
  });
}

const HISTORY_FETCH_TIMEOUT_MS = 10_000;
const MAX_HISTORY_BYTES = 512 * 1024;

function scrubHistoryError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:https?|wss?):\/\/)([^/\s"'<>\\@]+@)/gi, "$1[redacted]@")
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>\\]+/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /(?:ac_|mcp_(?:at|rt|code)_|agent_key_|sk-|rk_(?:live|test)_|whsec_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|AKIA|ASIA)[A-Za-z0-9_-]+/gi,
      "[redacted]",
    )
    .replace(/[\x00-\x1f\x7f]/g, "");
}

async function readHistoryJson(response: Response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HISTORY_BYTES) throw new Error("AgentChat history exceeds byte limit");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      throw new Error("Invalid AgentChat history JSON object");
    }
    return parsed;
  } catch (error) {
    // Do not let a stalled producer delay the single-message fallback.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchChannelHistory(params: {
  wsUrl: string;
  token?: string;
  channelId: string;
  after?: string;
}) {
  const rawChannelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
  if (
    !rawChannelId ||
    rawChannelId.length > 256 ||
    rawChannelId === "." ||
    rawChannelId === ".." ||
    /^(?:__proto__|constructor|prototype)$/i.test(rawChannelId) ||
    /[\x00-\x1f\x7f]/.test(rawChannelId)
  ) {
    throw new Error("Invalid AgentChat channel ID for history fetch");
  }
  const baseUrl = deriveRestBaseUrl(params.wsUrl);
  const search = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (params.after) search.set("after", params.after);
  const response = await fetch(
    `${baseUrl}/api/channels/${encodeURIComponent(rawChannelId)}/messages?${search.toString()}`,
    {
      redirect: "error",
      headers: params.token ? { Authorization: `Bearer ${params.token}` } : {},
      signal: AbortSignal.timeout(HISTORY_FETCH_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}: failed to fetch AgentChat history`);
  }
  const payload = (await readHistoryJson(response)) as { messages?: ChatMessage[] };
  return payload.messages ?? [];
}

function clipMessageContent(content: string) {
  return content.length > MAX_PER_MESSAGE_CHARS
    ? `${content.slice(0, MAX_PER_MESSAGE_CHARS)}${TRUNCATED_SUFFIX}`
    : content;
}

function buildContextPrefix(messages: ChatMessage[]) {
  let totalBytes = 0;
  const trimmed: Array<ChatMessage & { content: string }> = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const clipped = clipMessageContent(message.content ?? "");
    const size = Buffer.byteLength(clipped, "utf8");
    if (totalBytes + size > MAX_CONTEXT_BYTES) break;
    totalBytes += size;
    trimmed.unshift({ ...message, content: clipped });
  }

  if (trimmed.length === 0) return "";

  const truncated = trimmed.length < messages.length;
  const note = truncated
    ? `[频道上下文 - 最近 ${trimmed.length} 条消息（更早的已截断保护上下文窗口）]`
    : `[频道上下文 - 自上次 @mention 以来 ${trimmed.length} 条消息]`;
  const context = trimmed.map((message) => `${message.sender_id}: ${message.content}`).join("\n");
  return `${note}\n${context}\n\n[你被 @mention 了，请回复]\n`;
}

function filterHistory(params: {
  messages: ChatMessage[];
  currentMessage: ChatMessage;
  threadId?: string | number;
}) {
  return params.messages.filter((message) => {
    if (message.id === params.currentMessage.id) return false;
    if (message.content === "__typing__") return false;

    if (params.threadId !== undefined) {
      const threadId = getThreadId(message);
      if (threadId !== undefined && String(threadId) !== String(params.threadId)) return false;
    }

    return true;
  });
}

export async function buildInboundPolicy(params: {
  account: AgentChatResolvedAccount;
  accountId: string;
  message: ChatMessage;
  log?: (level: "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;
}): Promise<AgentChatInboundPolicyResult> {
  const { account, accountId, message } = params;
  const rawBody = message.content ?? "";
  const threadId = getThreadId(message);
  const conversationId = buildConversationId(message.channel_id, threadId);
  const isDirect = isDirectChannel(message.channel_id);

  if ((account.agentId && message.sender_id === account.agentId) ||
      (!isDirect && !isMentioned(rawBody, account))) {
    return {
      shouldDispatch: false,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    };
  }

  if (isDirect) {
    return {
      shouldDispatch: true,
      bodyForAgent: rawBody,
      rawBody,
      commandBody: rawBody,
    };
  }

  const lastMentionTs = getMentionCursor(accountId, conversationId);
  let prefix = "";

  try {
    const history = await fetchChannelHistory({
      wsUrl: account.wsUrl,
      token: account.token,
      channelId: message.channel_id,
      after: lastMentionTs,
    });
    const filtered = filterHistory({ messages: history, currentMessage: message, threadId });
    prefix = buildContextPrefix(filtered);
  } catch (error) {
    params.log?.("warn", "AgentChat history fetch failed; falling back to single-message dispatch", {
      accountId,
      channelId: message.channel_id,
      messageId: message.id,
      error: scrubHistoryError(error),
    });
  }

  if (typeof message.timestamp === "string" && message.timestamp.trim()) {
    setMentionCursor(accountId, conversationId, message.timestamp);
  }
  return {
    shouldDispatch: true,
    bodyForAgent: prefix ? `${prefix}${message.sender_id}: ${rawBody}` : rawBody,
    rawBody,
    commandBody: rawBody,
  };
}
