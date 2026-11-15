import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { makeToken, makeUpgradeToken, verifyToken } from "../connector/auth.ts";
import { IdentityTable, validIdentityId, type Identity } from "../connector/identities.ts";
import { toWireEvent } from "../connector/normalize.ts";
import * as connectorRun from "../connector/run.ts";
import { startConnector } from "../connector/server.ts";
import {
  isSafeCliChannelId,
  joinChannelRest,
  parseMaxIdleMs,
  sendRestMessage,
  validateSafeRestBaseUrl,
} from "../src/rest-cli.ts";
import {
  fireGrokWake,
  fireWake,
  fireZcodeWake,
  formatWakeAttachments,
  hasSafeWakeDirChain,
  resolveEnvWakeId,
} from "../src/wake.ts";

describe("Campaign #131 KR3 — rest-cli & wake hardening", () => {
  test("parseMaxIdleMs rejects overflow values instead of returning Infinity", () => {
    expect(parseMaxIdleMs(30)).toBe(30_000);
    expect(parseMaxIdleMs("30m")).toBe(1_800_000);
    expect(parseMaxIdleMs("never")).toBe(0);
    expect(parseMaxIdleMs(1e308)).toBeUndefined();
    expect(parseMaxIdleMs("999999999999999999999d")).toBeUndefined();
    expect(parseMaxIdleMs(Number.NaN)).toBeUndefined();
  });

  test("rest-cli blocks *.metadata.google.internal, C1 controls, encoded traversal, credential channel IDs, and unsafe header/replyTo tokens", async () => {
    expect(() => validateSafeRestBaseUrl("https://sub.metadata.google.internal/api")).toThrow(/Refusing|Invalid/);
    expect(() => validateSafeRestBaseUrl("https://agents-chat.com\x85")).toThrow(/Invalid/);

    const fakeTok = `${"ac"}_${"secret_channel_123456"}`;
    const fakeMr = `${"mr"}_${"secret_channel_123456"}`;
    expect(isSafeCliChannelId("general")).toBe(true);
    expect(isSafeCliChannelId("dm-abc123")).toBe(true);
    expect(isSafeCliChannelId("%2e%2e")).toBe(false);
    expect(isSafeCliChannelId("room%2fsub")).toBe(false);
    expect(isSafeCliChannelId("room\x85bad")).toBe(false);
    expect(isSafeCliChannelId(fakeTok)).toBe(false);
    expect(isSafeCliChannelId(fakeMr)).toBe(false);

    const badJoin = await joinChannelRest({
      restUrl: "https://agents-chat.com",
      agentId: "bot-1",
      token: "bad\r\nheader",
      channelId: "general",
      fetchImpl: (async () => new Response("{}")) as any,
    });
    expect(badJoin.ok).toBe(false);
    expect(badJoin.error).toContain("Invalid authentication token");

    const dir = mkdtempSync(join(tmpdir(), "c131-rest-"));
    try {
      const badSend = await sendRestMessage({
        restUrl: "https://agents-chat.com",
        configDir: dir,
        agentId: "bot-1",
        token: "valid-token",
        channelId: "general",
        text: "hello",
        replyTo: "__proto__",
        fetchImpl: (async () => new Response("{}")) as any,
      });
      expect(badSend.ok).toBe(false);
      expect(badSend.error).toContain("Invalid in_reply_to");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wake.ts blocks attachment URL credentials, *.metadata.google.internal, :0 ports, symlink_dir/.. traversal, and unsafe ZCode profile names", async () => {
    let wakeHits = 0;
    for (const badUrl of [
      "http://sub.metadata.google.internal/computeMetadata/v1/",
      "http://127.0.0.1:0/wake",
      "http://127.0.0.1:8787/wake\x85",
    ]) {
      await fireWake(
        { id: "m1", channel_id: "general", sender_id: "s1", content: "hi" },
        {
          url: badUrl,
          fetchImpl: (async () => {
            wakeHits++;
            return new Response("ok");
          }) as any,
        },
      );
    }
    expect(wakeHits).toBe(0);

    expect(formatWakeAttachments([{ type: "image", url: "https://cdn.example.com:0/img.png" }])).toBe("");
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: `${"hf"}_${"a".repeat(20)}` })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: `${"mr"}_${"a".repeat(20)}` })).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "c131-wake-sym-"));
    try {
      const realDir = join(root, "real-dir");
      mkdirSync(realDir, { recursive: true });
      const gwFile = join(realDir, "gateway.json");
      writeFileSync(gwFile, JSON.stringify({ token: "gw-tok", port: 1340 }));
      const symDir = join(root, "sym-dir");
      symlinkSync(realDir, symDir);

      // Lexical collapse `sym-dir/../real-dir` must still be rejected!
      expect(hasSafeWakeDirChain(`${symDir}/../real-dir`)).toBe(false);
      let grokHits = 0;
      await fireGrokWake(
        { id: "m1", content: "hi" },
        {
          gatewayConfigPath: `${symDir}/../real-dir/gateway.json`,
          agentId: "ag-1",
          fetchImpl: (async () => {
            grokHits++;
            return new Response("ok");
          }) as any,
        },
      );
      expect(grokHits).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    let capturedEnv: Record<string, string | undefined> = {};
    const ok = await fireZcodeWake(
      { id: "m1", channel_id: "general", sender_id: "peer", content: "ping" },
      {
        sessionId: "sess_abc123",
        profileName: "bad/profile\x00",
        runCommandImpl: async (_cmd, _args, opts) => {
          capturedEnv = opts.env;
          return { code: 0 };
        },
      },
    );
    expect(ok).toBe(true);
    expect(capturedEnv.AGENTSCHAT_PROFILE).toBeUndefined();
  });
});

