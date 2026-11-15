import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { makeUpgradeToken } from "../connector/auth.ts";
import { hermesSourceProfile, IdentityTable, type Identity } from "../connector/identities.ts";
import { matchesLiveLoop, serverLoopTick } from "../connector/normalize.ts";
import { parseIdentitiesJson, readConnectorConfig } from "../connector/run.ts";
import { startConnector } from "../connector/server.ts";

describe("Campaign #137 KR3 — connector server & identities security hardening", () => {
  const secretA = "gw-secret-alpha-137";
  const secretB = "gw-secret-bravo-137";
  const botA: Identity = {
    botId: "bot.alpha",
    agentId: "bot.alpha",
    token: `${"ac"}_${"alpha_token_137_safe"}`,
    gatewayId: "gw-shared",
    secret: secretA,
    profile: "hermes-alpha",
  };
  const botB: Identity = {
    botId: "bot.bravo",
    agentId: "bot.bravo",
    token: `${"ac"}_${"bravo_token_137_safe"}`,
    gatewayId: "gw-shared",
    secret: secretB,
    profile: "hermes-bravo",
  };

  test("IdentityTable and hermesSourceProfile reject C1, U+2028, traversal, and Object.prototype profile/gateway values", () => {
    for (const badGateway of ["gw\u0085x", "gw\u2028x", "__proto__", "constructor", "prototype", "x".repeat(257)]) {
      expect(() => new IdentityTable([{ ...botA, gatewayId: badGateway }])).toThrow("invalid identity gatewayId");
    }
    for (const badCred of ["tok\u0085x", "tok\u2029x"]) {
      expect(() => new IdentityTable([{ ...botA, token: badCred }])).toThrow("invalid identity credentials");
      expect(() => new IdentityTable([{ ...botA, secret: badCred }])).toThrow("invalid identity credentials");
    }
    for (const badProfile of ["", "   ", "__proto__", "prototype", "toString", "prof\u0085x", "a/b", "a..b", "a%2e%2eb"]) {
      expect(() => new IdentityTable([{ ...botA, profile: badProfile }])).toThrow("invalid identity profile");
      expect(hermesSourceProfile({ ...botA, profile: badProfile }, 1)).toBeUndefined();
    }
    expect(hermesSourceProfile({ ...botA, profile: "中文 main" }, 1)).toBe("中文 main");
    expect(hermesSourceProfile(botA, 1)).toBe("hermes-alpha");
  });

  test("startConnector enforces constant-time conn.secret matching across hello & reloadIdentities and scrubs unaddressed inbound logs", async () => {
    const logs: string[] = [];
    const leaked = `${"ghp"}_${"q".repeat(36)}`;
    const server = startConnector({
      port: 0,
      identities: [botA, botB],
      secrets: { "gw-shared": [secretA, secretB] },
      logger: (m) => logs.push(m),
      agentschat: {
        async sendMessage() {
          return { id: "m1" };
        },
        async getChatInfo(_b, chat) {
          return { name: chat };
        },
      },
    });
    await server.ready;

    // Connect authenticated with secretA under gw-shared
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, {
      headers: { Authorization: `Bearer ${makeUpgradeToken("gw-shared", secretA)}` },
    });
    const frames: any[] = [];
    ws.on("message", (raw) =>
      String(raw)
        .trim()
        .split("\n")
        .filter(Boolean)
        .forEach((l) => frames.push(JSON.parse(l))),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    try {
      // Hello for botA succeeds (secretA === conn.secret)
      ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "bot.alpha" }) + "\n");
      while (!frames.some((f) => f.type === "descriptor")) await Bun.sleep(10);

      // Inject unaddressed message carrying C0/C1/U+2028 + leaked token in channel_id & mentioned_ids
      await server.injectAgentsChatMessage({
        id: "m-unaddr",
        channel_id: `room\u0085\n${leaked}`,
        sender_id: "u1",
        content: "general chatter",
        ...({ mentioned_ids: [`@other\u2028${leaked}`] } as any),
      });
      const logJoined = logs.join("\n");
      expect(logJoined).toContain("inbound unaddressed");
      expect(logJoined).not.toContain(leaked);
      expect(logJoined).not.toContain("\u0085");
      expect(logJoined).not.toContain("\u2028");

      // Rotate botA's secret via reloadIdentities -> existing conn with old secretA must lose fronting!
      server.reloadIdentities([{ ...botA, secret: "rotated-secret-137" }, botB]);
      frames.length = 0;
      ws.send(
        JSON.stringify({
          type: "outbound",
          requestId: "after-rotate",
          botId: "bot.alpha",
          action: { op: "send", chat_id: "general", content: "should fail" },
        }) + "\n",
      );
      while (!frames.some((f) => f.requestId === "after-rotate")) await Bun.sleep(10);
      expect(frames.find((f) => f.requestId === "after-rotate").result.success).toBe(false);

      // Attempting hello for botB on a secretA socket closes with credential_mismatch
      ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: "bot.bravo" }) + "\n");
      while (!frames.some((f) => f.type === "error")) await Bun.sleep(10);
      expect(frames.find((f) => f.type === "error").error).toContain("credential_mismatch");
    } finally {
      ws.terminate();
      server.stop();
    }
  });
});

