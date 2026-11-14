/**
 * Message de-duplication for the live-WS + reconnect-backfill race.
 *
 * The same message can arrive twice: once on the live socket and once via the
 * reconnect backfill REST replay. This Set-backed dedup is the sole guard that
 * keeps Claude Code from being notified twice. Extracted from server.ts so the
 * key derivation and the bounded eviction can be unit-tested directly.
 */

const MAX_DEDUP_ID_CHARS = 256;
const MAX_DEDUP_KEY_CHARS = 1024;
const MAX_DEDUP_CAPACITY = 1_000_000;

/** Stable identity for a message frame, or null if it lacks string id/channel. */
export function messageDedupKey(data: any): string | null {
  if (!data || typeof data.id !== "string" || typeof data.channel_id !== "string") return null;
  if (
    !data.id.trim() ||
    !data.channel_id.trim() ||
    data.id.length > MAX_DEDUP_ID_CHARS ||
    data.channel_id.length > MAX_DEDUP_ID_CHARS ||
    /[\x00-\x1f\x7f]/.test(data.id) ||
    /[\x00-\x1f\x7f]/.test(data.channel_id)
  ) {
    return null;
  }
  const safeChannel = data.channel_id.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  return `${safeChannel}:${data.id}`;
}

export class MessageDedup {
  private seen = new Set<string>();
  private readonly max: number;
  private readonly dropOnEvict: number;

  constructor(
    /** Evict once the set grows past this many keys. */
    max: number = 5000,
    /** How many oldest keys to drop on eviction (Set preserves insertion order). */
    dropOnEvict: number = 1000,
  ) {
    const safeMax = Number.isFinite(max) ? Math.min(MAX_DEDUP_CAPACITY, Math.max(1, Math.floor(max))) : 5000;
    const safeDrop = Number.isFinite(dropOnEvict)
      ? Math.min(safeMax, Math.max(1, Math.floor(dropOnEvict)))
      : Math.min(safeMax, 1000);
    this.max = safeMax;
    this.dropOnEvict = safeDrop;
  }

  /** Returns true if `key` was already delivered (skip), false if newly recorded. */
  recordOrSkip(key: string): boolean {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_DEDUP_KEY_CHARS || /[\x00-\x1f\x7f]/.test(key)) {
      return false;
    }
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > this.max) {
      const toDrop = Math.max(this.dropOnEvict, this.seen.size - this.max);
      let dropped = 0;
      for (const oldest of this.seen) {
        this.seen.delete(oldest);
        dropped += 1;
        if (dropped >= toDrop) break;
      }
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}
