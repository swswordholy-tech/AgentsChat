/**
 * Normalize an ISO-8601 timestamp for lexical cursor comparison.
 *
 * The reconnect backfill compares timestamps as strings (`msgTs > afterTs`).
 * For that to match chronological order:
 * 1. Non-UTC numeric offsets (`+08:00`, `-05:00`) and lowercase `z` are converted
 *    to canonical UTC `YYYY-MM-DDTHH:mm:ss.<9digits>Z` without losing sub-millisecond
 *    fractional precision;
 * 2. Fractional seconds are padded (`0` for `"after"`, `9` for `"before"`) OR
 *    truncated (`>9` digits → 9 digits) to a fixed 9 digits, including whole-second
 *    timestamps, so `'.'` (0x2E) < `'Z'` (0x5A) never inverts ordering.
 */
const ISO_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:\d{2})$/;

function isValidCalendarDateTime(datePart: string, timePart: string, tzPart: string): boolean {
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(5, 7));
  const day = Number(datePart.slice(8, 10));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(3, 5));
  const second = Number(timePart.slice(6, 8));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maxDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > maxDay) return false;
  if (tzPart !== "Z" && tzPart !== "z") {
    const offHour = Number(tzPart.slice(1, 3));
    const offMin = Number(tzPart.slice(4, 6));
    if (offHour > 23 || offMin > 59) return false;
  }
  return true;
}

export function normalizeTimestampForCursor(
  ts: string | undefined,
  mode: "before" | "after",
): string | undefined {
  if (!ts || typeof ts !== "string" || ts.length > 128) return ts;
  if (/[\x00-\x1f\x7f]/.test(ts)) return undefined;
  if (mode !== "before" && mode !== "after") return ts;
  const padChar = mode === "before" ? "9" : "0";
  const trimmed = ts.trim();

  const m = trimmed.match(ISO_OFFSET_RE);
  if (m) {
    const datePart = m[1]!;
    const timePart = m[2]!;
    const rawFrac = m[3] ?? "";
    const tzPart = m[4]!;
    if (!isValidCalendarDateTime(datePart, timePart, tzPart)) return ts;
    const frac9 =
      rawFrac.length === 9
        ? rawFrac
        : rawFrac.length > 9
          ? rawFrac.slice(0, 9)
          : rawFrac + padChar.repeat(9 - rawFrac.length);

    if (tzPart === "Z" || tzPart === "z") {
      return `${datePart}T${timePart}.${frac9}Z`;
    }

    const wholeUtcMs = Date.parse(`${datePart}T${timePart}${tzPart}`);
    if (Number.isFinite(wholeUtcMs)) {
      const iso = new Date(wholeUtcMs).toISOString();
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) {
        return `${iso.slice(0, 19)}.${frac9}Z`;
      }
    }
  }

  return ts;
}
