import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GuiChannel } from "../codex/gui-channel.ts";
import { removeDeadLock } from "../codex/manager.ts";
import { loadBots } from "../codex/bots-config.ts";
import { prepareRuntimeHome } from "../codex/runtime-home.ts";
import { externalCodexPresent, parseProcesses } from "../codex/processes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

describe("Campaign #133: Codex GUI Channel, Manager, Bots Config & Runtime/Process Hardening", () => {
  test("GuiChannel blocks C1/line-separator/pre-encoded traversal targets and recovers >5m future-dated locks after backward NTP step", async () => {
    const dir = tempDir("c133-gui-");
    const badTargets = [
      "thread\u0085evil",
      "thread\u2028evil",
      "thread%2e%2e",
      "thread%2fsub",
      "thread%5csub",
      "thread%00null",
      "thread%252fsub",
    ];
    const gui = new GuiChannel(dir, ["good.thread", ...badTargets]);
    for (const bad of badTargets) {
      expect(() => gui.enqueue(bad, "hello")).toThrow("Invalid GUI target");
      expect(() => gui.enqueue("good.thread", "hello", bad)).toThrow("Invalid GUI target");
    }

    const entry = gui.enqueue("good.thread", "hello");
    const lock = join(dir, `${entry.id}.json.lock`);
    mkdirSync(lock);
    // Simulate a lock created before a 10-minute backward NTP clock step (mtime is +10m in the future)
    const futureTenMin = new Date(Date.now() + 10 * 60_000);
    utimesSync(lock, futureTenMin, futureTenMin);

    const dispatched = await gui.dispatch(entry.id, async (tool) =>
      tool === "send_message_to_thread"
        ? { ok: true }
        : {
            thread: { id: "good.thread" },
            turns: [{ id: "turn-1", items: [{ type: "userMessage", content: [{ type: "text", text: entry.prompt }] }] }],
          },
    );
    expect(dispatched.status).toBe("delivered");
    expect(existsSync(lock)).toBe(false);

    // A lock with small clock jitter (+60s) must still be treated as active and preserved
    const entry2 = gui.enqueue("good.thread", "hello2");
    const lock2 = join(dir, `${entry2.id}.json.lock`);
    mkdirSync(lock2);
    const futureOneMin = new Date(Date.now() + 60_000);
    utimesSync(lock2, futureOneMin, futureOneMin);
    await expect(gui.dispatch(entry2.id, async () => ({ ok: true }))).rejects.toThrow();
    expect(existsSync(lock2)).toBe(true);
  });

  test("manager removeDeadLock unlinks non-canonical/unsafe numeric PIDs (1e21, +123, 0x10, >MAX_SAFE_INTEGER) while keeping live PID", () => {
    const dir = tempDir("c133-mgr-lock-");
    const lockFile = join(dir, "bridge.lock");

    for (const corrupt of ["1e21", "+123", "0x10", "9007199254740992", "-42", "0"]) {
      writeFileSync(lockFile, corrupt);
      removeDeadLock(lockFile);
      expect(existsSync(lockFile)).toBe(false);
    }

    writeFileSync(lockFile, String(process.pid));
    removeDeadLock(lockFile);
    expect(existsSync(lockFile)).toBe(true);
  });

  test("bots-config rejects C1 and Unicode line/paragraph separators across bot fields", () => {
    const home = tempDir("c133-bots-");
    const profiles = join(home, ".agentschat/profiles");
    const cwd = join(home, "project");
    mkdirSync(profiles, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const fakeTok = `${"ac"}_c133_bot_token_123456`;
    writeFileSync(join(profiles, "one.json"), JSON.stringify({ agent_id: "bot-one", token: fakeTok }), { mode: 0o600 });
    const reg = join(home, "bots.json");

    writeFileSync(reg, JSON.stringify({ version: 1, default_workdir: `${cwd}\u0085`, bots: [] }));
    expect(() => loadBots(reg, home)).toThrow("Invalid default_workdir");

    writeFileSync(reg, JSON.stringify({ version: 1, codex_bin: "codex\u2028", bots: [] }));
    expect(() => loadBots(reg, home)).toThrow("Invalid codex_bin");

    writeFileSync(reg, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: "one", profile: "one", state_root: "./st\u0085" }] }));
    expect(() => loadBots(reg, home)).toThrow("Invalid state_root");
  });

  test("runtime-home auth-only rejects missing or symlinked source auth.json with clean diagnostic and processes rejects C1/malformed rows", () => {
    const root = tempDir("c133-runtime-");
    const source = join(root, "desktop");
    const state = join(root, "state");
    mkdirSync(source);

    // Missing auth.json -> actionable message without leaking ENOENT path
    expect(() => prepareRuntimeHome(state, source, "auth-only", "codex\u0085")).toThrow(
      "auth-only requires an existing regular auth.json",
    );

    // Symlinked auth.json in source -> rejected even if target exists
    const secretFile = join(root, "outside-secret.json");
    writeFileSync(secretFile, "{}");
    symlinkSync(secretFile, join(source, "auth.json"));
    expect(() => prepareRuntimeHome(state, source, "auth-only")).toThrow(
      "auth-only requires an existing regular auth.json",
    );

    // processes: C1 & line-separator rows are dropped; non-string / malformed rows fail closed
    expect(parseProcesses(null as unknown as string)).toEqual([]);
    expect(parseProcesses("10 1 codex\u0085\n20 1 worker")).toEqual([{ pid: 20, ppid: 1, command: "worker" }]);
    expect(externalCodexPresent(null as unknown as any[], 1)).toBe(false);
    expect(externalCodexPresent([null as any, { pid: 20, ppid: 1, command: null as any }], 1)).toBe(false);
  });

  test("run.ts managed-worker rejects C0/C1/invalid-enum IPC payloads and scrubs ANSI/credential diagnostics", () => {
    const root = tempDir("c133-run-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "state.json"), '{"channels":{}}');
    const codexDir = fileURLToPath(new URL("../codex/", import.meta.url));
    const fakeTok = `${"ac"}_c133_ipc_1234567890123456`;
    const baseIpc = {
      cwd: root,
      profileFile: "fixture",
      source: "test",
      stateDir,
      agentId: "bot-1",
      token: fakeTok,
      apiUrl: "https://example.invalid",
      wsUrl: "wss://example.invalid",
      permissions: "read-only",
      codexBin: "codex",
      channels: ["room-1"],
      senders: ["user-1"],
      codexHomeMode: "isolated",
    };

    const runIpc = (ipc: unknown) => {
      const harness = join(root, "ipc-harness.ts");
      writeFileSync(
        harness,
        `
        import { mock } from "bun:test";
        mock.module(${JSON.stringify(join(codexDir, "runtime-home.ts"))}, () => ({ prepareRuntimeHome: () => ({ home: ${JSON.stringify(stateDir)} }) }));
        mock.module(${JSON.stringify(join(codexDir, "app-server.ts"))}, () => ({ AppServer: class { close() {} }, ThreadBusyError: class extends Error {} }));
        Object.defineProperty(process, "connected", { value: true, configurable: true });
        const orig = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => {
          const t = orig(fn, ms, ...args);
          if (ms === 10000) queueMicrotask(() => process.emit("message", ${JSON.stringify(ipc)}));
          return t;
        };
        process.argv = [process.execPath, ${JSON.stringify(join(codexDir, "run.ts"))}, "--managed-worker", "--conversations"];
        await import(${JSON.stringify(join(codexDir, "run.ts"))});
        `,
      );
      return spawnSync(process.execPath, [harness], { env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 5000 });
    };

    expect(runIpc(baseIpc).status).toBe(0);
    for (const bad of [
      { ...baseIpc, agentId: "bot\u0085" },
      { ...baseIpc, codexBin: "codex\x00" },
      { ...baseIpc, permissions: "admin" },
      { ...baseIpc, codexHomeMode: "shared" },
      { ...baseIpc, channels: ["ok", "bad\nchan"] },
      { ...baseIpc, senders: ["bad\u2028sender"] },
    ]) {
      const out = runIpc(bad);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("Invalid parent configuration");
    }
  });
});
