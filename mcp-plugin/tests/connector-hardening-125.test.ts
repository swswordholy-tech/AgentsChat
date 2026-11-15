import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { makeToken, makeUpgradeToken, verifyToken } from "../connector/auth.ts";
import { IdentityTable, requireIdentity, type Identity } from "../connector/identities.ts";
import { toWireEvent } from "../connector/normalize.ts";
import { startConnector, type AgentsChatHooks } from "../connector/server.ts";
import { safeCursorBotFile } from "../connector/backfill.ts";
import { flushCursor } from "../src/read-cursor.ts";
import * as run from "../connector/run.ts";

const id: Identity = { botId: "bot.alpha", agentId: "bot.alpha", token: "ac_fixture", gatewayId: "gateway", secret: "fixture-secret" };
const unsafeIds = ["", ".", "..", "a/b", "a\\b", "a b", "a\t b", "a\n", "a\0", "a\x7f", "__proto__", "CONSTRUCTOR", "prototype", "x".repeat(129)];
const controlChars = [...Array(32)].map((_, i) => String.fromCharCode(i)).concat("\x7f");
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("metadata, link-local and unspecified hosts are blocked on both transports even with insecure opt-in", () => {
  const hosts = ["0.0.0.0", "0", "0x0", "[::]", "[0:0:0:0:0:0:0:0]", "169.254.0.0", "169.254.255.255", "0xa9fe0001", "2851995902", "100.100.100.200", "[fe80::1]", "[febf::abcd]", "[fd00:ec2::254]", "[::ffff:169.254.169.254]", "[::ffff:a9fe:1]", "[::ffff:0.0.0.0]", "[::ffff:100.100.100.200]", "metadata.google.internal", "metadata.google.internal.", "METADATA.GOOG", "x.metadata.goog", "x.y.metadata.goog.", "metadata", "instance-data"];
  for (const host of hosts) for (const insecure of [undefined, "1"]) {
    for (const [key, protocols] of [["AGENTCHAT_API_URL", ["http", "https"]], ["AGENTCHAT_WS_URL", ["ws", "wss"]]] as const) {
      for (const protocol of protocols) expect(() => run.readConnectorConfig({ [key]: `${protocol}://${host}`, AGENTSCHAT_ALLOW_INSECURE_HTTP: insecure })).toThrow(`invalid ${key}`);
    }
  }
});

test("loopback development and ordinary public or private configured hosts keep existing transport policy", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) expect(run.readConnectorConfig({ AGENTCHAT_API_URL: `http://${host}` }).API).toBe(`http://${host}`);
  for (const host of ["agents-chat.com", "10.0.0.1", "192.168.1.2", "[2001:db8::1]", "[fec0::1]", "metadata.goog.example.com", "release.metadata.example.com"]) {
    expect(run.readConnectorConfig({ AGENTCHAT_API_URL: `https://${host}` }).API).toBe(`https://${host}`);
    expect(() => run.readConnectorConfig({ AGENTCHAT_API_URL: `http://${host}` })).toThrow();
    expect(run.readConnectorConfig({ AGENTCHAT_API_URL: `http://${host}`, AGENTSCHAT_ALLOW_INSECURE_HTTP: "1" }).API).toBe(`http://${host}`);
  }
});

test("identity path and length guards cover construction, lookup and atomic replacement while allowing dotted IDs", () => {
  const table = new IdentityTable([id]);
  for (const key of ["botId", "agentId"] as const) for (const bad of unsafeIds) {
    const candidate = { ...id, [key]: bad };
    expect(() => new IdentityTable([candidate])).toThrow();
    expect(() => requireIdentity([candidate], candidate.botId)).toThrow();
    expect(() => table.replace([candidate])).toThrow();
    expect(table.forBot(id.botId)).toEqual(id);
  }
  for (const good of ["bot.alpha", "release-v1.0", "x".repeat(128)]) {
    const candidate = { ...id, botId: good, agentId: good };
    expect(new IdentityTable([candidate]).forBot(good)).toEqual(candidate);
    expect(requireIdentity([candidate], good)).toBe(candidate);
  }
});

