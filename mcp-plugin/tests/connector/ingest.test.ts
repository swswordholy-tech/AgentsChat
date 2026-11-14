import { describe, expect, test } from "bun:test";
import { MessageDedup } from "../../src/dedup.ts";
import { ingestAgentsChatFrame } from "../../connector/ingest.ts";

describe("ingestAgentsChatFrame — multiplex cursor vs shared dedup", () => {
  test("second identity still advances cursor when dedup already saw the message", () => {
    const dedup = new MessageDedup();
    const advanced: Array<{ botId: string; channelId?: string; ts?: string }> = [];
    const advanceCursor = (id: { botId: string }, channelId: string | undefined, timestamp: string | undefined) => {
      advanced.push({ botId: id.botId, channelId, ts: timestamp });
    };

    const frame = {
      id: "m-1",
      channel_id: "ch-1",
      timestamp: "2026-09-06T07:00:00.000Z",
      content: "@spiral-witty-limpet ping",
      sender_id: "user-1",
    };
    const a = { botId: "emerald", agentId: "emerald" };
    const b = { botId: "spiral", agentId: "spiral" };

    expect(ingestAgentsChatFrame(a, frame, { advanceCursor, dedup })).toBe(true);
    expect(ingestAgentsChatFrame(b, frame, { advanceCursor, dedup })).toBe(false); // shared dedup skips broadcast
    expect(advanced).toEqual([
      { botId: "emerald", channelId: "ch-1", ts: frame.timestamp },
      { botId: "spiral", channelId: "ch-1", ts: frame.timestamp },
    ]);
  });

  test("typing does not advance cursor or broadcast", () => {
    const dedup = new MessageDedup();
    const advanced: unknown[] = [];
    const advanceCursor = (...args: unknown[]) => { advanced.push(args); };
    const id = { botId: "spiral", agentId: "spiral" };
    expect(
      ingestAgentsChatFrame(
        id,
        { id: "t1", channel_id: "ch", timestamp: "2026-09-06T07:00:00.000Z", content: "__typing__", sender_id: "user" },
        { advanceCursor, dedup },
      ),
    ).toBe(false);
    expect(advanced).toEqual([]);
  });
});


test("DM dash/colon aliases isolate dedup per bot and filter self before peer delivery", () => {
  const a = { botId: "a", agentId: "agent-a" }, b = { botId: "b", agentId: "agent-b" };
  for (const channel_id of ["dm-room", "DM-room", "dm:room", "DM:room"]) {
    const advanced: string[] = [];
    const deps = { dedup: new MessageDedup(), advanceCursor: (id: { botId: string }) => { advanced.push(id.botId); } };
    const frame = { id: "shared", channel_id, sender_id: a.agentId, content: "hello", timestamp: "2026-11-14T00:00:00Z" };
    expect(ingestAgentsChatFrame(a, frame, deps)).toBe(false);
    expect(ingestAgentsChatFrame(b, frame, deps)).toBe(true);
    expect(ingestAgentsChatFrame(b, frame, deps)).toBe(false);
    expect(advanced).toEqual(["a", "b", "b"]);
    const other = { ...frame, id: "from-human", sender_id: "human" };
    expect(ingestAgentsChatFrame(a, other, deps)).toBe(true);
    expect(ingestAgentsChatFrame(b, other, deps)).toBe(true);
  }
});
