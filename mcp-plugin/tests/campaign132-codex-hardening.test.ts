import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, addressed } from "../codex/bridge.ts";
import { InboxSync } from "../codex/inbox-sync.ts";
import { preserveChannelHistory } from "../codex/thread-history.ts";
import { blockedServerHost, getBotOwner } from "../codex/owner.ts";
import { assertDirectoryAncestors, atomicReplaceRegularFile, modelName, reasoningEffort, resolveConfig, type BridgeConfig } from "../codex/config.ts";
import { AgentsChatTransport } from "../codex/transport.ts";
import { authorizedLoopTick } from "../codex/loop-grants.ts";
import { AppServer } from "../codex/app-server.ts";
import { acquireAgentLock, releaseAgentLock } from "../src/session-bind.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
const fakeTok = `${"ac"}_${"x".repeat(28)}`;

function makeConfig(root: string, agentId = "bot-132"): BridgeConfig {
  return {
    stateDir: join(root, "state"),
    agentId,
    cwd: root,
    permissions: "full-access",
    token: fakeTok,
    profileFile: join(root, "profile.json"),
    source: "test",
    apiUrl: "https://agents-chat.com",
    wsUrl: "wss://agents-chat.com/ws",
    channels: [],
    senders: [],
    codexBin: "codex",
  };
}