test("token signing rejects every C0/DEL payload character but preserves colon and Unicode payloads", () => {
  for (const control of controlChars) expect(() => makeToken(`gateway${control}name`, id.secret)).toThrow("invalid token payload");
  for (const payload of ["gateway:alpha", "机器人", "normal payload", ""]) expect(verifyToken(makeToken(payload, id.secret), [id.secret])).toBe(payload);
});

test("wire metadata strips every C0/DEL character without changing message text or Unicode", () => {
  const controls = controlChars.join("");
  const original = { id: `m${controls}1`, reply_to: `r${controls}1`, channel_id: `dm-${controls}alpha`, sender_id: `user${controls}1`, sender_name: `名${controls}称`, content: `line1\nline2\t${controls}` };
  const saved = { ...original };
  expect(toWireEvent(original)).toEqual({ text: original.content, message_type: "text", message_id: "m1", reply_to_message_id: "r1", source: { platform: "agentschat", chat_id: "dm-alpha", chat_name: "dm-alpha", chat_type: "dm", user_id: "user1", user_name: "名称", thread_id: null } });
  expect(original).toEqual(saved);
  expect(toWireEvent({ channel_id: controls, content: "ignored" })).toBeNull();
  expect(toWireEvent({ channel_id: "release-v1.0", parent_id: `p${controls}1`, sender_id: `u${controls}1` })?.reply_to_message_id).toBe("p1");
  expect(toWireEvent({ channel_id: "release-v1.0", sender_id: `u${controls}1` })?.source.user_name).toBe("u1");
});

test("bounded HTTP JSON rejects an own prototype key and retains ordinary objects, arrays and nested data", async () => {
  await expect(run.readBoundedJson(new Response('{"__proto__":{},"channels":[]}'))).rejects.toThrow("invalid JSON response");
  for (const raw of ['{"channels":[]}', '[{"id":"release-v1.0"}]', '{"nested":{"__proto__":"opaque"}}', 'null']) expect(await run.readBoundedJson(new Response(raw))).toEqual(JSON.parse(raw));
});

