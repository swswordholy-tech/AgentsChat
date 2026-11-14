/**
 * Normalize an agentschat message into the relay wire MessageEvent the gateway's
 * `_event_from_wire` rebuilds. The gateway reads `event.source` for the session
 * discriminators and `event.text`/`message_id`/`reply_to_message_id` for content.
 *
 * Highest-correctness concern (contract §3): the session discriminators.
 * agentschat has DMs (`dm-` prefixed channel ids) and group channels; there is no
 * guild/scope concept, so `scope_id` stays undefined and `chat_type` is `dm`/`group`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { clampTimerMs, isConnectorEntrypoint, loadIdentities } from "../../connector/run.ts";
import { toWireEvent, type WireEvent } from "../../connector/normalize.ts";

/** toWireEvent returns WireEvent | null; these tests assert the non-null cases. */
function must(msg: Parameters<typeof toWireEvent>[0]): WireEvent {
  const e = toWireEvent(msg, "agentschat");
  if (!e) throw new Error("expected a wire event, got null");
  return e;
}

const base = {
  id: "msg-1",
  channel_id: "welcome",
  sender_id: "human-1",
  sender_name: "Alice",
  content: "hello bot",
  timestamp: "2026-08-21T10:00:00.000Z",
};

describe("toWireEvent — source discriminators", () => {
  test("platform matches the descriptor's platform", () => {
    const e = must(base);
    expect(e.source.platform).toBe("agentschat");
  });

  test("a group channel maps to chat_type group", () => {
    const e = must(base);
    expect(e.source.chat_id).toBe("welcome");
    expect(e.source.chat_type).toBe("group");
  });

  test("a dm- prefixed channel maps to chat_type dm", () => {
    const e = must({ ...base, channel_id: "dm-abc123" });
    expect(e.source.chat_type).toBe("dm");
    expect(e.source.chat_id).toBe("dm-abc123");
  });

  test("carries the authentic author identity", () => {
    const e = must(base);
    expect(e.source.user_id).toBe("human-1");
    expect(e.source.user_name).toBe("Alice");
  });

  test("no scope/guild concept — scope_id is absent, not a wrong value", () => {
    const e = must(base);
    expect(e.source.scope_id).toBeUndefined();
  });
});

describe("toWireEvent — content + identity of the message itself", () => {
  test("text comes from content, message_id from id", () => {
    const e = must(base);
    expect(e.text).toBe("hello bot");
    expect(e.message_id).toBe("msg-1");
    expect(e.message_type).toBe("text");
  });

  test("a reply carries reply_to_message_id from reply_to or parent_id while keeping thread_id null", () => {
    const e = must({ ...base, reply_to: "msg-0" });
    expect(e.reply_to_message_id).toBe("msg-0");
    expect(e.source.thread_id).toBeNull();

    const threaded = must({ ...base, parent_id: "parent-42" });
    expect(threaded.reply_to_message_id).toBe("parent-42");
    expect(threaded.source.thread_id).toBeNull();
  });

  test("typing placeholders never become an event (returns null)", () => {
    expect(toWireEvent({ ...base, content: "__typing__" }, "agentschat")).toBeNull();
  });

  test("messages with no channel produce no event (fail closed, not a bogus session)", () => {
    expect(toWireEvent({ ...base, channel_id: "" }, "agentschat")).toBeNull();
  });
});