describe("Campaign #137 KR4 — connector run & normalize security hardening", () => {
  test("readConnectorConfig blocks the entire 0.0.0.0/8 block (direct, IPv4-mapped IPv6, SIIT) and C1/U+2028 URLs", () => {
    for (const badUrl of [
      "https://0.1.2.3",
      "https://0.255.255.255",
      "https://[::ffff:0.1.2.3]",
      "https://[::ffff:0:0.1.2.3]",
      "https://agents-chat.com\u0085",
      "https://agents-chat.com\u2028",
    ]) {
      expect(() => readConnectorConfig({ AGENTCHAT_API_URL: badUrl })).toThrow("invalid AGENTCHAT_API_URL");
    }
    expect(readConnectorConfig({ AGENTCHAT_API_URL: "https://agents-chat.com/" }).API).toBe("https://agents-chat.com");
  });

  test("parseIdentitiesJson rejects C1/U+2028 controls, traversal botId, and Object.prototype gatewayId/profile", () => {
    const valid = {
      botId: "bot.137",
      token: `${"ac"}_${"tok_137"}`,
      gatewayId: "gw-137",
      secret: "sec-137",
      profile: "hermes-main",
    };
    expect(parseIdentitiesJson(JSON.stringify([valid]), "TEST")).toHaveLength(1);

    for (const bad of [
      { ...valid, token: "tok\u0085x" },
      { ...valid, secret: "sec\u2028x" },
      { ...valid, botId: "bot..137" },
      { ...valid, gatewayId: "prototype" },
      { ...valid, profile: "constructor" },
      { ...valid, profile: "bad/profile" },
    ]) {
      expect(() => parseIdentitiesJson(JSON.stringify([bad]), "TEST")).toThrow(/missing or invalid string fields/);
    }
  });

  test("serverLoopTick and matchesLiveLoop reject own-__proto__ payloads and C1/U+2028 envelope IDs", () => {
    const baseMsg = {
      id: "msg-loop-1",
      channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
      sender_id: "bot.137",
      sender_type: "agent",
      content_type: "text",
      timestamp: "2026-11-15T06:00:00.000Z",
      content: "(loop tick — check okr)",
      meta: {
        kind: "loop_tick",
        loop_id: "loop_abc_137",
        prompt: "check okr",
        interval_ms: 60_000,
        next_tick_ms: 1_800_000,
        expires_at: null,
      },
    };
    expect(serverLoopTick(baseMsg)).not.toBeNull();
    expect(serverLoopTick({ ...baseMsg, id: "msg\u00851" })).toBeNull();
    expect(serverLoopTick({ ...baseMsg, channel_id: "room\u20281" })).toBeNull();

    const poisonedMeta = JSON.parse(
      `{"__proto__":{"x":1},"kind":"loop_tick","loop_id":"loop_abc_137","prompt":"check okr","interval_ms":60000,"next_tick_ms":1800000,"expires_at":null}`,
    );
    expect(serverLoopTick({ ...baseMsg, meta: poisonedMeta })).toBeNull();

    const poisonedResponse = JSON.parse(
      `{"__proto__":{"x":1},"loops":[{"loop_id":"loop_abc_137","status":"active","channel_id":"edbb8180-4356-4dab-9d75-bc9fe6f26194","prompt":"check okr","interval_ms":60000,"last_tick_at":1740000,"next_tick_ms":1800000,"expires_at":null}]}`,
    );
    expect(matchesLiveLoop(baseMsg, "bot.137", poisonedResponse)).toBe(false);

    const cleanResponse = {
      loops: [
        {
          loop_id: "loop_abc_137",
          status: "active",
          channel_id: "edbb8180-4356-4dab-9d75-bc9fe6f26194",
          prompt: "check okr",
          interval_ms: 60_000,
          last_tick_at: 1_740_000,
          next_tick_ms: 1_800_000,
          expires_at: null,
        },
      ],
    };
    expect(matchesLiveLoop(baseMsg, "bot.137", cleanResponse)).toBe(true);
  });
});
