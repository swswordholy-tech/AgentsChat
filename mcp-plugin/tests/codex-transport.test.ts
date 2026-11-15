/** Transport resource ownership: bounded HTTP bodies and one live connection per instance. */
import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { BridgeConfig } from "../codex/config.ts";
import { AgentsChatTransport } from "../codex/transport.ts";

const config = { apiUrl: "https://example.test", wsUrl: "ws://127.0.0.1", token: "synthetic", agentId: "bot", channels: [] } as unknown as BridgeConfig;
const wait = async (condition: () => boolean) => {
  const end = Date.now() + 3000;
  while (!condition()) { if (Date.now() > end) throw new Error("Transport fixture timeout"); await Bun.sleep(5); }
};
async function responseTest(response: Response, run: (t: AgentsChatTransport) => Promise<void>) {
  const stub = spyOn(globalThis, "fetch").mockResolvedValue(response);
  const t = new AgentsChatTransport(config, () => {}, () => {});
  try { await run(t); } finally { t.stop(); stub.mockRestore(); }
}

test("HTTP errors cancel response bodies and retain safe status errors even if cancel fails", async () => {
  for (const fails of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; if (fails) throw Error("private body"); } });
    await responseTest(new Response(body, { status: 503 }), async t => {
      await expect(t.api("/error")).rejects.toThrow("AgentsChat HTTP 503");
      expect(cancelled).toBe(true); expect(body.locked).toBe(false);
    });
  }
});

test("successful JSON is bounded by actual bytes, accepts exactly 4 MiB and split UTF-8", async () => {
  const prefix = new TextEncoder().encode('{"value":"🙂"}');
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(32); bytes.set(prefix);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    if (offset === bytes.length) { c.close(); return; }
    const end = Math.min(bytes.length, offset === 0 ? 12 : offset + 65536);
    c.enqueue(bytes.subarray(offset, end)); offset = end;
  } });
  await responseTest(new Response(body), async t => {
    expect(await t.api("/exact")).toEqual({ value: "🙂" }); expect(body.locked).toBe(false);
  });
});

test("oversized success streams cancel immediately without draining or trusting Content-Length", async () => {
  for (const cancelFails of [false, true]) {
    let cancelled = false, pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; if (pulls > 65) { c.close(); return; } c.enqueue(new Uint8Array(65536).fill(32)); },
      cancel() { cancelled = true; if (cancelFails) throw Error("private cancel detail"); },
    }, { highWaterMark: 0 });
    await responseTest(new Response(body, { headers: { "Content-Length": "2" } }), async t => {
      await expect(t.api("/huge")).rejects.toThrow("Invalid AgentsChat response");
      expect(cancelled).toBe(true); expect(pulls).toBe(65); expect(body.locked).toBe(false);
    });
  }
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); c.close(); } });
  await responseTest(new Response(body), async t => { await expect(t.api("/one-byte-over")).rejects.toThrow("Invalid AgentsChat response"); });
});

test("malformed, absent and failed response streams expose only the invalid-response error", async () => {
  for (const response of [new Response("private-not-json"), new Response(null), new Response(new ReadableStream({ start(c) { c.error(Error("private stream failure")); } }))]) {
    await responseTest(response, async t => { await expect(t.api("/bad")).rejects.toThrow("Invalid AgentsChat response"); });
  }
});

test("sync intervals reject invalid values, preserve fast intervals and clamp finite overflow", () => {
  for (const [input, expected] of [[NaN,60000],[Infinity,60000],[-Infinity,60000],[-1,60000],[0,60000],[25,25],[999,999],[1000.9,1000],[60000,60000],[Number.MAX_VALUE,2147483647]]) {
    const t = new AgentsChatTransport(config, () => {}, () => {}, undefined, input);
    expect((t as any).syncIntervalMs).toBe(expected); t.stop();
  }
});

