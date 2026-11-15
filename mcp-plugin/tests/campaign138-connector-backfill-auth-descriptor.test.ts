import { describe, expect, test } from "bun:test";
import {
  canonicalCursorTimestamp,
  planBackfill,
  safeCursorBotFile,
  selectChannelContextMessages,
} from "../connector/backfill.ts";
import { ingestAgentsChatFrame } from "../connector/ingest.ts";
import { makeToken, verifySignature, verifyToken } from "../connector/auth.ts";
import { buildDescriptor } from "../connector/descriptor.ts";
import { isTeamLeadSkillInvocation } from "../src/team-lead-skill.ts";
import { annotateTools, TOOL_ANNOTATIONS } from "../src/tool-annotations.ts";
import { MessageDedup } from "../src/dedup.ts";

describe("Campaign #138 KR3 — connector/backfill & ingest watermark-poisoning & prototype guards", () => {
  test("canonicalCursorTimestamp accepts valid ISO offsets/fractions and rejects non-ISO, rollover dates, and C1/U+2028", () => {
    expect(canonicalCursorTimestamp("2026-11-15T07:00:00Z")).toBe("2026-11-15T07:00:00.000000000Z");
    expect(canonicalCursorTimestamp("2026-11-15T15:00:00+08:00")).toBe("2026-11-15T07:00:00.000000000Z");
    expect(canonicalCursorTimestamp("zzzz-bad-ts")).toBeNull();
    expect(canonicalCursorTimestamp("2026-02-30T10:00:00Z")).toBeNull();
    expect(canonicalCursorTimestamp("2026-11-15T07:00:00Z\u2028")).toBeNull();
  });

  test("planBackfill & selectChannelContextMessages never poison cursor watermarks with non-ISO timestamps or own-__proto__ frames", () => {
    const poisonedOwnProto = JSON.parse(
      '{"__proto__":{"polluted":true},"id":"p1","timestamp":"2026-11-15T09:00:00Z","sender_id":"u1","content":"proto"}',
    );
    const msgs = [
      { id: "bad-high", timestamp: "zzzz-poison-watermark", sender_id: "u1", content: "garbage ts" },
      { id: "bad-cal", timestamp: "2026-02-30T10:00:00Z", sender_id: "u1", content: "rollover ts" },
      poisonedOwnProto,
      { id: "real-1", timestamp: "2026-11-15T08:00:00Z", sender_id: "u1", content: "first valid" },
      { id: "real-2", timestamp: "2026-11-15T08:00:01.250Z", sender_id: "u1", content: "second valid" },
    ];

    // Empty cursor must seed from real-2, NOT "zzzz-poison-watermark"
    const seeded = planBackfill(undefined, msgs, "agent-a");
    expect(seeded.seed).toBe("2026-11-15T08:00:01.250Z");
    expect(seeded.replay).toEqual([]);

    // Corrupted cursor on disk ("zzzz-corrupt") self-heals by re-seeding from newest valid timestamp
    const healed = planBackfill("zzzz-corrupt", msgs, "agent-a");
    expect(healed.seed).toBe("2026-11-15T08:00:01.250Z");
    expect(healed.replay).toEqual([]);

    // Valid cursor replays only valid chronological messages strictly after it
    const replayed = planBackfill("2026-11-15T07:59:59Z", msgs, "agent-a");
    expect(replayed.replay.map((m) => m.id)).toEqual(["real-1", "real-2"]);

    // Context selection with sinceTs drops garbage timestamps and own-__proto__ frames
    const ctx = selectChannelContextMessages(msgs, "2026-11-15T08:00:00Z");
    expect(ctx.map((m) => m.id)).toEqual(["real-2"]);
    expect(selectChannelContextMessages(msgs, "zzzz-bad-since")).toEqual([]);
  });

  test("ingestAgentsChatFrame ignores own-__proto__ frames and refuses to advance cursor on non-ISO timestamps", () => {
    const dedup = new MessageDedup();
    const advanced: Array<{ botId: string; channelId?: string; ts?: string }> = [];
    const deps = {
      dedup,
      advanceCursor: (id: { botId: string }, channelId: string | undefined, timestamp: string | undefined) => {
        advanced.push({ botId: id.botId, channelId, ts: timestamp });
      },
    };
    const identity = { botId: "bot-a", agentId: "agent-a" };

    const ownProtoFrame = JSON.parse(
      '{"__proto__":{"polluted":true},"id":"f0","channel_id":"ch-1","timestamp":"2026-11-15T08:00:00Z","content":"hi","sender_id":"u1"}',
    );
    expect(ingestAgentsChatFrame(identity, ownProtoFrame, deps)).toBe(false);
    expect(advanced).toEqual([]);

    // Garbage timestamp frame does not poison cursor
    expect(
      ingestAgentsChatFrame(
        identity,
        { id: "f1", channel_id: "ch-1", timestamp: "zzzz-bad-ts", content: "hi", sender_id: "u1" },
        deps,
      ),
    ).toBe(true);
    expect(advanced).toEqual([]);

    // Valid timestamp advances cursor as expected
    expect(
      ingestAgentsChatFrame(
        identity,
        { id: "f2", channel_id: "ch-1", timestamp: "2026-11-15T08:05:00Z", content: "ok", sender_id: "u1" },
        deps,
      ),
    ).toBe(true);
    expect(advanced).toEqual([{ botId: "bot-a", channelId: "ch-1", ts: "2026-11-15T08:05:00Z" }]);
  });

  test("safeCursorBotFile neutralizes Windows reserved device names, trailing dots, and non-string inputs while preserving toString", () => {
    for (const reserved of ["CON", "prn", "Aux", "nul", "COM1", "lpt9", "...", "CON."]) {
      expect(safeCursorBotFile("/tmp/cursors", reserved)).toBe("/tmp/cursors/last-seen-msg-ts-default.json");
    }
    expect(safeCursorBotFile("/tmp/cursors", {} as unknown as string)).toBe("/tmp/cursors/last-seen-msg-ts-default.json");
    expect(safeCursorBotFile("/tmp/cursors", "bot-1...")).toBe("/tmp/cursors/last-seen-msg-ts-bot-1.json");
    expect(safeCursorBotFile("/tmp/cursors", "toString")).toBe("/tmp/cursors/last-seen-msg-ts-toString.json");
  });
});