describe("Campaign #131 KR4 — connector SSRF, auth, identities, normalize & context redaction", () => {
  const id: Identity = {
    botId: "bot.alpha",
    agentId: "bot.alpha",
    token: `${"ac"}_${"fixture_token_123456"}`,
    gatewayId: "gw-1",
    secret: "gw-secret-1",
  };

  test("readConnectorConfig blocks *.metadata.google.internal and SIIT ::ffff:0:* addresses", () => {
    for (const host of ["sub.metadata.google.internal", "[::ffff:0:169.254.169.254]", "[::ffff:0:100.100.100.200]"]) {
      expect(() =>
        connectorRun.readConnectorConfig({
          AGENTCHAT_API_URL: `https://${host}`,
        }),
      ).toThrow("invalid AGENTCHAT_API_URL");
    }
  });

  test("makeToken and verifyToken reject prototype keys, C1 controls, and empty secrets while keeping empty string payload valid", () => {
    expect(() => makeToken("__proto__", id.secret)).toThrow("invalid token payload");
    expect(() => makeToken("gw\x85bad", id.secret)).toThrow("invalid token payload");
    expect(() => makeToken("gw-1", "")).toThrow("invalid token secret");
    expect(verifyToken(makeToken("", id.secret), [id.secret])).toBe("");

    // Forged signed prototype payload rejected by verifyToken
    expect(validIdentityId("room%2fsub")).toBe(false);
    expect(validIdentityId("room%2e%2e")).toBe(false);
    expect(validIdentityId("room\x85")).toBe(false);
    expect(new IdentityTable([id]).forBot("bot.alpha")).toEqual(id);

    const wire = toWireEvent({
      id: "m\x851",
      channel_id: "general\x85",
      sender_id: "u\x851",
      content: "hello",
    });
    expect(wire?.message_id).toBe("m1");
    expect(wire?.source.chat_id).toBe("general");
    expect(wire?.source.user_id).toBe("u1");
  });

  test("startConnector redacts secrets in baseEvent.context, blocks encoded-traversal chat_ids, and scrubs outbound error logs", async () => {
    const leaked = `${"ghp"}_${"z".repeat(36)}`;
    const logs: string[] = [];
    let sentReplyTo: string | undefined = "unset";

    const server = startConnector({
      port: 0,
      identities: [id],
      secrets: { [id.gatewayId]: [id.secret] },
      logger: (m) => logs.push(m),
      agentschat: {
        async sendMessage(_bot, _chat, _content, replyTo) {
          sentReplyTo = replyTo;
          return { id: "sent-1" };
        },
        async getChatInfo(_bot, chat) {
          return { name: chat };
        },
        async getChannelContext() {
          return [{ text: `context leak ${leaked}`, user_id: "u1", user_name: "u1" }];
        },
      },
    });
    await server.ready;

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, {
      headers: { Authorization: `Bearer ${makeUpgradeToken(id.gatewayId, id.secret)}` },
    });
    const frames: any[] = [];
    ws.on("message", (raw) =>
      String(raw)
        .trim()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => frames.push(JSON.parse(line))),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    try {
      ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: id.botId }) + "\n");
      while (!frames.some((f) => f.type === "descriptor")) await Bun.sleep(10);

      // Encoded traversal chat_id rejected
      ws.send(
        JSON.stringify({
          type: "outbound",
          requestId: "r-enc",
          action: { op: "send", chat_id: "%2e%2e", content: "hi" },
        }) + "\n",
      );
      while (!frames.some((f) => f.requestId === "r-enc")) await Bun.sleep(10);
      expect(frames.find((f) => f.requestId === "r-enc").result).toEqual({
        success: false,
        error: "invalid chat_id",
      });

      // Unsafe reply_to dropped cleanly
      ws.send(
        JSON.stringify({
          type: "outbound",
          requestId: "r-reply",
          action: { op: "send", chat_id: "general", content: "hi", reply_to: "__proto__" },
        }) + "\n",
      );
      while (!frames.some((f) => f.requestId === "r-reply")) await Bun.sleep(10);
      expect(sentReplyTo).toBeUndefined();

      // Secret in unknown botId outbound log is scrubbed
      ws.send(
        JSON.stringify({
          type: "outbound",
          requestId: "r-leak",
          botId: leaked,
          action: { op: "send", chat_id: "general", content: "hi" },
        }) + "\n",
      );
      while (!frames.some((f) => f.requestId === "r-leak")) await Bun.sleep(10);
      expect(logs.join("\n")).not.toContain(leaked);

      // Inbound group mention context redacts leaked secret
      await server.injectAgentsChatMessage({
        id: "m-in-1",
        channel_id: "general",
        sender_id: "peer-1",
        content: "@bot.alpha ping",
        timestamp: "2026-11-15T02:50:00.000Z",
      });
      while (!frames.some((f) => f.type === "inbound")) await Bun.sleep(10);
      const inbound = frames.find((f) => f.type === "inbound");
      expect(JSON.stringify(inbound)).not.toContain(leaked);
      expect(JSON.stringify(inbound)).toContain("REDACTED");
    } finally {
      ws.terminate();
      server.stop();
    }
  });
});