async function socketTest(run: (t: AgentsChatTransport, state: any, ws: WebSocketServer) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "transport-"));
  const http = createServer();
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", socket => socket.on("message", raw => {
    if (JSON.parse(String(raw)).type === "auth") socket.send('{"type":"auth_ok"}');
  }));
  const t = new AgentsChatTransport({ ...config, stateDir: root, wsUrl: `ws://127.0.0.1:${(http.address() as any).port}` }, () => {}, () => {}, () => true, 1000);
  const api = spyOn(t, "api").mockResolvedValue({ channels: [] });
  try { t.start(); await wait(() => (t as any).authenticated); await run(t, t as any, ws); }
  finally { t.stop(); api.mockRestore(); for (const c of ws.clients) c.terminate(); ws.close(); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); rmSync(root, { recursive: true, force: true }); }
}

test("repeated start stops old socket, heartbeat, sync, typing and pending ACK resources", async () => {
  await socketTest(async (t, state, ws) => {
    const oldSocket = state.socket, oldHeartbeat = state.heartbeat;
    let retryFired = false, syncPulses = 0;
    state.retry = setTimeout(() => { retryFired = true; }, 30);
    clearInterval(state.syncTimer); state.syncTimer = setInterval(() => syncPulses++, 5);
    t.setTyping("room", true);
    const pending = t.send("room", "no ACK");
    const rejected = pending.then(() => { throw Error("Expected pending ACK rejection"); }, error => error);
    t.start(); expect((await rejected).message).toContain("acknowledgement unavailable");
    expect(state.authenticated).toBe(false); expect(state.typing.size).toBe(0);
    expect(state.pending.size).toBe(0); expect(oldHeartbeat.timer).toBeNull();
    expect(state.retry).toBeUndefined();
    await wait(() => state.authenticated && ws.clients.size === 1);
    await Bun.sleep(60);
    expect(retryFired).toBe(false); expect(syncPulses).toBe(0);
    expect(state.socket).not.toBe(oldSocket); expect(state.syncTimer).toBeDefined();
  });
});

test("close clears periodic sync and restart cancels scheduled reconnect; stop is idempotent", async () => {
  await socketTest(async (t, state) => {
    state.socket.terminate(); await wait(() => state.retry !== undefined);
    expect(state.syncTimer).toBeUndefined(); expect(state.authenticated).toBe(false);
    t.start(); expect(state.retry).toBeUndefined(); await wait(() => state.authenticated);
    const heartbeat = state.heartbeat;
    t.stop(); t.stop(); t.start();
    expect(state.syncTimer).toBeUndefined(); expect(state.retry).toBeUndefined();
    expect(state.socket).toBeUndefined(); expect(heartbeat.timer).toBeNull();
  });
});

test("typing and control sends tolerate synchronous socket state races", async () => {
  await socketTest(async (t, state) => {
    const stub = spyOn(state.socket, "send").mockImplementation(() => { throw Error("socket closing"); });
    try {
      expect(() => t.setTyping("room", true)).not.toThrow();
      expect(() => state.socket.emit("open")).not.toThrow();
      expect(() => state.socket.emit("message", Buffer.from('{"type":"channel_created","channel_id":"room"}'))).not.toThrow();
      expect(() => state.heartbeat.tick()).not.toThrow();
      t.setTyping("room", false); expect(state.typing.size).toBe(0);
    } finally { stub.mockRestore(); }
  });
});

test("API rejects unsafe paths before credential-bearing requests", async () => {
  const stub = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => new Response('{}'), { preconnect: globalThis.fetch.preconnect }));
  const t = new AgentsChatTransport(config, () => {}, () => {});
  try {
    for (const path of [null, 1, {}, '', 'https://evil.test/x', '//evil.test/x', '/\\evil.test', '/x\n', '/x\x7f', '/..', '/../secret', '/a/../b', '/a/%2e%2E/b', '/%2e%2e%2fsecret', '/a%2f..%2fb', '/%5c%5cevil.test', '/%00', '/%zz']) {
      await expect(t.api(path as any)).rejects.toThrow('Invalid AgentsChat API path');
    }
    expect(stub).not.toHaveBeenCalled();
    for (const path of ['/api/channels/mine', '/api/channels/room/messages?before=a%2Fb', '/ok?value=../x', '/..ordinary']) await expect(t.api(path)).resolves.toEqual({});
    for (const call of stub.mock.calls) {
      expect(new URL(String(call[0])).origin).toBe(config.apiUrl);
      expect((call[1] as RequestInit).headers).toHaveProperty('Authorization', 'Bearer synthetic');
    }
  } finally { t.stop(); stub.mockRestore(); }
});

