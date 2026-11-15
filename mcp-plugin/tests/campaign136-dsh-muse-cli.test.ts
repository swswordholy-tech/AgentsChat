import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpAgentsChatArgs,
  checkParentDirectory,
  isBlockedDshHost,
  resolveDshPatchPath,
} from "../dsh/src/patch.ts";
import {
  loadDshConfig,
  RESERVED_DSH_PROFILE_BASENAMES,
  registerOnly as dshRegisterOnly,
  runDshHeadlessResponder,
} from "../dsh/src/cli.ts";
import {
  main as museMain,
  registerOnly as museRegisterOnly,
  validateMuseChannelId,
} from "../muse/src/cli.ts";
import { MuseBridge } from "../muse/src/bridge.ts";
import { buildContext, isMentioned } from "../muse/src/policy.ts";
import { MAX_TYPING_CHANNELS, TypingHeartbeat } from "../muse/src/typing.ts";

describe("Campaign #136 Protocol KR3+KR4: DSH Patch/CLI, Muse NTFS Fallback, Channel Validation & Typing Bounds", () => {
  test("dsh/src/patch.ts blocks entire 0.0.0.0/8 & mapped IPv6 0.*, verifies Darwin /private, and rejects pre-trim C1/U+2028", () => {
    expect(isBlockedDshHost("0.0.0.0")).toBe(true);
    expect(isBlockedDshHost("0.1.2.3")).toBe(true);
    expect(isBlockedDshHost("0.255.255.255")).toBe(true);
    expect(isBlockedDshHost("[::ffff:0.1.2.3]")).toBe(true);
    expect(isBlockedDshHost("::ffff:0:102")).toBe(true);
    expect(isBlockedDshHost("agents-chat.com")).toBe(false);

    expect(() => buildMcpAgentsChatArgs({ apiUrl: "https://0.1.2.3" })).toThrow(/Invalid AgentsChat API URL/);
    expect(() => buildMcpAgentsChatArgs({ apiUrl: "https://[::ffff:0.1.2.3]" })).toThrow(/Invalid AgentsChat API URL/);
    expect(() => buildMcpAgentsChatArgs({ agentsChatProfile: "work\u2028" })).toThrow(/Invalid AgentsChat profile name/);
    expect(() => buildMcpAgentsChatArgs({ packageSpec: "agentschat-mcp@latest\u2029" })).toThrow(/Invalid packageSpec/);
    expect(() => resolveDshPatchPath({ dshHome: "/tmp/dsh-home", dshProfile: "headless\u2028" })).toThrow(/Invalid DSH profile name/);
    expect(() => resolveDshPatchPath({ dshHome: "/tmp/dsh\u0085home" })).toThrow(/Invalid DSH home path/);
    expect(() => checkParentDirectory("/tmp/bad\u2028path/file.yml")).toThrow(/Invalid DSH target path/);
  });

  test("dsh/src/cli.ts covers all sidecar basenames and rejects pre-trim C1/U+2028/U+2029 across config, registerOnly & responder", async () => {
    for (const sidecar of [
      "session-binds.meta",
      "session-binds-meta",
      "agy-binds.meta",
      "agy-binds-meta",
      "grok-binds.meta",
      "grok-binds-meta",
      "agy-session-binds.meta",
      "agy-session-binds_meta",
      "agy-session-binds-meta",
    ]) {
      expect(RESERVED_DSH_PROFILE_BASENAMES.has(sidecar)).toBe(true);
    }

    const dir = mkdtempSync(join(tmpdir(), "ac-c136-dsh-"));
    try {
      const fakeTok = ["ac", "_"].join("") + "ValidDshToken123456";
      expect(() =>
        loadDshConfig(
          { AGENTCHAT_AGENT_ID: "bot-1\u2028", AGENTCHAT_TOKEN: fakeTok },
          join(dir, "missing.json"),
        ),
      ).toThrow(/Missing AgentsChat identity/);

      expect(() =>
        loadDshConfig(
          { AGENTCHAT_AGENT_ID: "bot-1", AGENTCHAT_TOKEN: `${fakeTok}\u0085` },
          join(dir, "missing.json"),
        ),
      ).toThrow(/Missing AgentsChat identity/);

      await expect(dshRegisterOnly("bot\u2028name", "https://agents-chat.com", join(dir, "dsh.json"))).rejects.toThrow(
        /Invalid --name value/,
      );

      expect(await runDshHeadlessResponder("hi", { dshBin: "dsh\u2028" })).toBeNull();
      expect(await runDshHeadlessResponder("hi", { dshBin: "echo", dshProfile: "headless\u0085" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("muse/src/cli.ts registerOnly supports Windows NTFS EPERM/EACCES fallback, refuses symlink swap, and preserves tmp cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-c136-muse-"));
    try {
      const profilePath = join(dir, "muse.json");
      writeFileSync(profilePath, '{"old":true}', { mode: 0o600 });
      const fakeTok = ["ac", "_"].join("") + "MuseTokenWindowsFallback12";
      let renameCalls = 0;

      await museRegisterOnly(
        "muse-win-bot",
        "https://agents-chat.com",
        profilePath,
        (async () =>
          new Response(JSON.stringify({ agentId: "muse-win-bot", token: fakeTok }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
        {
          renameSync: () => {
            renameCalls += 1;
            const err = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
            throw err;
          },
        },
      );

      expect(renameCalls).toBe(1);
      const saved = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(saved).toEqual({ agentId: "muse-win-bot", token: fakeTok });

      // Symlink swap during EPERM fallback is refused and never overwrites victim!
      const victimPath = join(dir, "victim.json");
      writeFileSync(victimPath, '{"secret":"keep"}');
      const swapProfilePath = join(dir, "swap-muse.json");
      writeFileSync(swapProfilePath, '{"initial":true}');

      await expect(
        museRegisterOnly(
          "muse-swap-bot",
          "https://agents-chat.com",
          swapProfilePath,
          (async () =>
            new Response(JSON.stringify({ agentId: "muse-swap-bot", token: fakeTok }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch,
          {
            renameSync: () => {
              rmSync(swapProfilePath);
              symlinkSync(victimPath, swapProfilePath);
              throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            },
          },
        ),
      ).rejects.toThrow(/Refusing to overwrite symlink/);
      expect(readFileSync(victimPath, "utf8")).toBe('{"secret":"keep"}');

      // Pre-trim U+2028 in --name or response agentId is rejected
      await expect(
        museRegisterOnly("bad\u2028name", "https://agents-chat.com", join(dir, "never.json")),
      ).rejects.toThrow(/Invalid --name value/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("muse validateMuseChannelId rejects unsafe channels pre-connect, MuseBridge ignores prototype/C1 channels, and TypingHeartbeat caps timers", async () => {
    expect(validateMuseChannelId("welcome")).toBe("welcome");
    expect(validateMuseChannelId("dm-abc_123")).toBe("dm-abc_123");
    expect(() => validateMuseChannelId("__proto__")).toThrow(/Invalid channel id/);
    expect(() => validateMuseChannelId("../etc")).toThrow(/Invalid channel id/);
    expect(() => validateMuseChannelId("chan\u2028")).toThrow(/Invalid channel id/);
    expect(() => validateMuseChannelId("--text")).toThrow(/Invalid channel id/);

    // museMain rejects invalid --send channel BEFORE loadConfig() or network connect!
    await expect(museMain(["--send", "__proto__", "--text", "hi"])).rejects.toThrow(/Invalid channel id/);
    await expect(museMain(["--channel", "bad/chan", "--wake"])).rejects.toThrow(/Invalid channel id/);

    // MuseBridge ignores prototype channel_id messages and blocks outbound sendMessage on C1/control channel_ids
    let responderCalls = 0;
    let outboundSends = 0;
    const fakeClient = {
      onMessage() {},
      sendTyping() {},
      sendMessage() {
        outboundSends += 1;
      },
      joinChannel() {},
      connect: async () => {},
      disconnect() {},
      isConnected: true,
    } as any;
    const bridge = new MuseBridge(fakeClient, {
      agentId: "muse-bot",
      channels: ["general"],
      responder: async () => {
        responderCalls += 1;
        return "ok";
      },
    });
    await bridge.handleMessage({ id: "m1", channel_id: "__proto__", sender_id: "u1", content: "@muse-bot hi" } as any);
    await bridge.handleMessage({ id: "m1b", channel_id: "toString", sender_id: "u1", content: "@muse-bot hi" } as any);
    expect(responderCalls).toBe(0);
    await bridge.handleMessage({ id: "m2", channel_id: "gen\u0085eral", sender_id: "u1", content: "@muse-bot hi" } as any);
    expect(responderCalls).toBe(1);
    expect(outboundSends).toBe(0);

    // Policy strips C1/U+2028 from sender_id and rejects control-tainted agentId in isMentioned
    expect(isMentioned("hi @muse-bot", "muse-bot\u2028")).toBe(false);
    const ctx = buildContext(
      [{ id: "1", channel_id: "c1", sender_id: "evil\u0085\u2028user", content: "hello" } as any],
      "muse-bot",
    );
    expect(ctx).toBe("evil user: hello\n");

    // TypingHeartbeat caps active timers at MAX_TYPING_CHANNELS and ignores prototype/C1 channelIds
    const pulses: string[] = [];
    const hb = new TypingHeartbeat((ch) => pulses.push(ch));
    try {
      hb.start("__proto__");
      hb.start("chan\u2029");
      expect(pulses).toEqual([]);
      for (let i = 0; i < MAX_TYPING_CHANNELS + 10; i++) {
        hb.start(`ch-${i}`);
      }
      expect((hb as any).timers.size).toBe(MAX_TYPING_CHANNELS);
      expect((hb as any).timers.has("ch-0")).toBe(false);
      expect((hb as any).timers.has(`ch-${MAX_TYPING_CHANNELS + 9}`)).toBe(true);
    } finally {
      hb.stopAll();
      expect((hb as any).timers.size).toBe(0);
    }
  });
});
