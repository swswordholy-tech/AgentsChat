/** Transport resource ownership: bounded HTTP bodies and one live connection per instance. */
import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  const ws = new WebSocketServer({ port: 0 });
  await new Promise<void>(r => ws.once("listening", r));
  ws.on("connection", socket => socket.on("message", raw => {
    if (JSON.parse(String(raw)).type === "auth") socket.send('{"type":"auth_ok"}');
  }));
  const t = new AgentsChatTransport({ ...config, stateDir: root, wsUrl: `ws://127.0.0.1:${(ws.address() as any).port}` }, () => {}, () => {}, () => true, 1000);
  const api = spyOn(t, "api").mockResolvedValue({ channels: [] });
  try { t.start(); await wait(() => (t as any).authenticated); await run(t, t as any, ws); }
  finally { t.stop(); api.mockRestore(); for (const c of ws.clients) c.terminate(); await new Promise<void>(r => ws.close(() => r())); rmSync(root, { recursive: true, force: true }); }
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