const unsafeChannels: any[] = [null, 1, {}, '', '   ', '.', '..', 'room.name', 'a/b', 'a\\b', 'room\n', 'room\x7f', '__PrOtO__', 'Constructor', 'PROTOTYPE', 'a'.repeat(129)];
test("send and typing reject unsafe channels before HTTP or timer allocation", async () => {
  const t = new AgentsChatTransport(config, () => {}, () => {});
  const api = spyOn(t, 'api').mockResolvedValue({});
  try {
    for (const channel of unsafeChannels) {
      await expect(t.send(channel, 'text')).rejects.toThrow('Invalid AgentsChat channel');
      expect(() => t.setTyping(channel, true)).toThrow('Invalid AgentsChat channel');
      expect(() => t.setTyping(channel, false)).toThrow('Invalid AgentsChat channel');
    }
    expect(api).not.toHaveBeenCalled(); expect((t as any).typing.size).toBe(0);
    await t.send('a'.repeat(128), 'valid'); await t.send('dm-room_1:bot', 'valid'); expect(api).toHaveBeenCalledTimes(2);
  } finally { t.stop(); api.mockRestore(); }
});

test("non-object WS frames and unsafe joins are ignored", async () => {
  await socketTest(async (t, state) => {
    const send = spyOn(state.socket, 'send'), pong = spyOn(state.heartbeat, 'receivedPong');
    try {
      for (const raw of ['null', '[]', '[{"type":"auth_ok"}]', 'true', '0', '"message"', '{']) expect(() => state.socket.emit('message', Buffer.from(raw))).not.toThrow();
      expect(pong).not.toHaveBeenCalled();
      for (const channel of unsafeChannels) state.socket.emit('message', Buffer.from(JSON.stringify({ type:'channel_created', channel_id:channel })));
      expect(send).not.toHaveBeenCalled();
      state.socket.emit('message', Buffer.from(JSON.stringify({type:'channel_created', channel_id:'a'.repeat(128)})));
      expect(send).toHaveBeenCalledTimes(1); expect(state.authenticated).toBe(true);
    } finally { send.mockRestore(); pong.mockRestore(); }
  });
});

test("membership sync filters unsafe and non-object entries before joining", async () => {
  await socketTest(async (t, state) => {
    (t.api as any).mockResolvedValueOnce({channels:[null, ...unsafeChannels.map(id => ({id})), {id:'room'}, {channel_id:'dm-room_1:bot'}]});
    const send = spyOn(state.socket, 'send');
    try {
      state.socket.emit('message', Buffer.from('{"type":"auth_ok"}')); await wait(() => send.mock.calls.length >= 2);
      expect(send.mock.calls.map(call => JSON.parse(String(call[0])).channel_id)).toEqual(['room','dm-room_1:bot']);
    } finally { send.mockRestore(); }
  });
});

test("typing capacity allows refresh and removal but rejects a 65th channel", async () => {
  await socketTest(async (t, state) => {
    for (let i=0; i<64; i++) t.setTyping(`room-${i}`, true);
    const old = state.typing.get('room-0');
    expect(() => t.setTyping('overflow', true)).toThrow('typing limit'); expect(state.typing.size).toBe(64);
    t.setTyping('room-0', true); expect(state.typing.get('room-0')).not.toBe(old);
    t.setTyping('room-1', false); t.setTyping('overflow', true); expect(state.typing.size).toBe(64);
    t.stop(); expect(state.typing.size).toBe(0);
  });
});