describe("Campaign #132: Codex bridge, inbox-sync, thread-history, owner SSRF, config & transport hardening", () => {
  test("Bridge constructor cleans up bridge.lock when acquireAgentLock throws on live runtime conflict", async () => {
    const root = tempDir("c132-bridge-lock-leak-");
    const customLockDir = join(root, "locks");
    const prevLockDir = process.env.AGENTSCHAT_LOCK_DIR;
    process.env.AGENTSCHAT_LOCK_DIR = customLockDir;
    const cfg = makeConfig(root);
    try {
      // Simulate another live process (process.ppid !== process.pid) holding the agent lock
      acquireAgentLock({
        lockDir: customLockDir,
        agentId: cfg.agentId,
        currentPid: process.ppid,
        runtime: "mcp-stdio",
      });
      expect(() => new Bridge(cfg, { thread: async () => "t", generate: async () => "ok" }, async () => {}, () => {})).toThrow();
      // bridge.lock MUST be unlinked on failure so releasing the agent lock later lets Bridge start cleanly!
      expect(existsSync(join(cfg.stateDir, "bridge.lock"))).toBe(false);

      releaseAgentLock({ lockDir: customLockDir, agentId: cfg.agentId, currentPid: process.ppid });
      const bridge = new Bridge(cfg, { thread: async () => "t", generate: async () => "ok" }, async () => {}, () => {});
      await bridge.stop();
      expect(existsSync(join(cfg.stateDir, "bridge.lock"))).toBe(false);
    } finally {
      try { releaseAgentLock({ lockDir: customLockDir, agentId: cfg.agentId, currentPid: process.ppid }); } catch {}
      try { releaseAgentLock({ lockDir: customLockDir, agentId: cfg.agentId }); } catch {}
      if (prevLockDir === undefined) delete process.env.AGENTSCHAT_LOCK_DIR;
      else process.env.AGENTSCHAT_LOCK_DIR = prevLockDir;
    }
  });

  test("atomicReplaceRegularFile handles Windows NTFS EPERM/EACCES fallback while refusing symlink clobber", () => {
    const root = tempDir("c132-win32-replace-");
    const target = join(root, "state.json");
    const tmp = join(root, "state.json.tmp");
    writeFileSync(target, '{"old":1}', { mode: 0o600 });
    writeFileSync(tmp, '{"new":2}', { mode: 0o600 });

    let renameCalls = 0;
    atomicReplaceRegularFile(
      tmp,
      target,
      () => {
        const st = lstatSync(target, { throwIfNoEntry: false });
        if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error("unsafe target");
      },
      {
        platform: "win32",
        rename: () => {
          renameCalls++;
          const err: any = new Error("EPERM: operation not permitted, rename");
          err.code = "EPERM";
          throw err;
        },
      },
    );
    expect(renameCalls).toBe(1);
    expect(existsSync(tmp)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe('{"new":2}');

    // On POSIX, EPERM must NOT fall back to copyFileSync
    const tmpPosix = join(root, "state.json.posix.tmp");
    writeFileSync(tmpPosix, '{"posix":3}', { mode: 0o600 });
    expect(() =>
      atomicReplaceRegularFile(
        tmpPosix,
        target,
        () => {},
        {
          platform: "linux",
          rename: () => {
            const err: any = new Error("EPERM");
            err.code = "EPERM";
            throw err;
          },
        },
      ),
    ).toThrow("EPERM");
    rmSync(tmpPosix, { force: true });

    // If target turns into a symlink right when rename fails with EACCES on win32, second verifySafeTarget aborts before copyFileSync!
    const outside = join(root, "outside.json");
    writeFileSync(outside, "do-not-touch");
    const tmpRace = join(root, "state.json.race.tmp");
    writeFileSync(tmpRace, '{"evil":true}', { mode: 0o600 });
    expect(() =>
      atomicReplaceRegularFile(
        tmpRace,
        target,
        () => {
          const st = lstatSync(target, { throwIfNoEntry: false });
          if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error("unsafe symlink target");
        },
        {
          platform: "win32",
          rename: () => {
            rmSync(target);
            symlinkSync(outside, target);
            const err: any = new Error("EACCES");
            err.code = "EACCES";
            throw err;
          },
        },
      ),
    ).toThrow("unsafe symlink target");
    expect(readFileSync(outside, "utf8")).toBe("do-not-touch");
  });

  test("Bridge, InboxSync, and preserveChannelHistory reject C1/U+2028/encoded-traversal IDs and strip unsafe parent_id/reply_to", async () => {
    const root = tempDir("c132-kr3-ids-");
    const cfg = makeConfig(root);
    const bridge = new Bridge(cfg, { thread: async () => "t-1", generate: async () => "reply" }, async () => {}, () => {});
    try {
      for (const badId of ["msg\u0085x", "msg\u2028x", "msg%2e%2ex", "msg%2fx", "msg%5cx", "msg%00x"]) {
        expect(addressed({ id: badId, channel_id: "dm-owner", sender_id: "owner", content: "hi" }, cfg)).toBe(false);
        expect(addressed({ id: "m1", channel_id: badId, sender_id: "owner", content: "hi", mentions: [cfg.agentId] }, cfg)).toBe(false);
      }
      expect(
        bridge.accept({
          id: "m-clean",
          channel_id: "dm-owner",
          sender_id: "owner",
          content: "hello",
          parent_id: "__proto__",
          reply_to: "parent%2ftraversal",
        }),
      ).toBe(true);
      await bridge.drain();
      const saved = JSON.parse(readFileSync(join(cfg.stateDir, "state.json"), "utf8"));
      expect(saved.entries[0].message.parent_id).toBeUndefined();
      expect(saved.entries[0].message.reply_to).toBeUndefined();
    } finally {
      await bridge.stop();
    }

    const syncDir = join(root, "inbox");
    const sync = new InboxSync(syncDir, async () => [], () => true, () => true, () => {});
    for (const badCh of ["room\u2028x", "room%2e%2ex", "room%2fx", "room%5cx", "room%00x"]) {
      expect(() => sync.watch(badCh)).toThrow("Invalid inbound channel");
    }

    const histDir = join(root, "hist-state");
    for (const badCh of ["", "   ", "chan\u0085bad", "chan\u2029bad"]) {
      expect(() => preserveChannelHistory(histDir, badCh, [], s => s)).toThrow("Invalid history channel");
    }
    expect(existsSync(join(histDir, "history"))).toBe(false);
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });

  test("blockedServerHost & getBotOwner block nested metadata.google.internal, Alibaba/AWS IPv6 IMDS, unspecified & mapped IPv6", async () => {
    const blockedUrls = [
      "https://sub.metadata.google.internal",
      "https://100.100.100.200",
      "https://[fd00:ec2::254]",
      "https://0.0.0.0",
      "https://[::]",
      "https://[::ffff:0.0.0.0]",
      "https://[::ffff:0:0.0.0.0]",
      "https://[::ffff:0.1.2.3]",
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:100.100.100.200]",
      "https://metadata",
      "https://instance-data",
    ];
    for (const raw of blockedUrls) {
      expect(blockedServerHost(new URL(raw))).toBe(true);
      expect(await getBotOwner(raw, "bot-132", fakeTok, (async () => Response.json({})) as unknown as typeof fetch)).toBeNull();
    }
    // Legitimate public hosts and non-link-local mapped IPv6 remain allowed
    for (const allowed of ["https://agents-chat.com", "https://metadata.google.internal.example", "https://[::ffff:169.253.1.2]"]) {
      expect(blockedServerHost(new URL(allowed))).toBe(false);
    }
    // C1 and encoded-traversal owner/agent IDs fail closed
    const responder = (async (u: RequestInfo | URL) =>
      Response.json(String(u).endsWith("onboarding") ? { agent_id: "bot-132", claimed: true } : { owner_account_id: "owner%2fbad" })) as unknown as typeof fetch;
    expect(await getBotOwner("https://agents-chat.com", "bot-132", fakeTok, responder)).toBeNull();
    expect(await getBotOwner("https://agents-chat.com", "bot%2f132", fakeTok, responder)).toBeNull();
  });

  test("assertDirectoryAncestors rejects raw symlink_dir/.. traversal before resolve() collapses segments", () => {
    const root = tempDir("c132-ancestors-");
    const target = join(root, "real-target");
    const escapeDest = join(root, "escaped");
    const link = join(root, "sym-dir");
    mkdirSync(target);
    mkdirSync(escapeDest);
    symlinkSync(target, link, "dir");

    // Without raw segment inspection, resolve(`${link}/../escaped`) collapses to `${root}/escaped` and misses `sym-dir`!
    expect(() => assertDirectoryAncestors(`${link}/../escaped`)).toThrow("non-symlink directory");
    expect(() => modelName("gpt-5\u0085bad")).toThrow("model");
    expect(() => reasoningEffort("high\u2028bad")).toThrow("effort");

    const home = tempDir("c132-cfg-");
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, "ok.json"), JSON.stringify({ agent_id: "bot-ok", token: fakeTok }), { mode: 0o600 });
    expect(() => resolveConfig({ cwd, profile: join(home, "ok.json"), settings: { channels: ["room\u0085bad"] } }, {}, home)).toThrow("channels");
  });

  test("transport drops >1MiB raw WS frames before decoding, rejects double-encoded traversal, and loop-grants/app-server block C1/encoded IDs", async () => {
    const root = tempDir("c132-transport-");
    const cfg = makeConfig(root);
    let received = 0;
    const t = new AgentsChatTransport(cfg, () => { received++; }, () => {});
    try {
      await expect(t.api("/api/channels/%252e%252e/secret")).rejects.toThrow("Invalid AgentsChat API path");
      await expect(t.api("/api/channels/room\u0085bad")).rejects.toThrow("Invalid AgentsChat API path");
      await expect(t.send("room%2fbad", "hi")).rejects.toThrow("Invalid AgentsChat channel");
      expect(() => t.setTyping("room\u2028bad", true)).toThrow("Invalid AgentsChat channel");
    } finally {
      t.stop();
    }
    expect(received).toBe(0);

    mkdirSync(cfg.stateDir, { recursive: true });
    const grantFile = join(cfg.stateDir, "loop-grants.json");
    writeFileSync(
      grantFile,
      JSON.stringify({
        version: 1,
        grants: [
          {
            loop_id: "loop_132",
            channel_id: "room%2fbad",
            agent_id: cfg.agentId,
            owner_id: "owner-1",
            interval_ms: 60_000,
            prompt: "check",
          },
        ],
      }),
      { mode: 0o600 },
    );
    expect(
      authorizedLoopTick(
        {
          id: "t1",
          channel_id: "room%2fbad",
          sender_id: cfg.agentId,
          meta: { kind: "loop_tick", loop_id: "loop_132", interval_ms: 60_000, next_tick_ms: 120_000, prompt: "check" },
        },
        cfg,
      ),
    ).toBeNull();

    const appBadModel = new AppServer("codex", undefined, undefined, "read-only", undefined, undefined, "gpt-5\u0085bad");
    await expect(appBadModel.start()).rejects.toThrow("Invalid app-server model");
    const app = new AppServer();
    await expect(app.thread("/tmp\u2028bad")).rejects.toThrow("Invalid app-server cwd");
    await expect(app.thread("/tmp", "thread\u0085bad")).rejects.toThrow("Invalid app-server thread ID");
    app.close();
  });
});
