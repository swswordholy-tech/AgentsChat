/**
 * Reconnect backfill plan — same contract as MCP Task #119:
 *   empty cursor → seed from newest, do NOT replay (hours-old DMs/@s are not live)
 *   existing cursor → replay messages strictly after it, oldest first
 *
 * Timestamp comparison uses the same padded-ISO cursor as the MCP path so
 * lexical `>` matches chronology (whole-second vs fractional).
 */
import { join } from "node:path";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";
import { serverLoopTick, type AgentsChatMessage } from "./normalize.ts";

export type BackfillMsg = AgentsChatMessage;

const CANONICAL_CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/;
const RESERVED_CURSOR_BOT_NAMES = /^(?:__proto__|constructor|prototype|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function canonicalCursorTimestamp(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) return null;
  const norm = normalizeTimestampForCursor(raw, "after");
  return typeof norm === "string" && CANONICAL_CURSOR_TS_RE.test(norm) ? norm : null;
}

function isPlainMessageRecord(m: unknown): m is BackfillMsg {
  return Boolean(
    m &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      !Object.prototype.hasOwnProperty.call(m, "__proto__"),
  );
}

function compareNormalizedTimestamps(aRaw: unknown, bRaw: unknown): number {
  const aNorm = canonicalCursorTimestamp(aRaw) ?? "";
  const bNorm = canonicalCursorTimestamp(bRaw) ?? "";
  return aNorm < bNorm ? -1 : aNorm > bNorm ? 1 : 0;
}

export function planBackfill(
  after: string | undefined,
  msgs: BackfillMsg[],
  agentId: string,
): { seed?: string; replay: BackfillMsg[] } {
  const list = Array.isArray(msgs) ? msgs : [];
  const afterTs = canonicalCursorTimestamp(after);
  if (!afterTs) {
    let newestRaw = "";
    let newestNorm = "";
    for (const m of list) {
      if (!isPlainMessageRecord(m) || typeof m.content !== "string" || m.content === "__typing__") continue;
      const raw = typeof m.timestamp === "string" ? m.timestamp : "";
      const norm = canonicalCursorTimestamp(raw);
      if (!norm) continue;
      if (norm > newestNorm) {
        newestNorm = norm;
        newestRaw = raw;
      }
    }
    return newestRaw ? { seed: newestRaw, replay: [] } : { replay: [] };
  }
  const replay = list.filter((m) => {
    if (!isPlainMessageRecord(m) || typeof m.content !== "string" || m.content === "__typing__") return false;
    if (m.sender_id === agentId && !serverLoopTick(m)) return false;
    const msgTs = canonicalCursorTimestamp(m.timestamp);
    return msgTs !== null && msgTs > afterTs;
  });
  replay.sort((a, b) => compareNormalizedTimestamps(a.timestamp, b.timestamp));
  return { replay };
}

/**
 * Select up to 10 chronological channel context messages strictly after `sinceTs`
 * (excluding typing placeholders and `excludeId`), using padded ISO comparison so
 * whole-second (`...Z`) and fractional (`....500Z`) timestamps never invert order.
 */
export function selectChannelContextMessages(
  msgs: BackfillMsg[],
  sinceTs?: string,
  excludeId?: string,
): BackfillMsg[] {
  const list = Array.isArray(msgs) ? msgs : [];
  const filtered = list
    .filter(
      (m) =>
        isPlainMessageRecord(m) &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        m.content !== "__typing__" &&
        (!excludeId || m.id !== excludeId),
    )
    .sort((a, b) => compareNormalizedTimestamps(a.timestamp, b.timestamp));
  if (!sinceTs) return filtered.slice(-10);
  const normSince = canonicalCursorTimestamp(sinceTs);
  if (!normSince) return [];
  return filtered
    .filter((m) => {
      const norm = canonicalCursorTimestamp(m.timestamp);
      return norm !== null && norm > normSince;
    })
    .slice(-10);
}

/**
 * Sanitize `botId` when building per-bot cursor filenames so path separators,
 * `..` traversal segments, or Windows-invalid filename characters cannot escape
 * `cursorDir` or fail persistence while keeping standard agent IDs unchanged.
 */
export function safeCursorBotFile(cursorDir: string, botId: string): string {
  const raw = typeof botId === "string" && botId.trim() ? botId : "default";
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.+$/, "")
    .replace(/\.{2,}/g, "_");
  const safeId =
    cleaned && !RESERVED_CURSOR_BOT_NAMES.test(cleaned)
      ? cleaned.slice(0, 128)
      : "default";
  return join(cursorDir, `last-seen-msg-ts-${safeId}.json`);
}
