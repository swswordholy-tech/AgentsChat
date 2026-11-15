import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Bridge, addressed, type Generator } from "../codex/bridge.ts";
import { authorizedLoopTick, verifyLoopTick } from "../codex/loop-grants.ts";
import { GuiChannel } from "../codex/gui-channel.ts";
import { save, removeDeadLock, removeOwnedLock } from "../codex/manager.ts";
import { AppServer } from "../codex/app-server.ts";
import type { BridgeConfig } from "../codex/config.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-bridge-manager-gui-")); roots.push(root);
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const c: BridgeConfig = { cwd: root, stateDir, agentId: "bot.alpha", token: "fixture", profileFile: "unused", source: "test",
    apiUrl: "https://example.invalid", wsUrl: "wss://example.invalid", permissions: "full-access", channels: [], senders: [], codexBin: "unused" };
  const grant = { loop_id: "loop_one", agent_id: c.agentId, channel_id: "release-v1.0", owner_id: "owner", interval_ms: 60000, prompt: "Review work" };
  const tick = { id: "tick", sender_id: c.agentId, channel_id: grant.channel_id, content: "tick", meta: { kind: "loop_tick", ...grant, next_tick_ms: 120000 } };
  const writeGrant = () => writeFileSync(join(stateDir, "loop-grants.json"), JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 });
  return { root, stateDir, c, grant, tick, writeGrant };
}
const model: Generator = { thread: async () => "thread", generate: async () => "answer" };
const message = { id: "msg.1", channel_id: "release-v1.0", sender_id: "owner.alpha", content: "hello", mentions: ["bot.alpha"] };

test("dotted channel and agent IDs authorize exact grants including live verification", async () => {
  const f = fixture(); f.writeGrant();
  expect(authorizedLoopTick(f.tick, f.c)).toEqual(f.grant);
  expect(addressed(f.tick, f.c)).toBe(true);
  const row = { ...f.grant, status: "active", expires_at: null, last_tick_at: 60000, next_tick_ms: 120000 };
  expect(await verifyLoopTick(f.tick, f.c, "owner", async () => ({ loops: [row] }))).toEqual(f.grant);
  for (const id of [".", "..", "a/b", "a\\b", "a b", " room", "room\t", "room\x7f", "__proto__", "Constructor", "PROTOTYPE", "x".repeat(129)]) {
    f.grant.channel_id = id; f.tick.channel_id = id; f.writeGrant();
    expect(authorizedLoopTick(f.tick, f.c)).toBeNull();
  }
});

test("loop grants reject existing and dangling ancestor links and recheck after live I/O", async () => {
  const f = fixture(); f.writeGrant();
  const alias = join(f.root, "alias"); symlinkSync(f.root, alias);
  expect(authorizedLoopTick(f.tick, { ...f.c, stateDir: join(alias, "state") })).toBeNull();
  const row = { ...f.grant, status: "active", expires_at: null, last_tick_at: 60000, next_tick_ms: 120000 };
  expect(await verifyLoopTick(f.tick, f.c, "owner", async () => {
    renameSync(f.stateDir, join(f.root, "moved")); symlinkSync(join(f.root, "moved"), f.stateDir);
    return { loops: [row] };
  })).toBeNull();
});

test("bridge and GUI reject ancestor links before recursive creation", () => {
  for (const dangling of [false, true]) {
    const f = fixture(), alias = join(f.root, "alias"), target = join(f.root, dangling ? "missing" : "state");
    symlinkSync(target, alias);
    const dir = join(alias, "new", "nested");
    expect(() => new Bridge({ ...f.c, stateDir: dir }, model, async () => {})).toThrow("symlink");
    expect(() => new GuiChannel(dir, [])).toThrow("symlink");
    expect(existsSync(join(target, "new"))).toBe(false);
  }
});

test("bridge rejects own prototype keys at state, entry and message levels without rewriting history", () => {
  for (const level of ["state", "entry", "message"]) {
    const f = fixture();
    const entry = { status: "sent", message: { ...message } };
    const state = { version: 1, threads: {}, entries: [entry] };
    Object.defineProperty(level === "state" ? state : level === "entry" ? entry : entry.message, "__proto__", { value: {}, enumerable: true });
    const text = JSON.stringify(state), file = join(f.stateDir, "state.json"); writeFileSync(file, text);
    expect(() => new Bridge(f.c, model, async () => {})).toThrow("refusing to discard history");
    expect(readFileSync(file, "utf8")).toBe(text); expect(existsSync(join(f.stateDir, "bridge.lock"))).toBe(false);
  }
});