test("pending ACK capacity rejects before sending and releases slots after ACK and stop", async () => {
  await socketTest(async (t, state) => {
    const sends = spyOn(state.socket, 'send'), pending: Promise<unknown>[] = [];
    try {
      for (let i=0; i<256; i++) pending.push(t.send('room','text').catch(error => error));
      expect(state.pending.size).toBe(256);
      await expect(t.send('room','overflow')).rejects.toThrow('pending message limit'); expect(sends).toHaveBeenCalledTimes(256);
      state.socket.emit('message', Buffer.from(JSON.stringify({type:'message_ack', message_id:state.pending.keys().next().value})));
      await pending[0]; expect(state.pending.size).toBe(255);
      pending.push(t.send('room','after ACK').catch(error => error)); expect(state.pending.size).toBe(256);
      t.stop(); await Promise.all(pending); expect(state.pending.size).toBe(0);
    } finally { t.stop(); await Promise.all(pending); sends.mockRestore(); }
  });
});

test("synchronous message send failure releases pending resources", async () => {
  await socketTest(async (t, state) => {
    const send = spyOn(state.socket, 'send').mockImplementation(() => { throw Error('private socket failure'); });
    try { await expect(t.send('room','text')).rejects.toThrow('AgentsChat socket send failed'); expect(state.pending.size).toBe(0); }
    finally { send.mockRestore(); }
  });
});

test("transport rejects padded channel IDs before requests or typing timers", async () => {
  const t = new AgentsChatTransport(config, () => {}, () => {});
  const api = spyOn(t, "api").mockResolvedValue({});
  try {
    for (const channel of [" room", "room ", "\troom", "room\u00a0"]) {
      await expect(t.send(channel, "hello")).rejects.toThrow("Invalid AgentsChat channel");
      expect(() => t.setTyping(channel, true)).toThrow("Invalid AgentsChat channel");
    }
    expect(api).not.toHaveBeenCalled(); expect((t as any).typing.size).toBe(0);
  } finally { t.stop(); api.mockRestore(); }
});

test("API rejects own prototype JSON and invalid UTF-8 while decoding split multibyte characters", async () => {
  let response: () => Response = () => new Response('{}');
  const stub = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => response(), { preconnect: globalThis.fetch.preconnect }));
  const t = new AgentsChatTransport(config, () => {}, () => {});
  try {
    for (const bytes of [new TextEncoder().encode('{"__proto__":{},"ok":true}'),
      Uint8Array.from([...new TextEncoder().encode('{"text":"'), 0xff, ...new TextEncoder().encode('"}')]),
      Uint8Array.from([...new TextEncoder().encode('{"text":"'), 0xe2, 0x82])]) {
      response = () => new Response(bytes);
      await expect(t.api("/test")).rejects.toThrow("Invalid AgentsChat response");
    }
    response = () => new Response(new ReadableStream({ start(c) {
      for (const byte of new TextEncoder().encode('{"text":"你好😀"}')) c.enqueue(Uint8Array.of(byte));
      c.close();
    } }));
    await expect(t.api("/test")).resolves.toEqual({ text: "你好😀" });
    response = () => Response.json([{ id: "room" }]);
    await expect(t.api("/test")).resolves.toEqual([{ id: "room" }]);
  } finally { t.stop(); stub.mockRestore(); }
});

test("WS prototype frames cannot authenticate, join, refresh heartbeat or deliver messages", async () => {
  await socketTest(async (t, state) => {
    const send = spyOn(state.socket, "send"), pong = spyOn(state.heartbeat, "receivedPong");
    const receive = spyOn(state, "receive");
    try {
      state.authenticated = false;
      for (const frame of [
        '{"type":"auth_ok","__proto__":{}}',
        '{"type":"channel_created","channel_id":"room","__proto__":{}}',
        '{"type":"message","content":"bad","__proto__":{}}',
        '{"type":"thread_reply","content":"bad","__proto__":{}}',
      ]) state.socket.emit("message", Buffer.from(frame));
      expect(state.authenticated).toBe(false);
      expect(send).not.toHaveBeenCalled(); expect(pong).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
      state.socket.emit("message", Buffer.from('{"type":"message","content":"valid"}'));
      expect(pong).toHaveBeenCalledTimes(1); expect(receive).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); pong.mockRestore(); receive.mockRestore(); }
  });
});
