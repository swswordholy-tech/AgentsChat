// Unit tests for message de-duplication (src/dedup.ts) — the sole guard against
// double-notifying on the live-WS + reconnect-backfill race. Run with `bun test`.
import { test, expect } from "bun:test";
import { messageDedupKey, MessageDedup } from "../src/dedup.ts";

test("messageDedupKey combines channel_id and id", () => {
  expect(messageDedupKey({ channel_id: "room-1", id: "m-9" })).toBe("room-1:m-9");
});

test("messageDedupKey is null for non-string id/channel or missing data", () => {
  expect(messageDedupKey({ channel_id: "room-1" })).toBe(null);
  expect(messageDedupKey({ id: "m-9" })).toBe(null);
  expect(messageDedupKey({ channel_id: 1, id: "m-9" })).toBe(null);
  expect(messageDedupKey(null)).toBe(null);
});

test("recordOrSkip: first delivery false, duplicate true regardless of source", () => {
  const d = new MessageDedup();
  expect(d.recordOrSkip("room-1:m-1")).toBe(false); // first time → record, deliver
  expect(d.recordOrSkip("room-1:m-1")).toBe(true); // seen → skip
  expect(d.recordOrSkip("room-1:m-2")).toBe(false); // different key
});

test("eviction drops the oldest keys and keeps the newest", () => {
  // max=5, drop 2 oldest on overflow.
  const d = new MessageDedup(5, 2);
  for (const k of ["k1", "k2", "k3", "k4", "k5"]) expect(d.recordOrSkip(k)).toBe(false);
  expect(d.size).toBe(5);
  // 6th push overflows (size 6 > 5) → evict oldest 2 (k1,k2), keep k3..k6
  expect(d.recordOrSkip("k6")).toBe(false);
  expect(d.size).toBe(4);
  // k1/k2 were evicted → re-recordable (not "seen")
  expect(d.recordOrSkip("k1")).toBe(false);
  // k4 survived → still deduped
  expect(d.recordOrSkip("k4")).toBe(true);
});

test("messageDedupKey escapes colon/backslash collisions and rejects blank strings", () => {
  const k1 = messageDedupKey({ channel_id: "a:b", id: "c" });
  const k2 = messageDedupKey({ channel_id: "a", id: "b:c" });
  const k3 = messageDedupKey({ channel_id: "a\\", id: ":c" });
  const k4 = messageDedupKey({ channel_id: "a", id: "\\:c" });
  expect(k1).not.toBeNull();
  expect(k2).not.toBeNull();
  expect(new Set([k1, k2, k3, k4]).size).toBe(4);
  expect(messageDedupKey({ channel_id: "   ", id: "m-1" })).toBeNull();
  expect(messageDedupKey({ channel_id: "room-1", id: "" })).toBeNull();
});

test("MessageDedup clamps invalid constructor bounds so overflow always evicts", () => {
  const d = new MessageDedup(2, 0);
  expect(d.recordOrSkip("a")).toBe(false);
  expect(d.recordOrSkip("b")).toBe(false);
  expect(d.recordOrSkip("c")).toBe(false);
  expect(d.size).toBe(2);
  expect(d.recordOrSkip("a")).toBe(false);
});

test("Campaign #112 KR3: rejects control chars and oversized IDs/keys and caps max capacity", () => {
  expect(messageDedupKey({ channel_id: "room\n1", id: "m-1" })).toBeNull();
  expect(messageDedupKey({ channel_id: "room-1", id: "m\x001" })).toBeNull();
  expect(messageDedupKey({ channel_id: "r".repeat(257), id: "m-1" })).toBeNull();
  expect(messageDedupKey({ channel_id: "room-1", id: "m".repeat(257) })).toBeNull();

  const d = new MessageDedup(999_999_999, 10);
  expect(d.recordOrSkip("bad\nkey")).toBe(false);
  expect(d.recordOrSkip("k".repeat(1025))).toBe(false);
  expect(d.size).toBe(0);
});

test("Campaign #121 KR3: rejects dot, double-dot, reserved prototype IDs, and own-__proto__ payloads", () => {
  for (const bad of [".", "..", "__proto__", "constructor", "prototype", "__PROTO__"]) {
    expect(messageDedupKey({ channel_id: bad, id: "m-1" })).toBeNull();
    expect(messageDedupKey({ channel_id: "room-1", id: bad })).toBeNull();
  }
  const protoPayload = JSON.parse('{"__proto__":{"polluted":1},"channel_id":"room-1","id":"m-1"}');
  expect(messageDedupKey(protoPayload)).toBeNull();
});
