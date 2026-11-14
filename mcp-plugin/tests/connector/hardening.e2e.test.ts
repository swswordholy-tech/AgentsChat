import { afterEach, expect, test } from "bun:test";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUpgradeToken } from "../../connector/auth.ts";
import { startConnector, type AgentsChatHooks } from "../../connector/server.ts";
import type { Identity } from "../../connector/identities.ts";

const a: Identity = { botId: "agent-a", agentId: "agent-a", token: "ac_a", gatewayId: "gw-a", secret: "secret-a" };
const b: Identity = { botId: "agent-b", agentId: "agent-b", token: "ac_b", gatewayId: "gw-b", secret: "secret-b" };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const settle = () => new Promise(r => setTimeout(r, 30));
function setup(identities = [a, b], extra: Partial<AgentsChatHooks> = {}) {
  const calls: any[] = [];
  const secrets: Record<string, string[]> = {};
  for (const id of identities) (secrets[id.gatewayId] ??= []).push(id.secret);
  const server = startConnector({ port: 0, identities, secrets, agentschat: {
    async sendMessage(botId: string, chatId: string, content: string) { calls.push({ botId, chatId, content }); return { id: content }; },
    async sendTyping(botId, chatId) { calls.push({ botId, chatId, op: "typing" }); },
    async getChatInfo(botId, chatId) { calls.push({ botId, chatId, op: "get_chat_info" }); return { name: botId }; },
    ...extra,
  } });
  cleanup.push(() => server.stop());
  async function dial(id = a) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(id.gatewayId, id.secret, 0)}` } });
    cleanup.push(() => ws.terminate());
    const frames: any[] = [];
    ws.on("message", d => { for (const line of d.toString().trim().split("\n")) frames.push(JSON.parse(line)); });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    async function request(frame: any) {
      const before = frames.length;
      ws.send(JSON.stringify(frame) + "\n");
      for (let n = 0; n < 100; n++) { if (frames.length > before) return frames[before]; await new Promise(r => setTimeout(r, 5)); }
      throw new Error("timed out waiting for frame " + JSON.stringify(frame));
    }
    return { ws, frames, request, hello: (botId = id.botId, platform = "agentschat") => request({ type: "hello", platform, botId }) };
  }
  return { server, calls, dial };
}
const outbound = (botId?: string, op = "send", content = "reply") => ({ type: "outbound", requestId: content, platform: "agentschat", ...(botId === undefined ? {} : { botId }), action: { op, chat_id: "same-chat", content } });
const message = (id: string, content: string, extra = {}) => ({ id, channel_id: "same-chat", sender_id: "human", content, ...extra });

test("single-identity DM compatibility never overrides an explicit unknown owner", async () => {
  const { server, dial } = setup([a]);
  const client = await dial(); await client.hello();
  for (const owner of [{ __botId: b.botId }, { dm_owner: b.botId }]) {
    await server.injectAgentsChatMessage(message(JSON.stringify(owner), "private", { channel_id: "dm-private", ...owner }));
  }
  await settle();
  expect(client.frames.filter(f => f.type === "inbound")).toEqual([]);
  await server.injectAgentsChatMessage(message("legacy-dm", "private", { channel_id: "dm-private" }));
  await settle();
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["legacy-dm"]);
});

test("shared repeated-hello clients must tag concurrent replies explicitly", async () => {
  const sharedB = { ...b, gatewayId: a.gatewayId, secret: a.secret };
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const completed: string[] = [];
  const { server, dial } = setup([a, sharedB], { async sendMessage(botId) {
    if (botId === a.botId) await gate;
    completed.push(botId); return { id: botId };
  } });
  cleanup.push(release);
  const client = await dial();
  expect((await client.hello(a.botId)).type).toBe("descriptor");
  expect((await client.hello(b.botId)).type).toBe("descriptor");
  await server.injectAgentsChatMessage(message("shared-multi", "@agent-a @agent-b"));
  await settle();
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.source.profile).sort()).toEqual([a.botId, b.botId]);
  expect((await client.request(outbound())).result.success).toBe(false);
  client.ws.send(JSON.stringify(outbound(a.botId, "send", "slow-a")));
  client.ws.send(JSON.stringify(outbound(b.botId, "send", "fast-b")));
  await settle();
  expect(completed).toEqual([b.botId]);
  release(); await settle();
  expect(client.frames.filter(f => ["fast-b", "slow-a"].includes(f.requestId)).map(f => [f.requestId, f.result.message_id])).toEqual([["fast-b", b.botId], ["slow-a", a.botId]]);
});

test("concurrent mention context windows advance in arrival order per identity and chat", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const contexts: any[] = [];
  const { server, dial } = setup([a], { async getChannelContext(botId, chatId, since, exclude) {
    contexts.push({ since, exclude });
    if (exclude === "first") await gate;
    return [];
  } });
  cleanup.push(release);
  const client = await dial(); await client.hello();
  const first = server.injectAgentsChatMessage(message("first", "@agent-a", { timestamp: "2026-09-01T00:00:01Z" }));
  const second = server.injectAgentsChatMessage(message("second", "@agent-a", { timestamp: "2026-09-01T00:00:02Z" }));
  await settle();
  expect(contexts).toEqual([{ since: undefined, exclude: "first" }]);
  release(); await Promise.all([first, second]); await settle();
  expect(contexts).toEqual([{ since: undefined, exclude: "first" }, { since: "2026-09-01T00:00:01Z", exclude: "second" }]);
  expect(client.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["first", "second"]);
  await server.injectAgentsChatMessage(message("older-backfill", "@agent-a", { timestamp: "2026-09-01T00:00:00Z" }));
  await server.injectAgentsChatMessage(message("after-backfill", "@agent-a", { timestamp: "2026-09-01T00:00:03Z" }));
  expect(contexts.at(-1).since).toBe("2026-09-01T00:00:02Z");
});

test("display-name text cannot impersonate a different exact mention target", async () => {
  const { server, dial } = setup();
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("display", "@agent-a(agent-b)"));
  await server.injectAgentsChatMessage(message("cross-text", "@someone unrelated text (agent-a)"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound")).toEqual([]);
  expect(cb.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["display"]);
});

test("overlapping gateway reconnects do not duplicate one target delivery", async () => {
  const { server, dial } = setup([a]);
  const first = await dial(), second = await dial();
  await first.hello(); await second.hello();
  await server.injectAgentsChatMessage(message("overlap", "@agent-a hi"));
  await settle();
  expect([first, second].flatMap(c => c.frames.filter(f => f.type === "inbound"))).toHaveLength(1);
});

test("explicit malformed outbound identities are not treated as missing", async () => {
  const { dial, calls } = setup([a]);
  const client = await dial(); await client.hello();
  for (const botId of ["", null, 7, {}, "unknown"]) {
    expect((await client.request({ ...outbound(), botId })).result.success).toBe(false);
  }
  expect(calls).toEqual([]);
});

test("mirrored concurrent platform events dedupe per message and target", async () => {
  const { server, dial } = setup([a, b], { async getChannelContext() { await settle(); return []; } });
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await Promise.all([a, b].map(id => server.injectAgentsChatMessage(message("mirrored", "@agent-a @agent-b", { __botId: id.botId }))));
  await settle();
  for (const c of [ca, cb]) expect(c.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["mirrored"]);
  // Missing receiver does not consume that target's delivery key.
  const next = { ...b, botId: "agent-c", agentId: "agent-c" };
  server.reloadIdentities([a, b, next]);
  await server.injectAgentsChatMessage(message("late", "@agent-a @agent-c"));
  const cc = await dial(next); await cc.hello();
  await server.injectAgentsChatMessage(message("late", "@agent-a @agent-c"));
  await settle();
  expect(cc.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["late"]);
  expect(ca.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["mirrored", "late"]);
});

test("one exact multi-mention reaches each target on separate authenticated gateways", async () => {
  const { server, dial } = setup();
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("multi", "@agent-a and @Bee(agent-b) and @agent-a"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["multi"]);
  expect(cb.frames.filter(f => f.type === "inbound").map(f => f.event.message_id)).toEqual(["multi"]);
  await server.injectAgentsChatMessage(message("not-exact", "@agent-a-suffix @agent-b-suffix (agent-a)"));
  await settle();
  expect(ca.frames.filter(f => f.type === "inbound")).toHaveLength(1);
  expect(cb.frames.filter(f => f.type === "inbound")).toHaveLength(1);
});

test("reload revokes old credentials even while inbound context is in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const { server, dial, calls } = setup([a], { async getChannelContext() { entered(); await gate; return []; } });
  cleanup.push(release);
  const client = await dial(); await client.hello();
  const pending = server.injectAgentsChatMessage(message("revoked", "@agent-a hi"));
  await started;
  server.reloadIdentities([{ ...a, secret: "rotated" }]);
  release(); await pending; await settle();
  expect(client.frames.filter(f => f.type === "inbound")).toEqual([]);
  expect((await client.request(outbound(a.botId))).result.success).toBe(false);
  expect((await client.hello()).type).toBe("error");
  expect(calls).toEqual([]);
  const fresh = await dial({ ...a, secret: "rotated" });
  expect((await fresh.hello()).type).toBe("descriptor");
});

test("reverse-order concurrent replies keep explicit identity despite interleaved same-chat inbound", async () => {
  let finishA!: () => void;
  let startedA!: () => void;
  const aStarted = new Promise<void>(r => { startedA = r; });
  const aRelease = new Promise<void>(r => { finishA = r; });
  const completed: string[] = [];
  const { server, dial } = setup([a, b], { async sendMessage(botId) {
    if (botId === a.botId) { startedA(); await aRelease; }
    completed.push(botId); return { id: botId };
  } });
  cleanup.push(finishA);
  const ca = await dial(a), cb = await dial(b);
  await ca.hello(); await cb.hello();
  await server.injectAgentsChatMessage(message("a-first", "@agent-a hi"));
  await server.injectAgentsChatMessage(message("b-second", "@agent-b hi"));
  await settle();
  const replyA = ca.request(outbound(a.botId, "send", "a-reply"));
  const replyB = cb.request(outbound(b.botId, "send", "b-reply"));
  expect((await replyB).result.message_id).toBe(b.botId);
  // A must be in flight, not incorrectly completed using B's sticky credentials.
  await Promise.race([aStarted, settle()]);
  expect(completed).toEqual([b.botId]);
  finishA();
  expect((await replyA).result.message_id).toBe(a.botId);
  expect(completed).toEqual([b.botId, a.botId]);
});

test("outbound requires an authorized hello on this connection for every operation", async () => {
  const { dial, calls } = setup();
  const client = await dial();
  expect((await client.request(outbound(a.botId))).result.success).toBe(false);
  await client.hello();
  for (const op of ["send", "typing", "get_chat_info"]) {
    expect((await client.request(outbound(b.botId, op))).result.success).toBe(false);
    expect((await client.request({ ...outbound(a.botId, op), platform: "other" })).result.success).toBe(false);
  }
  expect(calls).toEqual([]);
  expect((await client.request(outbound())).result.success).toBe(true);
  expect(calls).toEqual([{ botId: a.botId, chatId: "same-chat", content: "reply" }]);
});

test("configured single identity rejects unknown botId and wrong platform", async () => {
  const { dial } = setup([a]);
  // A rejected handshake now closes the connection; each attempt must redial.
  expect((await (await dial()).hello("unknown")).type).toBe("error");
  expect((await (await dial()).hello(a.botId, "other")).type).toBe("error");
  expect((await (await dial()).request({ type: "hello", platform: "agentschat" })).type).toBe("error");
  expect((await (await dial()).hello()).type).toBe("descriptor");
});

test("hello is bound to BOTH authenticated gateway and signing secret", async () => {
  const c = { ...b, botId: "agent-c", agentId: "agent-c", gatewayId: a.gatewayId };
  const { dial } = setup([a, b, c]);
  expect((await (await dial()).hello(b.botId)).type).toBe("error");
  expect((await (await dial()).hello(c.botId)).type).toBe("error");
  expect((await (await dial()).hello()).type).toBe("descriptor");
});

test("all outbound hooks reject malformed chat IDs before platform IO and accept boundary IDs", async () => {
  const { server, dial, calls } = setup([a]); await server.ready;
  const client = await dial(); await client.hello();
  for (const chat_id of [undefined, null, 0, true, {}, [], "", " x", "x ", ".", "..", "a..b", "a/b", "a\\b", "a\0b", "a\nb", "a\x7fb", "__proto__", "CONSTRUCTOR", "Prototype", "a".repeat(129)]) {
    for (const op of ["send", "typing", "get_chat_info"]) {
      const frame = outbound(a.botId, op); (frame.action as any).chat_id = chat_id;
      expect((await client.request(frame)).result).toEqual({ success: false, error: "invalid chat_id" });
    }
  }
  expect(calls).toEqual([]);
  for (const chat_id of ["a", "x".repeat(128), "dm:peer", "DM-peer", "toString", "room.1", "中文频道"]) {
    for (const op of ["send", "typing", "get_chat_info"]) {
      const frame = outbound(a.botId, op); frame.action.chat_id = chat_id;
      await client.request(frame);
    }
  }
  expect(calls).toHaveLength(21);
  expect(calls.filter(call => call.chatId === "dm:peer")).toHaveLength(3);
});

test("relay batches allow 128 non-empty lines and reject 129 before any hook runs", async () => {
  const { server, dial, calls } = setup([a]); await server.ready;
  const client = await dial(); await client.hello();
  const line = JSON.stringify(outbound(a.botId));
  client.ws.send(("\n  \n" + line + "\n").repeat(128));
  for (let n = 0; n < 100 && calls.length < 128; n++) await new Promise(r => setTimeout(r, 5));
  expect(calls).toHaveLength(128);
  const closed = new Promise<[number, string]>(resolve => client.ws.once("close", (code, reason) => resolve([code, reason.toString()])));
  client.ws.send((line + "\n").repeat(129));
  expect(await closed).toEqual([1009, "batch too large"]);
  expect(calls).toHaveLength(128);
});

test("relay raw-message ceiling counts bytes and preserves exact 2 MiB messages", async () => {
  const { server, dial, calls } = setup([a]); await server.ready;
  const client = await dial(); await client.hello();
  const cap = 2 * 1024 * 1024;
  // Whitespace keeps the exact-boundary message a single valid outbound frame.
  const line = JSON.stringify(outbound(a.botId));
  const frame = line + " ".repeat(cap - Buffer.byteLength(line));
  client.ws.send(frame);
  for (let n = 0; n < 100 && calls.length < 1; n++) await new Promise(r => setTimeout(r, 5));
  expect(calls).toHaveLength(1);
  const closed = new Promise<number>(resolve => client.ws.once("close", resolve));
  client.ws.send("汉".repeat(Math.floor(cap / 3) + 1));
  expect(await closed).toBe(1009);
  expect(calls).toHaveLength(1);
});

test("upgrade authorization is bounded before trimming even when the inner token is valid", async () => {
  const { server } = setup([a]); await server.ready;
  const token = `Bearer ${makeUpgradeToken(a.gatewayId, a.secret, 0)}`;
  async function upgrade(length: number, accepted: boolean) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/relay`, {
      // Internal whitespace survives HTTP header parsing, then token.trim() would remove it.
      headers: { Authorization: "Bearer " + " ".repeat(length - token.length) + token.slice(7) },
    });
    cleanup.push(() => ws.terminate());
    if (accepted) {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      ws.close();
    } else {
      const code = await new Promise<number>((resolve, reject) => { ws.once("close", resolve); ws.once("error", reject); });
      expect(code).toBe(4401);
    }
  }
  await upgrade(8192, true);
  await upgrade(8193, false);
});