describe("Campaign #138 KR4 — connector/auth, descriptor, team-lead-skill & tool-annotations hardening", () => {
  test("verifyToken enforces canonical unpadded base64url, verifySignature guards non-array secrets, and makeToken rejects control-char secrets", () => {
    const secret = "sec-" + "0123456789abcdef0123456789ab";
    const tok = makeToken("gw-c138", secret, 0);
    expect(verifyToken(tok, [secret])).toBe("gw-c138");

    // Malleable padding / whitespace / standard-base64 variants must fail closed
    expect(verifyToken(`${tok}=`, [secret])).toBeNull();
    expect(verifyToken(` ${tok} `, [secret])).toBeNull();
    expect(verifyToken(`${tok}\n`, [secret])).toBeNull();
    expect(verifyToken(tok, null as unknown as string[])).toBeNull();
    expect(verifySignature("gw-c138:0", "a".repeat(64), "not-an-array" as unknown as string[])).toBe(false);

    expect(() => makeToken("gw-1", "bad\x85secret", 0)).toThrow();
    expect(() => makeToken("gw-1", "bad\u2028secret", 0)).toThrow();
    expect(() => makeToken("gw-1", "x".repeat(8193), 0)).toThrow();
  });

  test("buildDescriptor rejects null/array/own-__proto__/Object.prototype overrides and clones supported_ops", () => {
    expect(() => buildDescriptor(null as unknown as Record<string, unknown>)).toThrow();
    expect(() => buildDescriptor([] as unknown as Record<string, unknown>)).toThrow();
    expect(() => buildDescriptor(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(() => buildDescriptor({ toString: "bad" } as unknown as Record<string, unknown>)).toThrow();

    const callerOps = ["send", "typing"];
    const desc = buildDescriptor({ supported_ops: callerOps });
    callerOps.push("mutated_op");
    expect(desc.supported_ops).toEqual(["send", "typing"]);
  });

  test("isTeamLeadSkillInvocation rejects non-strings and U+2028/U+2029/C1, and annotateTools clones annotation objects", () => {
    expect(isTeamLeadSkillInvocation(null as unknown as string)).toBe(false);
    expect(isTeamLeadSkillInvocation("\u2028agentschat-team-lead")).toBe(false);
    expect(isTeamLeadSkillInvocation("agentschat-team-lead\u2029")).toBe(false);
    expect(isTeamLeadSkillInvocation("agentschat-team-lead\x85")).toBe(false);
    expect(isTeamLeadSkillInvocation("  执行 $agentschat-team-lead\n")).toBe(true);

    const annotated = annotateTools([{ name: "whoami" }, { name: "reply" }]);
    annotated[0]!.annotations.readOnlyHint = false;
    expect(TOOL_ANNOTATIONS.whoami?.readOnlyHint).toBe(true);
  });
});
