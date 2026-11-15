import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressed, Bridge } from "../codex/bridge.ts";
import type { BridgeConfig } from "../codex/config.ts";
import { InboxSync } from "../codex/inbox-sync.ts";
import { authorizedLoopTick, verifyLoopTick } from "../codex/loop-grants.ts";
import { blockedServerHost, getBotOwner } from "../codex/owner.ts";
import { preserveChannelHistory, priorChannelThreads } from "../codex/thread-history.ts";
import { AgentsChatTransport } from "../codex/transport.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ac-codex-c140-"));
  chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function makeBridgeConfig(stateDir: string): BridgeConfig {
  return {
    agentId: "bot-c140",
    token: "tok_test_c140",
    apiUrl: "https://agents-chat.com",
    wsUrl: "wss://agents-chat.com/ws",
    cwd: stateDir,
    stateDir,
    channels: [],
    senders: [],
    permissions: "full-access",
    profileFile: join(stateDir, "profile.json"),
    source: "test",
    codexBin: "codex",
  } as unknown as BridgeConfig;
}

describe("Campaign #140 KR3: codex/{bridge,thread-history,transport}.ts hardening", () => {
  test("addressed and Bridge reject .. substring traversal, Object.prototype keys, and own-__proto__ state maps", () => {
    const stateDir = makeTempStateDir();
    const cfg = makeBridgeConfig(stateDir);

    expect(
      addressed(
        { id: "msg..1", channel_id: "dm-ok", sender_id: "user-1", content: "hi" },
        cfg,
      ),
    ).toBe(false);
    expect(
      addressed(
        { id: "msg-1", channel_id: "dm..evil", sender_id: "user-1", content: "hi" },
        cfg,
      ),
    ).toBe(false);
    expect(
      addressed(
        { id: "PROTOTYPE", channel_id: "dm-ok", sender_id: "user-1", content: "hi" },
        cfg,
      ),
    ).toBe(false);
    expect(
      addressed(
        { id: "msg-1", channel_id: "dm-ok", sender_id: "CONSTRUCTOR", content: "hi" },
        cfg,
      ),
    ).toBe(false);
    expect(
      addressed(
        { id: "msg-1", channel_id: "dm-ok", sender_id: "user-1", content: "hi" },
        cfg,
      ),
    ).toBe(true);

    // Bridge constructor rejects own-__proto__ inside state.threads or state.channels
    const badStateDir = makeTempStateDir();
    mkdirSync(badStateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(badStateDir, "state.json"),
      '{"version":1,"threads":{"__proto__":"evil"},"entries":[]}',
      { mode: 0o600 },
    );
    expect(
      () =>
        new Bridge(makeBridgeConfig(badStateDir), {
          thread: async () => "t1",
          generate: async () => "ok",
        }, async () => {}),
    ).toThrow(/Cannot load bridge state/);
  });

  test("priorChannelThreads and preserveChannelHistory filter Object.prototype keys and reject .. / untrimmed channels", () => {
    const threads: Record<string, string> = Object.create(null);
    (threads as any).toString = "thread-proto-leak";
    (threads as any).valueOf = "thread-proto-leak-2";
    threads["room-1"] = "thread-valid";
    expect(priorChannelThreads(threads, "toString")).toEqual([]);
    expect(priorChannelThreads(threads, "room-1")).toEqual(["thread-valid"]);

    const dir = makeTempStateDir();
    expect(() => preserveChannelHistory(dir, "room..evil", [], (s) => s)).toThrow(/Invalid history channel/);
    expect(() => preserveChannelHistory(dir, "toString", [], (s) => s)).toThrow(/Invalid history channel/);
    expect(() => preserveChannelHistory(dir, " room-1 ", [], (s) => s)).toThrow(/Invalid history channel/);
    expect(() => preserveChannelHistory(dir, "room/1", [], (s) => s)).toThrow(/Invalid history channel/);

    const exported = preserveChannelHistory(
      dir,
      "room-ok",
      [
        {
          id: "th-1",
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text:
                        'Header\nAgentsChat message:\n{"id":"m1","channel_id":"room-ok","content":"hello","toString":"bad","hasOwnProperty":"bad"}',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      (s) => s,
    );
    expect(exported).toContain('"content":"hello"');
    expect(exported).not.toContain('"toString":"bad"');
    expect(exported).not.toContain('"hasOwnProperty":"bad"');
  });

  test("AgentsChatTransport rejects Object.prototype channel names in setTyping and send", async () => {
    const dir = makeTempStateDir();
    const transport = new AgentsChatTransport(makeBridgeConfig(dir), () => {}, () => {});
    try {
      expect(() => transport.setTyping("toString", true)).toThrow(/Invalid AgentsChat channel/);
      expect(() => transport.setTyping("hasOwnProperty", true)).toThrow(/Invalid AgentsChat channel/);
      await expect(transport.send("valueOf", "hello")).rejects.toThrow(/Invalid AgentsChat channel/);
    } finally {
      transport.stop();
    }
  });
});

describe("Campaign #140 KR4: codex/{inbox-sync,loop-grants,owner}.ts hardening", () => {
  test("InboxSync rejects Object.prototype channel names and .. / prototype message IDs in history reconciliation", async () => {
    const dir = makeTempStateDir();
    const logs: string[] = [];
    const accepted: unknown[] = [];
    let nextMessages: any[] = [];

    const sync = new InboxSync(
      dir,
      async () => ({ messages: nextMessages }),
      (m) => {
        accepted.push(m);
        return true;
      },
      () => true,
      (msg) => logs.push(msg),
    );

    expect(() => sync.watch("toString")).toThrow(/Invalid inbound channel/);
    expect(() => sync.watch("hasOwnProperty")).toThrow(/Invalid inbound channel/);

    sync.watch("room-sync");
    nextMessages = [
      {
        id: "msg..traversal",
        channel_id: "room-sync",
        timestamp: "2099-01-01T00:00:01.000000000Z",
      },
    ];
    await sync.sync();
    expect(accepted).toHaveLength(0);
    expect(logs.some((l) => l.includes("reconciliation failed"))).toBe(true);
  });

  test("loop-grants rejects .. substring and Object.prototype keys in loop/channel/agent/owner IDs and own-__proto__ server rows", async () => {
    const dir = makeTempStateDir();
    const cfg = makeBridgeConfig(dir);
    writeFileSync(
      join(dir, "loop-grants.json"),
      JSON.stringify({
        version: 1,
        grants: [
          {
            loop_id: "loop_ok_1",
            channel_id: "room..traversal",
            agent_id: "bot-c140",
            owner_id: "acct_owner",
            interval_ms: 60_000,
            prompt: "check status",
          },
          {
            loop_id: "loop_ok_2",
            channel_id: "toString",
            agent_id: "bot-c140",
            owner_id: "acct_owner",
            interval_ms: 60_000,
            prompt: "check status",
          },
          {
            loop_id: "loop_ok_3",
            channel_id: "room-valid",
            agent_id: "bot-c140",
            owner_id: "acct_owner",
            interval_ms: 60_000,
            prompt: "check status",
          },
        ],
      }),
      { mode: 0o600 },
    );

    expect(
      authorizedLoopTick(
        {
          sender_id: "bot-c140",
          channel_id: "room..traversal",
          meta: { kind: "loop_tick", loop_id: "loop_ok_1", interval_ms: 60_000, next_tick_ms: 120_000, prompt: "check status" },
        },
        cfg,
      ),
    ).toBeNull();
    expect(
      authorizedLoopTick(
        {
          sender_id: "bot-c140",
          channel_id: "toString",
          meta: { kind: "loop_tick", loop_id: "loop_ok_2", interval_ms: 60_000, next_tick_ms: 120_000, prompt: "check status" },
        },
        cfg,
      ),
    ).toBeNull();

    // Valid grant rejects server loop row carrying own-__proto__
    const poisonedLoop = JSON.parse(
      '{"__proto__":{"polluted":true},"loop_id":"loop_ok_3","status":"active","channel_id":"room-valid","prompt":"check status","interval_ms":60000,"expires_at":null,"last_tick_at":60000,"next_tick_ms":120000}',
    );
    const verified = await verifyLoopTick(
      {
        sender_id: "bot-c140",
        channel_id: "room-valid",
        meta: { kind: "loop_tick", loop_id: "loop_ok_3", interval_ms: 60_000, next_tick_ms: 120_000, prompt: "check status" },
      },
      cfg,
      "acct_owner",
      async () => ({ loops: [poisonedLoop] }),
    );
    expect(verified).toBeNull();
  });

  test("blockedServerHost and getBotOwner block zero-padded [::ffff:00xx:xxxx], CGNAT 100.64.0.0/10, .. substrings, and Object.prototype IDs", async () => {
    expect(blockedServerHost(new URL("https://[::ffff:0.0.0.1]"))).toBe(true);
    expect(blockedServerHost(new URL("https://100.64.0.1"))).toBe(true);
    expect(blockedServerHost(new URL("https://[::ffff:100.64.0.1]"))).toBe(true);
    // Synthetic unnormalized URL-like check for 4-digit zero-padded hex words
    expect(blockedServerHost({ hostname: "[::ffff:0000:0001]" } as URL)).toBe(true);
    expect(blockedServerHost({ hostname: "[::ffff:00ff:ffff]" } as URL)).toBe(true);
    expect(blockedServerHost(new URL("https://agents-chat.com"))).toBe(false);

    let netHits = 0;
    const mockFetch = (async () => {
      netHits++;
      return new Response("{}", { status: 200 });
    }) as any;

    expect(await getBotOwner("https://agents-chat.com", "bot..evil", "tok1", mockFetch)).toBeNull();
    expect(await getBotOwner("https://agents-chat.com", "toString", "tok1", mockFetch)).toBeNull();
    expect(netHits).toBe(0);

    // Rejects owner_account_id containing .. or Object.prototype key
    const protoOwnerFetch = (async (url: string) => {
      if (url.endsWith("/api/account/onboarding")) {
        return new Response(JSON.stringify({ agent_id: "bot-ok", claimed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ owner_account_id: "hasOwnProperty" }), { status: 200 });
    }) as any;
    expect(await getBotOwner("https://agents-chat.com", "bot-ok", "tok1", protoOwnerFetch)).toBeNull();

    const dotDotOwnerFetch = (async (url: string) => {
      if (url.endsWith("/api/account/onboarding")) {
        return new Response(JSON.stringify({ agent_id: "bot-ok", claimed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ owner_account_id: "acct..evil" }), { status: 200 });
    }) as any;
    expect(await getBotOwner("https://agents-chat.com", "bot-ok", "tok1", dotDotOwnerFetch)).toBeNull();
  });
});