describe("connector input and startup hardening", () => {
  test("DM dash and colon aliases are case insensitive", () => {
    for (const channel_id of ["DM-abc", "dm:abc", "Dm:abc"]) {
      const event = must({ ...base, channel_id });
      expect(event.source.chat_type).toBe("dm");
      expect(event.source.chat_id).toBe(channel_id);
    }
    expect(must({ ...base, channel_id: "dm_notes" }).source.chat_type).toBe("group");
  });

  test("malformed messages never throw and non-string content becomes empty text", () => {
    for (const value of [null, undefined, false, 42, "message"]) {
      expect(toWireEvent(value as any)).toBeNull();
    }
    for (const content of [null, undefined, 0, 42, true, {}, [], ["__typing__"]]) {
      expect(must({ ...base, content } as any).text).toBe("");
    }
    expect(must({ ...base, content: "" }).text).toBe("");
  });

  test("timers retain defaults, minima and safe integer upper bound", () => {
    const configs = [[15000, 5000], [45000, 20000], [30000, 5000], [10000, 2000], [5000, 500]];
    for (const [fallback, min] of configs) {
      for (const raw of [undefined, "", "NaN", "Infinity", "-Infinity", "0", "-10", NaN]) {
        expect(clampTimerMs(raw, fallback, min)).toBe(fallback);
      }
      expect(clampTimerMs("1", fallback, min)).toBe(min);
      expect(clampTimerMs("25000.9", fallback, min)).toBe(Math.max(25000, min));
      for (const raw of ["2147483647", "2147483648", "1e30"]) {
        expect(clampTimerMs(raw, fallback, min)).toBe(2147483647);
      }
    }
    const ping = clampTimerMs("1e30", 15000, 5000);
    const pongMin = Math.min(2147483647, ping + 5000);
    expect(clampTimerMs("1", 45000, pongMin)).toBe(2147483647);
    expect(clampTimerMs("NaN", 45000, pongMin)).toBe(2147483647);
  });

  test("entry guard recognizes direct source and bundle execution", () => {
    for (const entry of ["/tmp/project/connector/run.ts", "/tmp/project/dist/connector.js"]) {
      const url = pathToFileURL(entry).href;
      expect(isConnectorEntrypoint(entry, url)).toBe(true);
      expect(isConnectorEntrypoint("/tmp/test.ts", url)).toBe(false);
      expect(isConnectorEntrypoint(undefined, url)).toBe(false);
      expect(isConnectorEntrypoint(undefined, url, true)).toBe(true);
    }
  });

  test("import starts no listeners, services or identity validation", () => {
    const env = { ...process.env, RELAY_IDENTITIES_FILE: "/nonexistent/identities.json" };
    const result = spawnSync(process.execPath, ["-e", `
      const before = [process.listenerCount("SIGHUP"), process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      await import(${JSON.stringify(new URL("../../connector/run.ts", import.meta.url).href)});
      const after = [process.listenerCount("SIGHUP"), process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("registered process listeners");
      console.log("imported");
    `], { env, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("imported");
    expect(result.stderr).toBe("");
  });

  test("identities file accepts regular files through 1 MiB and rejects unsafe paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-identities-"));
    const saved = process.env.RELAY_IDENTITIES_FILE;
    const row = { botId: "bot-a", token: "ac_fixture", gatewayId: "gateway-a", secret: "fixture" };
    const json = JSON.stringify([row]);
    try {
      const file = join(dir, "identities.json");
      writeFileSync(file, json.padEnd(1048576, " "));
      process.env.RELAY_IDENTITIES_FILE = file;
      expect(loadIdentities()).toEqual([{ ...row, agentId: "bot-a" }]);
      const link = join(dir, "link.json");
      symlinkSync(file, link);
      const fifo = join(dir, "pipe");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      for (const bad of [link, dir, fifo, join(dir, "missing")]) {
        process.env.RELAY_IDENTITIES_FILE = bad;
        expect(() => loadIdentities()).toThrow("RELAY_IDENTITIES_FILE could not be read");
      }
      writeFileSync(file, json.padEnd(1048577, " "));
      process.env.RELAY_IDENTITIES_FILE = file;
      expect(() => loadIdentities()).toThrow("RELAY_IDENTITIES_FILE could not be read");
      writeFileSync(file, "not-json");
      expect(() => loadIdentities()).toThrow("RELAY_IDENTITIES_FILE is not valid JSON");
    } finally {
      if (saved === undefined) delete process.env.RELAY_IDENTITIES_FILE;
      else process.env.RELAY_IDENTITIES_FILE = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