test("identity files reject symlinked ancestors as well as leaves and accept a real dotted directory", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "connector125-identities-"));
  const previous = process.env.RELAY_IDENTITIES_FILE;
  try {
    fs.mkdirSync(join(root, "real.v1"));
    const file = join(root, "real.v1", "identities.json");
    fs.writeFileSync(file, JSON.stringify([id]));
    fs.symlinkSync(join(root, "real.v1"), join(root, "alias"));
    fs.symlinkSync(file, join(root, "file-alias"));
    fs.writeFileSync(join(root, "identities.json"), JSON.stringify([id]));
    for (const path of [join(root, "alias", "identities.json"), join(root, "file-alias"), `${root}/alias/../identities.json`]) {
      process.env.RELAY_IDENTITIES_FILE = path;
      expect(() => run.loadIdentities()).toThrow("RELAY_IDENTITIES_FILE could not be read");
    }
    process.env.RELAY_IDENTITIES_FILE = file;
    expect(run.loadIdentities()).toEqual([id]);
  } finally {
    if (previous === undefined) delete process.env.RELAY_IDENTITIES_FILE; else process.env.RELAY_IDENTITIES_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cursor read/write refuses directory leaves, ancestors and regular-file parents without touching targets", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "connector125-cursors-"));
  const warnings: string[] = [];
  try {
    fs.mkdirSync(join(root, "real")); fs.mkdirSync(join(root, "real", "nested"));
    fs.symlinkSync(join(root, "real"), join(root, "alias"));
    fs.writeFileSync(join(root, "not-dir"), "unchanged");
    expect(() => run.assertSafeConnectorAncestors(`${root}/alias/`, true)).toThrow();
    expect(() => run.assertSafeConnectorAncestors(`${root}/alias/..`, true)).toThrow();
    const map = new Map([["release-v1.0", "2026-11-15T00:00:01Z"]]);
    for (const dir of [join(root, "alias"), join(root, "alias", "nested"), join(root, "not-dir"), join(root, "missing")]) {
      const file = safeCursorBotFile(dir, id.botId);
      expect(run.loadConnectorCursor(file, m => warnings.push(m)).size).toBe(0);
      const state = { dirty: true };
      expect(flushCursor(state, () => run.persistConnectorCursor(file, map, m => warnings.push(m)))).toBe(false);
      expect(state.dirty).toBe(true);
    }
    expect(fs.readdirSync(join(root, "real"))).toEqual(["nested"]);
    expect(fs.readFileSync(join(root, "not-dir"), "utf8")).toBe("unchanged");
    const good = safeCursorBotFile(join(root, "real"), id.botId);
    expect(run.persistConnectorCursor(good, map, m => warnings.push(m))).toBe(true);
    expect(run.loadConnectorCursor(good, m => warnings.push(m))).toEqual(map);
    expect(warnings).toHaveLength(8);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cached cursor persistence rechecks directories after an ancestor is replaced by a symlink", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "connector125-swap-"));
  try {
    fs.mkdirSync(join(root, "state"));
    const file = safeCursorBotFile(join(root, "state"), id.botId);
    const initial = new Map([["release-v1.0", "2026-11-15T00:00:01Z"]]);
    expect(run.persistConnectorCursor(file, initial, () => {})).toBe(true);
    fs.renameSync(join(root, "state"), join(root, "moved"));
    fs.symlinkSync(join(root, "moved"), join(root, "state"));
    expect(run.persistConnectorCursor(file, new Map([["other", "later"]]), () => {})).toBe(false);
    expect(run.loadConnectorCursor(file, () => {}).size).toBe(0);
    expect(JSON.parse(fs.readFileSync(join(root, "moved", file.split("/").at(-1)!), "utf8"))).toEqual(Object.fromEntries(initial));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Darwin canonical /tmp /var /etc ancestors are permitted and arbitrary aliases are rejected", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalStat = fs.lstatSync, originalRealpath = fs.realpathSync;
  const rootAliases = ["/tmp", "/var", "/etc"];
  let badTarget = false, badPrivateRoot = false;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: any) => {
    const name = String(path);
    if (rootAliases.includes(name)) return { isSymbolicLink: () => true, isDirectory: () => false };
    if (name === "/private" || rootAliases.some(p => name === `/private${p}`) || ["/var/folders", "/var/folders/fixture"].includes(name)) return { isSymbolicLink: () => name === "/private" && badPrivateRoot, isDirectory: () => true };
    return originalStat(path, options);
  }) as any);
  const realpath = spyOn(fs, "realpathSync").mockImplementation(((path: fs.PathLike, options?: any) => rootAliases.includes(String(path)) ? badTarget ? "/unexpected" : `/private${path}` : originalRealpath(path, options)) as any);
  try {
    for (const alias of rootAliases) expect(() => run.assertSafeConnectorAncestors(`${alias}/identities.json`)).not.toThrow();
    expect(() => run.assertSafeConnectorAncestors("/var/folders/fixture/cursors", false)).not.toThrow();
    badTarget = true;
    expect(() => run.assertSafeConnectorAncestors("/var/identities.json")).toThrow();
    badTarget = false; badPrivateRoot = true;
    expect(() => run.assertSafeConnectorAncestors("/tmp/identities.json")).toThrow();
  } finally { stat.mockRestore(); realpath.mockRestore(); Object.defineProperty(process, "platform", platform); }
});