test("real CLI refuses authenticated redirects in all six HTTP paths with RELAY_PORT=0", async () => {
  const seen: string[] = [], leaked: string[] = [];
  let redirectMine = false;
  const upstream = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    if (req.url === "/trap") {
      leaked.push(req.headers.authorization ?? "missing");
      res.end("{}"); return;
    }
    seen.push(key);
    expect(req.headers.authorization).toBe(`Bearer ${a.token}`);
    if (req.url === "/api/channels/mine" && !redirectMine) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ id: "same-chat" }])); return;
    }
    res.writeHead(307, { Location: "/trap" }); res.end();
  });
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", ws => {
    sockets.add(ws);
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "auth") ws.send(JSON.stringify({ type: "auth_ok" }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as { port: number };
  const cursorDir = mkdtempSync(join(tmpdir(), "connector-redirects-"));
  const child = Bun.spawn([process.execPath, new URL("../../connector/run.ts", import.meta.url).pathname], {
    env: { ...process.env, RELAY_IDENTITIES_FILE: "", RELAY_IDENTITIES: JSON.stringify([a]),
      RELAY_PORT: "0", AGENTCHAT_CURSOR_DIR: cursorDir, AGENTCHAT_API_URL: `http://127.0.0.1:${address.port}`,
      AGENTCHAT_WS_URL: `ws://127.0.0.1:${address.port}/ws`,
    }, stdout: "ignore", stderr: "pipe",
  });
  let output = "";
  const logs = (async () => {
    const reader = child.stderr.getReader(), decoder = new TextDecoder();
    for (;;) { const { done, value } = await reader.read(); if (done) break; output += decoder.decode(value); }
  })();
  let relay: WebSocket | undefined;
  async function until(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}; seen=${JSON.stringify(seen)}; logs=${output}`);
      await new Promise(r => setTimeout(r, 5));
    }
  }
  try {
    await until(() => /listening on .*:(\d+) /.test(output), "CLI listen");
    const port = Number(output.match(/listening on .*:(\d+) /)![1]);
    expect(port).toBeGreaterThan(0);
    relay = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { Authorization: `Bearer ${makeUpgradeToken(a.gatewayId, a.secret, 0)}` } });
    const frames: any[] = [];
    relay.on("message", raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { relay!.once("open", resolve); relay!.once("error", reject); });
    relay.send(JSON.stringify({ type: "hello", platform: "agentschat", botId: a.botId }));
    await until(() => frames.some(f => f.type === "descriptor"), "hello");
    for (const op of ["send", "get_chat_info"]) relay.send(JSON.stringify(outbound(a.botId, op, op)));
    await until(() => frames.filter(f => f.type === "outbound_result").length === 2, "outbound redirects");
    for (const f of frames.filter(f => f.type === "outbound_result")) expect(f.result.success).toBe(false);
    await until(() => sockets.size === 1, "upstream WS");
    const ws = [...sockets][0];
    await until(() => seen.includes("GET /api/channels/same-chat/messages?limit=1"), "scheduled backfill");
    ws.send(JSON.stringify({ ...message("context-trigger", "@agent-a hi"), type: "message" }));
    ws.send(JSON.stringify({ ...message("tick-trigger", "(loop tick — check)"), type: "message", sender_id: a.agentId,
      sender_type: "agent", content_type: "text", timestamp: "2026-11-14T00:00:00Z",
      meta: { kind: "loop_tick", loop_id: "loop_test", prompt: "check", interval_ms: 60000, next_tick_ms: 120000, expires_at: null },
    }));
    await until(() => seen.includes("GET /api/channels/same-chat/messages?limit=50") && seen.includes("GET /api/loops/mine"), "context and loops");
    redirectMine = true;
    ws.send(JSON.stringify({ type: "auth_ok" }));
    await until(() => seen.filter(s => s === "GET /api/channels/mine").length === 2, "membership redirect");
    await until(() => output.includes("join-on-auth failed"), "membership redirect refused");
    expect(new Set(seen).size).toBe(6);
    expect(leaked).toEqual([]);
  } finally {
    relay?.terminate();
    child.kill("SIGTERM");
    await child.exited; await logs;
    for (const ws of sockets) ws.terminate();
    wss.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    rmSync(cursorDir, { recursive: true, force: true });
  }
}, 10000);
