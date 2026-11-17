import type { ChannelKind, ChatMessage } from "./types.ts";

/**
 * Muse routing policy, mirroring the OpenClaw plugin's mention policy so a
 * Muse bot behaves the same way in AgentsChat as other native channel bots:
 *
 * - direct messages always dispatch (no mention needed)
 * - group/project messages dispatch only when the bot is @mentioned
 * - the bot never dispatches its own messages
 * - history/context given to the responder is bounded, so one noisy
 *   channel cannot blow up the prompt
 */

export const MAX_HISTORY_MESSAGES = 50;
export const MAX_CONTEXT_BYTES = 15_000;
export const MAX_MESSAGE_BYTES = 2_000;

export function isMentioned(content: string, agentId: string, displayName?: string): boolean {
  if (typeof content !== "string") return false;
  const haystack = content.toLowerCase();
  // "muse" is the public name of this agent; accept a bare @muse mention too.
  const names = [agentId, displayName, "muse"]
    .filter((name): name is string => typeof name === "string" && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(name) && name.trim().length > 0)
    .map((name) => `@${name.trim().toLowerCase()}`);
  return names.some((name) => {
    let index = haystack.indexOf(name);
    while (index !== -1) {
      const before = haystack[index - 1];
      const afterCodePoint = haystack.codePointAt(index + name.length);
      const after = afterCodePoint === undefined ? "" : String.fromCodePoint(afterCodePoint);
      if ((!before || !/[a-z0-9@]/i.test(before)) &&
          (!after || !/[\p{L}\p{N}\p{M}_-]/u.test(after))) return true;
      index = haystack.indexOf(name, index + 1);
    }
    return false;
  });
}

export function shouldDispatch(
  message: ChatMessage,
  opts: { agentId: string; displayName?: string; channelKind?: ChannelKind },
): boolean {
  if (!message || typeof message !== "object" || typeof message.content !== "string") return false;
  if (message.sender_id === opts.agentId) return false;
  if (opts.channelKind === "direct") return true;
  // Unknown kind: be conservative and require a mention, except when the
  // message looks like a DM (server may omit channel_type on DMs).
  if (!opts.channelKind && typeof message.channel_id === "string" && /^dm[-:]/i.test(message.channel_id)) return true;
  if (Array.isArray(message.mentioned_ids) && Boolean(opts.agentId) && message.mentioned_ids.includes(opts.agentId)) {
    return true;
  }
  return isMentioned(message.content, opts.agentId, opts.displayName);
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (typeof text !== "string" || maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && low < text.length &&
      text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff &&
      text.charCodeAt(low) >= 0xdc00 && text.charCodeAt(low) <= 0xdfff) low -= 1;
  return text.slice(0, low);
}

/** Build the bounded context block handed to the responder. */
export function buildContext(messages: ChatMessage[], agentId: string): string {
  // Walk newest-first so the cap keeps the most recent messages, then
  // restore chronological order for the responder.
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines: string[] = [];
  let bytes = 0;
  for (const m of [...recent].reverse()) {
    const sender = typeof m.sender_id === "string"
      ? m.sender_id.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").slice(0, 128)
      : "unknown";
    const line = `${sender}: ${truncateToBytes(m.content, MAX_MESSAGE_BYTES)}\n`;
    const lineBytes = new TextEncoder().encode(line).length;
    if (bytes + lineBytes > MAX_CONTEXT_BYTES) break;
    bytes += lineBytes;
    lines.push(line);
  }
  void agentId;
  return lines.reverse().join("");
}