test("addressing rejects unsafe routing IDs and own prototype messages but keeps dotted IDs and exact limit", () => {
  const f = fixture();
  expect(addressed(message, f.c)).toBe(true);
  for (const field of ["id", "channel_id", "sender_id"]) {
    for (const id of [".", "..", "a/b", "a\\b", " a", "a ", "\ta", "a\x7f", "x".repeat(257), "__proto__"]) {
      expect(addressed({ ...message, [field]: id }, f.c)).toBe(false);
    }
    expect(addressed({ ...message, [field]: "x".repeat(256) }, f.c)).toBe(true);
  }
  expect(addressed(JSON.parse(JSON.stringify(message).slice(0, -1) + ',"__proto__":{}}'), f.c)).toBe(false);
});

test("prepareChannel rejects unsafe channels before generator I/O and supports dotted channels", async () => {
  const f = fixture(); let calls = 0;
  const bridge = new Bridge(f.c, { ...model, thread: async () => { calls++; return "thread"; } }, async () => {});
  try {
    for (const id of [".", "..", "a/b", "a\\b", " a", "a ", "x".repeat(257), "__proto__"]) await expect(bridge.prepareChannel(id)).rejects.toThrow("Invalid channel ID");
    expect(calls).toBe(0);
    expect((await bridge.prepareChannel("release-v1.0")).thread).toBe("thread");
    expect((await bridge.prepareChannel("x".repeat(256))).thread).toBe("thread");
    expect(calls).toBe(2);
  } finally { await bridge.stop(); }
});

test("GUI rejects path targets for both thread and host while accepting dotted IDs", () => {
  const f = fixture(), valid = "thread.alpha", invalid = [".", "..", "a/b", "a\\b", " a", "a ", "x".repeat(257), "__proto__"];
  const gui = new GuiChannel(join(f.root, "outbox"), [valid, ...invalid]);
  for (const id of invalid) {
    expect(() => gui.enqueue(id, "hello")).toThrow("Invalid GUI target");
    expect(() => gui.enqueue(valid, "hello", id)).toThrow("Invalid GUI target");
  }
  expect(gui.enqueue(valid, "hello", "host.alpha").status).toBe("pending");
});

test("GUI prototype-bearing parsed receipts cannot establish submission or delivery", async () => {
  const f = fixture(), gui = new GuiChannel(join(f.root, "outbox"), ["thread.alpha"]);
  const e = gui.enqueue("thread.alpha", "hello");
  const wrap = (value: object) => ({ content: [{ type: "text", text: JSON.stringify(value).slice(0, -1) + ',"__proto__":{}}' }] });
  const calls: string[] = [];
  const out = await gui.dispatch(e.id, async tool => {
    calls.push(tool);
    if (tool === "send_message_to_thread") return wrap({ ok: true });
    return wrap({ thread: { id: e.threadId }, turns: [{ id: "turn", items: [{ type: "userMessage", content: [{ type: "text", text: e.prompt }] }] }] });
  });
  expect(out.status).toBe("uncertain"); expect(calls).toEqual(["send_message_to_thread", "read_thread"]);
  expect(gui.get(e.id).status).toBe("uncertain");
});

test("manager save and lock cleanup do not traverse ancestor links", () => {
  const f = fixture(), alias = join(f.root, "alias"); symlinkSync(f.root, alias);
  const dir = join(alias, "state"); save(dir);
  expect(readdirSync(f.stateDir)).toEqual([]);
  const file = join(f.stateDir, "lock");
  for (const own of [false, true]) {
    writeFileSync(file, own ? String(process.pid) : "invalid");
    if (own) removeOwnedLock(join(dir, "lock")); else removeDeadLock(join(dir, "lock"));
    expect(existsSync(file)).toBe(true);
  }
});

test("manager status rejects ancestor links and own prototype JSON, preserving valid status output", () => {
  const f = fixture(), home = join(f.root, "home"), dir = join(home, ".agentschat/codex-bots"); mkdirSync(dir, { recursive: true });
  const manager = join(import.meta.dir, "../codex/manager.ts");
  const run = (testHome = home) => spawnSync(process.execPath, [manager, "--status"], { env: { ...process.env, HOME: testHome }, encoding: "utf8", timeout: 5000 });
  const file = join(dir, "status.json");
  writeFileSync(file, '{"bots":[],"__proto__":{},"private":"do-not-print"}');
  let out = run(); expect(out.status).toBe(1); expect(out.stdout).not.toContain("do-not-print");
  writeFileSync(file, '{"bots":[]}'); out = run(); expect(out.status).toBe(0); expect(JSON.parse(out.stdout)).toEqual({ bots: [] });
  const alias = join(f.root, "alias"); symlinkSync(home, alias);
  out = run(alias); expect(out.status).toBe(1); expect(out.stdout).not.toContain("bots");
});