async function relay(extra: Partial<AgentsChatHooks> = {}) {
  const calls: string[] = [], logs: string[] = [];
  const server = startConnector({ port: 0, identities: [id], secrets: { [id.gatewayId]: [id.secret] }, logger: m => logs.push(m), agentschat: {
    async sendMessage(_bot: string, chat: string) { calls.push(chat); return { id: "sent" }; },
    async getChatInfo(_bot, chat) { calls.push(chat); return { name: chat }; },
    async sendTyping(_bot, chat) { calls.push(chat); }, ...extra,
  } });
  await server.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(id.gatewayId, id.secret)}` } });
  const frames: any[] = [];
  ws.on("message", raw => String(raw).trim().split("\n").forEach(line => frames.push(JSON.parse(line))));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { server, ws, frames, calls, logs, async close() { ws.terminate(); await server.stop(); } };
}

test("relay drops own-__proto__ hello and outbound frames and continues processing the batch", async () => {
  const f = await relay();
  try {
    f.ws.send('{"type":"hello","platform":"agentschat","botId":"bot.alpha","__proto__":{}}\n' + JSON.stringify({ type: "outbound", requestId: "before", action: { op: "send", chat_id: "room" } }));
    await until(() => f.frames.some(x => x.requestId === "before"));
    expect(f.frames.some(x => x.type === "descriptor")).toBe(false);
    expect(f.calls).toEqual([]);
    f.ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: id.botId }));
    await until(() => f.frames.some(x => x.type === "descriptor"));
    f.ws.send('{"type":"outbound","requestId":"bad","action":{"op":"send","chat_id":"room"},"__proto__":{}}\n' + JSON.stringify({ type: "outbound", requestId: "good", action: { op: "send", chat_id: "release-v1.0" } }));
    await until(() => f.frames.some(x => x.requestId === "good"));
    expect(f.frames.some(x => x.requestId === "bad")).toBe(false);
    expect(f.calls).toEqual(["release-v1.0"]);
  } finally { await f.close(); }
});

test("outbound validates interior whitespace and path IDs before every platform operation", async () => {
  const f = await relay();
  try {
    f.ws.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: id.botId }));
    await until(() => f.frames.length === 1);
    let requestId = 0;
    for (const op of ["send", "typing", "get_chat_info"]) for (const chat_id of unsafeIds.concat(["a\u00a0b"])) {
      const request = ++requestId;
      f.ws.send(JSON.stringify({ type: "outbound", requestId: request, action: { op, chat_id } }));
      await until(() => f.frames.some(x => x.requestId === request));
      expect(f.frames.find(x => x.requestId === request).result).toEqual({ success: false, error: "invalid chat_id" });
    }
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test("frame handler errors redact secret-bearing thrown values", async () => {
  const leak = "ghp_" + "x".repeat(36);
  const f = await relay();
  try {
    // Inject a thrown parser-produced value to exercise the frame error boundary.
    const parse = JSON.parse;
    const spy = spyOn(JSON, "parse").mockImplementation((text: string, reviver?: any) => {
      const value = parse(text, reviver);
      if (value?.type === "throw-fixture") Object.defineProperty(value, "type", { get() { throw new Error(leak); } });
      return value;
    });
    try {
      f.ws.send('{"type":"throw-fixture"}\n' + JSON.stringify({ type: "hello", platform: "agentschat", botId: id.botId }));
      await until(() => f.frames.some(x => x.type === "descriptor"));
      expect(f.logs.join("\n")).toContain("frame error:");
      expect(f.logs.join("\n")).not.toContain(leak);
      expect(f.logs.join("\n")).toContain("REDACTED");
    } finally { spy.mockRestore(); }
  } finally { await f.close(); }
});

async function platformFixture(mine: unknown = { channels: [] }) {
  const root = fs.mkdtempSync(join(tmpdir(), "connector125-platform-"));
  const requests: string[] = [], joins: string[] = [];
  let socket: any;
  let mineBody = mine;
  const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/ws" && server.upgrade(req)) return;
    requests.push(path);
    return Response.json(path === "/api/channels/mine" ? mineBody : { messages: [] });
  }, websocket: { message(ws, raw) {
    const frame = JSON.parse(String(raw));
    if (frame.type === "auth") { socket = ws; ws.send(JSON.stringify({ type: "auth_ok" })); }
    if (frame.type === "join_channel") joins.push(frame.channel_id);
    if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  } } });
  const file = join(root, "identities.json");
  fs.writeFileSync(file, JSON.stringify([id]));
  const proc = Bun.spawn([process.execPath, "connector/run.ts"], { cwd: new URL("../", import.meta.url).pathname, env: { PATH: process.env.PATH, HOME: root, RELAY_IDENTITIES_FILE: file, RELAY_PORT: "0", AGENTCHAT_API_URL: `http://127.0.0.1:${hub.port}`, AGENTCHAT_WS_URL: `ws://127.0.0.1:${hub.port}/ws`, AGENTCHAT_CURSOR_DIR: root }, stdout: "ignore", stderr: "pipe" });
  let logs = "";
  const logTask = (async () => {
    const reader = proc.stderr.getReader();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; logs += new TextDecoder().decode(value); }
    } finally { reader.releaseLock(); }
  })();
  return { root, file, requests, joins, proc, logs: () => logs, setMine(value: unknown) { mineBody = value; }, send(raw: string) { socket.send(raw); }, async ready() { await until(() => !!socket); }, async close() { proc.kill(); await proc.exited; await logTask; hub.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("platform membership and channel_created IDs are guarded before joins and REST backfill", async () => {
  const valid = ["release-v1.0", "x".repeat(128)];
  const f = await platformFixture({ channels: [...unsafeIds, ...valid].map(id => ({ id })) });
  try {
    await f.ready();
    await until(() => f.joins.length === valid.length);
    expect(f.joins).toEqual(valid);
    for (const channel_id of unsafeIds) f.send(JSON.stringify({ type: "channel_created", channel_id }));
    f.send(JSON.stringify({ type: "channel_created", channel_id: "created.v1" }));
    await until(() => f.joins.length === 3);
    expect(f.joins).toEqual([...valid, "created.v1"]);
    await until(() => f.requests.filter(p => p.endsWith("/messages")).length === 2);
    expect(f.requests.filter(p => p.endsWith("/messages"))).toEqual(valid.map(v => `/api/channels/${v}/messages`));
  } finally { await f.close(); }
}, 7000);

test("platform WS drops own-__proto__ and null frames without interrupting later valid frames", async () => {
  const f = await platformFixture();
  try {
    await f.ready();
    f.send('{"type":"channel_created","channel_id":"forged","__proto__":{}}');
    f.send('null'); f.send('[]');
    f.send(JSON.stringify({ type: "channel_created", channel_id: "legit.v1" }));
    await until(() => f.joins.length > 0);
    expect(f.joins).toEqual(["legit.v1"]);
    expect(f.proc.exitCode).toBeNull();
  } finally { await f.close(); }
});

test("HTTP own-__proto__ membership lists never join or backfill and failure is logged safely", async () => {
  const f = await platformFixture(JSON.parse('{"__proto__":{},"channels":[{"id":"forged"}]}'));
  try {
    await f.ready();
    await until(() => f.logs().includes("join-on-auth failed"));
    expect(f.joins).toEqual([]);
    expect(f.requests).toEqual(["/api/channels/mine"]);
  } finally { await f.close(); }
});

test("runtime join labels and SIGHUP failures do not log credentials", async () => {
  const leak = "ghp_" + "x".repeat(36);
  const f = await platformFixture();
  try {
    await f.ready();
    f.send(JSON.stringify({ type: "channel_created", channel_id: "release-v1.0", name: leak }));
    await until(() => f.logs().includes("joined channel release-v1.0"));
    fs.writeFileSync(f.file, JSON.stringify([{ ...id, botId: leak, agentId: leak }, { ...id, botId: leak, agentId: leak }]));
    f.proc.kill("SIGHUP");
    await until(() => f.logs().includes("keeping previous identities"));
    expect(f.logs()).not.toContain(leak);
    expect(f.logs()).toContain("REDACTED");
  } finally { await f.close(); }
});
