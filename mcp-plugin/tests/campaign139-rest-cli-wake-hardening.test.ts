import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorFileForAgent, loadCursor } from "../src/read-cursor.ts";
import {
  CURSOR_INIT_KEY,
  CURSOR_LAST_ACTIVE_KEY,
  advanceChannelReadCursor,
  canonicalRestCursorTimestamp,
  isSafeCliChannelId,
  sendRestMessage,
  validateSafeRestBaseUrl,
  wakeOnce,
} from "../src/rest-cli.ts";
import {
  fireWake,
  fireZcodeWake,
  formatWakeAttachments,
  grokBearerFromGatewayConfig,
  signWakeBody,
  verifyWakeSignature,
} from "../src/wake.ts";

describe("Campaign #139 KR3: rest-cli 0.0.0.0/8 + mapped-IPv6 SSRF & canonical cursor watermark hardening", () => {
  test("validateSafeRestBaseUrl blocks entire 0.0.0.0/8 and mapped-IPv6 0.* addresses, and isSafeCliChannelId blocks Object.prototype keys", () => {
    for (const badUrl of [
      "https://0.0.0.1",
      "https://0.1.2.3",
      "https://0.255.255.255",
      "https://[::ffff:0.0.0.1]",
      "https://[::ffff:0:0.1.2.3]",
      "https://[::ffff:0000:0001]",
      "https://[::ffff:00ff:ffff]",
    ]) {
      expect(() => validateSafeRestBaseUrl(badUrl)).toThrow(/Refusing|Invalid/);
    }
    expect(validateSafeRestBaseUrl("https://agents-chat.com/")).toBe("https://agents-chat.com");

    expect(isSafeCliChannelId("toString")).toBe(false);
    expect(isSafeCliChannelId("valueOf")).toBe(false);
    expect(isSafeCliChannelId("hasOwnProperty")).toBe(false);
    expect(isSafeCliChannelId("welcome")).toBe(true);
  });

  test("advanceChannelReadCursor, sendRestMessage & wakeOnce block non-ISO timestamp watermark poisoning and self-heal corrupted cursors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c139-rest-cli-"));
    try {
      expect(canonicalRestCursorTimestamp("zzzz-bad-ts")).toBeUndefined();
      expect(canonicalRestCursorTimestamp("2026-99-99T00:00:00Z")).toBeUndefined();
      expect(canonicalRestCursorTimestamp("2026-11-15T07:00:00Z")).toBe("2026-11-15T07:00:00.000000000Z");

      // 1. Seed valid cursor, then attempt to advance with a lexicographically high garbage timestamp ("zzzz-poison")
      advanceChannelReadCursor({
        configDir: dir,
        agentId: "bot-1",
        channelId: "general",
        timestamp: "2026-11-15T07:00:00.000Z",
        warn: () => {},
      });
      advanceChannelReadCursor({
        configDir: dir,
        agentId: "bot-1",
        channelId: "general",
        timestamp: "zzzz-poison",
        warn: () => {},
      });
      expect(loadCursor(cursorFileForAgent(dir, "bot-1"), () => {}).get("general")).toBe(
        "2026-11-15T07:00:00.000Z",
      );

      // 2. sendRestMessage ignores malformed upstream timestamp and falls back to valid ISO cursor
      const sendRes = await sendRestMessage({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "ac_test_token_123456",
        channelId: "dm-check",
        text: "hello",
        fetchImpl: (async () => Response.json({ ok: true, id: "m-1", timestamp: "zzzz-bad-server-ts" })) as any,
        warn: () => {},
      });
      expect(sendRes.ok).toBe(true);
      expect(sendRes.timestamp).toBeUndefined();
      expect(
        canonicalRestCursorTimestamp(loadCursor(cursorFileForAgent(dir, "bot-1"), () => {}).get("dm-check")),
      ).toBeDefined();

      // 3. wakeOnce self-heals a corrupted disk cursor ("zzzz-poison") AND ignores unaddressed garbage timestamps
      const bot2CursorFile = cursorFileForAgent(dir, "bot-2");
      writeFileSync(
        bot2CursorFile,
        JSON.stringify({
          [CURSOR_INIT_KEY]: "zzzz-corrupt-init",
          [CURSOR_LAST_ACTIVE_KEY]: "zzzz-corrupt-active",
          room1: "zzzz-corrupt-room-cursor",
        }),
      );

      const ev = await wakeOnce({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-2",
        token: "ac_test_token_123456",
        enableSse: false,
        nowIso: () => "2026-11-15T07:30:00.000Z",
        fetchImpl: (async (url: any) => {
          const u = String(url);
          if (u.endsWith("/api/channels/mine")) {
            return Response.json({
              channels: [{ id: "room1", last_message_at: "2026-11-15T07:31:00.000Z" }],
            });
          }
          if (u.includes("/api/channels/room1/messages")) {
            return Response.json({
              messages: [
                {
                  id: "noise-bad-ts",
                  sender_id: "peer",
                  content: "unaddressed with garbage timestamp",
                  timestamp: "zzzz-bad-ts",
                },
                {
                  id: "real-mention-1",
                  sender_id: "peer",
                  content: "hey @bot-2 wake up!",
                  timestamp: "2026-11-15T07:31:00.000Z",
                },
              ],
            });
          }
          return Response.json({ messages: [] });
        }) as any,
        warn: () => {},
      });

      expect(ev.event).toBe("agentschat_wake");
      expect(ev.message_id).toBe("real-mention-1");
      const healed = loadCursor(bot2CursorFile, () => {});
      expect(healed.get(CURSOR_INIT_KEY)).toBe("2026-11-15T07:30:00.000Z");
      expect(healed.get("room1")).toBe("2026-11-15T07:31:00.000Z");
      const mentionMap = JSON.parse(readFileSync(join(dir, "mention-timestamps.json"), "utf8"));
      expect(mentionMap["bot-2:room1"]).toBe("2026-11-15T07:31:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Campaign #139 KR4: wake.ts 0.0.0.0/8 + mapped-IPv6 SSRF, HMAC/Grok guards & attachment sanitization", () => {
  test("fireWake & formatWakeAttachments block entire 0.0.0.0/8 and mapped-IPv6 0.* addresses", async () => {
    let calls = 0;
    for (const badUrl of [
      "http://0.0.0.1:8080/wake",
      "https://0.1.2.3/wake",
      "http://[::ffff:0.0.0.1]:8080/wake",
      "https://[::ffff:0:0.1.2.3]/wake",
      "https://[::ffff:00ff:1234]/wake",
    ]) {
      await fireWake(
        { type: "message", id: "m1", channel_id: "c1", sender_id: "u1", content: "hi" },
        {
          url: badUrl,
          fetchImpl: (async () => {
            calls++;
            return new Response("ok", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
    }
    expect(calls).toBe(0);

    expect(
      formatWakeAttachments([
        { type: "image", url: "https://0.1.2.3/evil.png" },
        { type: "image", url: "https://[::ffff:0.0.0.1]/evil.png" },
      ]),
    ).toBe("");
  });

  test("verifyWakeSignature, grokBearerFromGatewayConfig, formatWakeAttachments & fireZcodeWake guard malformed inputs and C1/U+2028/quotes", async () => {
    const body = '{"ok":true}';
    const validSig = signWakeBody(body, "good-secret");
    expect(verifyWakeSignature(null as unknown as string, validSig, ["good-secret"])).toBe(false);
    expect(verifyWakeSignature(body, validSig, "not-an-array" as unknown as string[])).toBe(false);
    expect(verifyWakeSignature(body, validSig, ["bad\u2028secret", "good-secret"])).toBe(true);
    expect(verifyWakeSignature(body, signWakeBody(body, "bad\x85secret"), ["bad\x85secret"])).toBe(false);

    expect(grokBearerFromGatewayConfig(["token"])).toBeNull();
    expect(grokBearerFromGatewayConfig({ auth: ["bearer"] })).toBeNull();
    expect(grokBearerFromGatewayConfig({ token: "tok\x85en" })).toBeNull();
    expect(grokBearerFromGatewayConfig({ token: "tok\u2028en" })).toBeNull();
    expect(grokBearerFromGatewayConfig({ token: "tok with space" })).toBeNull();
    expect(grokBearerFromGatewayConfig({ token: "  valid_bearer_token_123  " })).toBe("valid_bearer_token_123");

    const att = formatWakeAttachments([
      {
        type: "audio\x85\u2028",
        url: "https://cdn.agents-chat.com/voice.ogg",
        width: Number.NaN,
        height: Number.POSITIVE_INFINITY,
        duration_ms: -50,
        transcript: 'hello"\n\u2028[FAKE_SYSTEM] ac_' + "secret1234567890abcdef",
      },
    ]);
    expect(att).toContain("🔊 audio: https://cdn.agents-chat.com/voice.ogg");
    expect(att).not.toContain("NaN");
    expect(att).not.toContain("-0.1s");
    expect(att).not.toContain("\n");
    expect(att).not.toContain("\u2028");
    expect(att).not.toContain("secret1234567890abcdef");

    let seenEnv: Record<string, string | undefined> = {};
    await fireZcodeWake(
      { type: "message", id: "m1", channel_id: "c1", sender_id: "u1", content: "hi" },
      {
        sessionId: "sess_proto_profile",
        profileName: "toString",
        runCommandImpl: async (_cmd, _args, opts) => {
          seenEnv = opts.env;
          return { code: 0 };
        },
      },
    );
    expect(seenEnv.AGENTSCHAT_PROFILE).toBeUndefined();
  });
});