test("app-server rejects own prototype JSON through readline and settles pending work", async () => {
  const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    kill(this: any, signal: string) { this.signalCode = signal; return true; } });
  child.stdin.on("data", (data: Buffer) => {
    const r = JSON.parse(String(data));
    if (r.method === "initialize") child.stdout.write(JSON.stringify({ id: r.id, result: {} }) + "\n");
  });
  const spawn = spyOn(childProcess, "spawn").mockReturnValue(child), app = new AppServer(); let fatal = 0; app.onFatal = () => fatal++;
  try {
    await app.start();
    const pending = app.request("stalled", {});
    child.stdout.write('{"id":2,"result":"untrusted","__proto__":{}}\n');
    await expect(pending).rejects.toThrow("Invalid app-server response");
    expect(fatal).toBe(1); expect(child.signalCode).toBe("SIGTERM");
  } finally { app.close(); spawn.mockRestore(); }
});

test("app-server rejects unsafe model before spawning and unsafe cwd before RPC", async () => {
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => { throw Error("must not spawn"); });
  try {
    for (const model of ["", " ", "gpt\nname", "gpt\x7f", "x".repeat(257)]) {
      const app = new AppServer("unused", [], undefined, "full-access", undefined, undefined, model);
      await expect(app.start()).rejects.toThrow("Invalid app-server model"); app.close();
    }
    expect(spawn).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); }
  const app = new AppServer(), requests: any[] = [];
  const request = spyOn(app, "request").mockImplementation(async (method: string, params: any) => {
    requests.push({ method, params }); return method === "config/read" ? { config: {} } : { thread: { id: "thread" } };
  });
  try {
    for (const cwd of ["", " ", "/tmp/a\n", "/tmp/a\x7f", "x".repeat(4097)]) await expect(app.thread(cwd)).rejects.toThrow("Invalid app-server cwd");
    expect(requests).toEqual([]);
    await app.thread("x".repeat(4096)); expect(requests[0].params.cwd.length).toBe(4096);
  } finally { request.mockRestore(); app.close(); }
});


test("Darwin canonical system aliases remain usable across bridge, grants, GUI and manager", async () => {
  const f = fixture(); f.writeGrant();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = fs.lstatSync, realpath = fs.realpathSync;
  const fakeLink = { isSymbolicLink: () => true, isDirectory: () => false };
  const statSpy = spyOn(fs, "lstatSync").mockImplementation(((path: any, options: any) =>
    ["/tmp", "/var", "/etc"].includes(String(path)) ? fakeLink : lstat(path, options)) as any);
  const pathSpy = spyOn(fs, "realpathSync").mockImplementation(((path: any, options: any) =>
    ["/tmp", "/var", "/etc"].includes(String(path)) ? `/private${path}` : realpath(path, options)) as any);
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  let bridge: Bridge | undefined;
  try {
    expect(authorizedLoopTick(f.tick, f.c)).toEqual(f.grant);
    bridge = new Bridge(f.c, model, async () => {});
    expect((await bridge.prepareChannel("release-v1.0")).thread).toBe("thread");
    const gui = new GuiChannel(join(f.root, "new/outbox"), ["thread.alpha"]);
    expect(gui.enqueue("thread.alpha", "hello").status).toBe("pending");
    save(f.stateDir); expect(existsSync(join(f.stateDir, "status.json"))).toBe(true);
  } finally {
    if (bridge) await bridge.stop();
    statSpy.mockRestore(); pathSpy.mockRestore(); Object.defineProperty(process, "platform", platform);
  }
});

test("Darwin rejects system aliases with unexpected targets before directory creation", () => {
  const f = fixture(), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const lstat = fs.lstatSync;
  const statSpy = spyOn(fs, "lstatSync").mockImplementation(((path: any, options: any) =>
    ["/tmp", "/var", "/etc"].includes(String(path)) ? { isSymbolicLink: () => true, isDirectory: () => false } : lstat(path, options)) as any);
  const realpath = fs.realpathSync;
  const pathSpy = spyOn(fs, "realpathSync").mockImplementation(((path: any, options: any) =>
    ["/tmp", "/var", "/etc"].includes(String(path)) ? "/unexpected" : realpath(path, options)) as any);
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    expect(() => new GuiChannel(join(f.root, "new/outbox"), [])).toThrow("symlink");
    expect(existsSync(join(f.root, "new"))).toBe(false);
  } finally { statSpy.mockRestore(); pathSpy.mockRestore(); Object.defineProperty(process, "platform", platform); }
});
