import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServer } from "../codex/app-server.ts";
import { loadBots } from "../codex/bots-config.ts";
import { modelName, reasoningEffort, reservedProfileStem } from "../codex/config.ts";
import { start, type Worker } from "../codex/manager.ts";
import { prepareRuntimeHome } from "../codex/runtime-home.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("Campaign #141 KR4 — Codex AppServer, Config, Bots Registry, Manager & Runtime Home Hardening", () => {
  test("AppServer validates runtime home, toolIdentity, and readThread/nameThread inputs before spawning or issuing RPCs", async () => {
    for (const badHome of ["", "   ", "/tmp/home\u0085bad", "/tmp/home\u2028bad", "/" + "a".repeat(4097)]) {
      const app = new AppServer("node", ["-e", "process.exit(0)"], undefined, "full-access", { home: badHome });
      await expect(app.start()).rejects.toThrow("Invalid app-server runtime home");
    }

    const baseIdentity = {
      profileFile: "/tmp/profile.json",
      agentId: "bot-1",
      apiUrl: "https://agents-chat.test",
      wsUrl: "wss://agents-chat.test/ws",
    };
    for (const patch of [
      { profileFile: "" },
      { agentId: "bot\u0085bad" },
      { agentId: "b".repeat(257) },
      { apiUrl: "https://agents-chat.test\u2028" },
      { wsUrl: "wss://agents-chat.test/ws\x00" },
    ]) {
      const app = new AppServer("node", ["-e", "process.exit(0)"], undefined, "full-access", undefined, undefined, undefined, {
        ...baseIdentity,
        ...patch,
      });
      await expect(app.start()).rejects.toThrow("Invalid app-server tool identity");
    }

    const live = new AppServer("node", [
      "-e",
      `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:{config:{mcp_servers:{toString:{enabled:true},__proto__:{enabled:true}}},thread:{id:'th-1',turns:[]}}}));});`,
    ], undefined, "read-only");
    try {
      await live.start();
      const tid = await live.thread("/tmp");
      expect(tid).toBe("th-1");

      for (const badId of ["", "   ", "th\x85bad", "th\u2029bad", "t".repeat(257)]) {
        await expect(live.readThread(badId)).rejects.toThrow("Invalid app-server thread ID");
        await expect(live.readLegacyThread(badId)).rejects.toThrow("Invalid app-server thread ID");
        await expect(live.nameThread(badId, "Valid Name")).rejects.toThrow("Invalid app-server thread ID");
      }

      for (const badName of ["", "   ", "Name\x85Bad", "Name\u2028Bad", "n".repeat(257)]) {
        await expect(live.nameThread("th-1", badName)).rejects.toThrow("Invalid app-server thread name");
      }
    } finally {
      live.close();
    }
  });

  test("config bounds modelName/reasoningEffort and blocks Object.prototype + Windows device profile stems", () => {
    expect(reasoningEffort(" high ")).toBe("high");
    expect(reasoningEffort("e".repeat(64))).toBe("e".repeat(64));
    for (const badEffort of ["e".repeat(65), "__proto__", "constructor", "prototype", "CONSTRUCTOR"]) {
      expect(() => reasoningEffort(badEffort)).toThrow("effort");
    }

    expect(modelName(" gpt-5.4 ")).toBe("gpt-5.4");
    expect(modelName("m".repeat(256))).toBe("m".repeat(256));
    for (const badModel of ["m".repeat(257), "__proto__", "constructor", "prototype", "Prototype"]) {
      expect(() => modelName(badModel)).toThrow("model");
    }

    for (const reserved of [
      "toString", "toString.json", "hasOwnProperty", "valueOf.json",
      "CON", "con.json", "PRN", "AUX", "NUL.json", "COM1", "com9.json", "LPT1", "lpt9.json",
    ]) {
      expect(reservedProfileStem(reserved)).toBe(true);
    }
    expect(reservedProfileStem("assistant-main")).toBe(false);
    expect(reservedProfileStem("console-bot.json")).toBe(false);
  });

  test("bots-config rejects Object.prototype bot names and oversized path fields", () => {
    const home = tempDir("c141-bots-");
    const profiles = join(home, ".agentschat/profiles");
    const cwd = join(home, "project");
    mkdirSync(profiles, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const fakeTok = "ac_" + "c141_bot_token_123456";
    writeFileSync(join(profiles, "one.json"), JSON.stringify({ agent_id: "bot-1", token: fakeTok }), { mode: 0o600 });
    const reg = join(home, "bots.json");

    for (const protoBot of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      writeFileSync(reg, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: protoBot, profile: "one" }] }));
      expect(() => loadBots(reg, home)).toThrow("Bot names must be unique simple labels");
    }

    writeFileSync(reg, JSON.stringify({ version: 1, default_workdir: "/" + "a".repeat(4096), bots: [] }));
    expect(() => loadBots(reg, home)).toThrow("Invalid default_workdir");

    writeFileSync(reg, JSON.stringify({ version: 1, default_workdir: cwd, codex_bin: "c".repeat(4097), bots: [] }));
    expect(() => loadBots(reg, home)).toThrow("Invalid codex_bin");
  });

  test("manager prevents prefix collision on agentId connection marker and validates --status structure", () => {
    const root = tempDir("c141-mgr-");
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      connected: false,
      stderr,
      stdout: { resume() {} },
    });
    const w: Worker = {
      config: { stateDir: join(root, "state"), cwd: root, agentId: "bot-1" } as any,
      fingerprint: "fp",
      failures: 0,
      next: 0,
      status: "waiting",
    };

    start(w, (() => child) as any);
    expect(w.status).toBe("starting");

    // Prefix collision ("bot-10" or "bot-1-staging") must NOT mark "bot-1" connected
    stderr.emit("data", "AgentsChat connected as bot-10\n");
    expect(w.status).toBe("starting");
    stderr.emit("data", "AgentsChat connected as bot-1-staging\n");
    expect(w.status).toBe("starting");

    // Exact match marks "bot-1" connected
    stderr.emit("data", "AgentsChat connected as bot-1\n");
    expect(w.status).toBe("connected");

    // --status rejects corrupted pid or missing bots array
    const statusDir = join(root, ".agentschat/codex-bots");
    mkdirSync(statusDir, { recursive: true });
    const statusFile = join(statusDir, "status.json");
    const managerEntry = resolve(import.meta.dir, "../codex/manager.ts");

    for (const badStatus of [
      { pid: 0, bots: [] },
      { pid: -5, bots: [] },
      { pid: "123", bots: [] },
      { pid: 123, bots: "not-an-array" },
    ]) {
      writeFileSync(statusFile, JSON.stringify(badStatus), { mode: 0o600 });
      const res = spawnSync(process.execPath, [managerEntry, "--status"], {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(res.status).toBe(1);
    }
    writeFileSync(statusFile, '{"bots":[{"name":"bot-1","__proto__":{}}]}', { mode: 0o600 });
    expect(spawnSync(process.execPath, [managerEntry, "--status"], {
      env: { ...process.env, HOME: root },
      encoding: "utf8",
      timeout: 5000,
    }).status).toBe(1);

    writeFileSync(statusFile, JSON.stringify({ pid: 12345, updated_at: "2026-11-15T00:00:00Z", bots: [] }), { mode: 0o600 });
    const okRes = spawnSync(process.execPath, [managerEntry, "--status"], {
      env: { ...process.env, HOME: root },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(okRes.status).toBe(0);
  });

  test("runtime-home rejects control-char/oversized stateDir and symlinked source home in linked & auth-only modes", () => {
    const root = tempDir("c141-rt-");
    const realSource = join(root, "real-source");
    const symlinkSource = join(root, "linked-source");
    const state = join(root, "state");
    mkdirSync(realSource);
    writeFileSync(join(realSource, "auth.json"), "{}");
    symlinkSync(realSource, symlinkSource);

    for (const badState of ["", "   ", `${state}\u0085`, "/" + "s".repeat(4097)]) {
      expect(() => prepareRuntimeHome(badState, realSource, "isolated")).toThrow("Invalid bot state directory");
    }

    for (const mode of ["linked", "auth-only"] as const) {
      expect(() => prepareRuntimeHome(state, symlinkSource, mode)).toThrow("Source Codex home must not be a symlink");
      expect(() => prepareRuntimeHome(state, `${realSource}\u2028`, mode)).toThrow("Invalid Codex source home");
    }
  });
});
