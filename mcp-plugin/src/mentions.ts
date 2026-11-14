/**
 * @mention gate — does `content` mention `agentId`?
 *
 * Matches two shapes:
 *   1. `@<agentId>`                      (bare id)
 *   2. `@<displayName>(<agentId>)`       (display-name form)
 *
 * The second clause requires an `@<name>` immediately before `(<id>)`, so it
 * does NOT fire on an incidental `(<id>)` substring such as the system line
 * "User joined: name (acc_xyz)". That was a real bug (msg:fc8b9b1a): a loose
 * `content.includes("(" + id + ")")` made an agent process messages it wasn't
 * mentioned in and burn its context window.
 *
 * Extracted from server.ts so it can be unit-tested without loading the
 * side-effecting server entrypoint (which opens a WebSocket on import).
 */
export function matchesMention(content: string, agentId: string): boolean {
  if (typeof content !== "string" || typeof agentId !== "string") return false;
  const trimmedId = agentId.trim();
  if (!content || !trimmedId || /[\x00-\x1f\x7f]/.test(trimmedId)) return false;
  const idEsc = trimmedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bareMentionRe = new RegExp(`(?<![A-Za-z0-9_])@${idEsc}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);
  if (bareMentionRe.test(content)) return true;
  const displayMentionRe = new RegExp(
    `(?<![A-Za-z0-9_])@[^\\s(@,:;<>"'\\x60\\n]+(?: [^\\s(@,:;<>"'\\x60\\n]+){0,4}\\(${idEsc}\\)`,
  );
  return displayMentionRe.test(content);
}
