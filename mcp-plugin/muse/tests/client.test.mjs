import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { MuseAgentChatClient } from "../src/client.ts";

/**
 * Minimal dependency-free WebSocket server: just enough of RFC 6455 to
 * prove the client handshake (auth -> auth_ok), join, message send/receive
 * and reconnect. Client frames are masked; server frames are not.
 */
class MockServer {
  constructor() {
    this.received = [];
    this.connections = 0;
    this.sockets = [];
    this.onMessage = null;
    this.server = createServer();
    this.server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.connections += 1;
      this.sockets.push(socket);
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) break;
          const opcode = buf[0] & 0x0f;
          const masked = buf[1] & 0x80;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) break;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < off + maskLen + len) break;
          const mask = buf.subarray(off, off + maskLen);
          const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
          if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          buf = buf.subarray(off + maskLen + len);
          if (opcode === 8) {
            try {
              socket.write(Buffer.from([0x88, 0x00]));
            } catch {}
            socket.end();
            return;
          }
          if (opcode === 1) {
            const parsed = JSON.parse(payload.toString());
            this.received.push(parsed);
            this.onMessage?.(parsed, socket);
          }
        }
      });
    });
  }

  send(socket, obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  async listen() {
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    return this.server.address().port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }
}

function waitFor(pred, label, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("client auth, join, send and receive work end to end", async () => {
  const server = new MockServer();
  const port = await server.listen();
  const inbound = [];
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: "sess-1" });
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "secret-token",
    heartbeatIntervalMs: 60_000,
    reconnect: false,
  });
  client.onMessage((m) => inbound.push(m));
  try {
    await client.connect();
    assert.equal(client.isConnected, true);
    assert.equal(client.session, "sess-1");
    await waitFor(() => server.received.some((m) => m.type === "auth"), "auth");
    const auth = server.received.find((m) => m.type === "auth");
    assert.equal(auth.agent_id, "muse-bot");
    assert.equal(auth.token, "secret-token");

    client.joinChannel("general");
    await waitFor(() => server.received.some((m) => m.type === "join_channel"), "join");
    // Server echoes a message back into the channel.
    server.send(server.sockets[0], {
      type: "message",
      id: "m1",
      channel_id: "general",
      sender_id: "alice",
      sender_type: "agent",
      content: "hello @muse-bot",
      content_type: "text",
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => inbound.length > 0, "inbound message");
    assert.equal(inbound[0].content, "hello @muse-bot");

    client.sendMessage("general", "pong");
    await waitFor(() => server.received.some((m) => m.type === "message" && m.content === "pong"), "sent message");
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("client reconnects after a transient drop and re-authenticates", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: `sess-${server.connections}` });
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    heartbeatIntervalMs: 60_000,
    initialReconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
  });
  try {
    await client.connect();
    assert.equal(server.connections, 1);
    // Kill the socket from the server side; client must come back on its own.
    server.sockets[0].destroy();
    await waitFor(() => server.connections >= 2, "reconnect", 5000);
    await waitFor(() => client.isConnected, "re-authenticated", 5000);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("auth_error rejects connect() immediately and stops reconnect loops", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") {
      server.send(socket, { type: "auth_error", error: "invalid_token" });
    }
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "bad-token",
    initialReconnectDelayMs: 25,
    maxReconnectDelayMs: 50,
  });
  try {
    await assert.rejects(() => client.connect(), /invalid_token/);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(server.connections, 1);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("connectTimeoutMs rejects stalled auth handshakes cleanly", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = () => {
    // Intentionally never reply to auth
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    connectTimeoutMs: 80,
    initialReconnectDelayMs: 25,
  });
  try {
    await assert.rejects(() => client.connect(), /timed out/);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(server.connections, 1);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("thread_reply delivery, shard_moved reconnect, and async onMessage error routing", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") {
      server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: `s-${server.connections}` });
    }
  };
  const inbound = [];
  const errors = [];
  let reconnected = 0;
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    heartbeatIntervalMs: 60_000,
    initialReconnectDelayMs: 5_000,
    maxReconnectDelayMs: 10_000,
    onReconnect: () => {
      reconnected += 1;
    },
  });
  client.onError((err) => errors.push(err.message));
  client.onMessage(async (m) => {
    inbound.push(m);
    if (m.content === "boom") throw new Error("handler_boom");
  });
  try {
    await client.connect();
    server.send(server.sockets[0], {
      type: "thread_reply",
      id: "tr1",
      channel_id: "general",
      parent_id: "root-99",
      sender_id: "alice",
      sender_type: "agent",
      content: "boom",
      content_type: "text",
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => inbound.length === 1 && errors.includes("handler_boom"), "thread_reply + async error");
    assert.equal(inbound[0].thread_id, "root-99");

    // shard_moved with within_ms:50 should bypass the 5_000ms exponential backoff ([200ms, 250ms))
    server.send(server.sockets[0], { type: "shard_moved", within_ms: 50 });
    await waitFor(() => reconnected >= 1 && client.session === "s-2", "fast shard_moved reconnect", 1500);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("reconnect auth timeout recovers from stalled half-open socket and re-joins channel_created rooms without duplicates", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") {
      // Connection #2 stalls without sending auth_ok; connections #1 and #3 succeed!
      if (server.connections === 2) return;
      server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: `s-${server.connections}` });
    }
  };
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    connectTimeoutMs: 80,
    heartbeatIntervalMs: 60_000,
    initialReconnectDelayMs: 30,
    maxReconnectDelayMs: 60,
    onReconnect: () => {
      client.joinChannel("static-room");
    },
  });
  try {
    await client.connect();
    client.joinChannel("static-room");
    // Runtime channel_created joins dm-runtime-1
    server.send(server.sockets[0], { type: "channel_created", channel_id: "dm-runtime-1" });
    await waitFor(
      () => server.received.filter((m) => m.type === "join_channel" && m.channel_id === "dm-runtime-1").length === 1,
      "initial channel_created join",
    );

    // Drop connection #1 -> connection #2 hangs on auth -> times out after 80ms -> connection #3 recovers!
    server.received.length = 0;
    server.sockets[0].destroy();
    await waitFor(() => client.session === "s-3", "recovery onto connection #3 after stalled #2", 3000);
    await waitFor(
      () => server.received.filter((m) => m.type === "join_channel").length >= 2,
      "rejoin both static and runtime channels",
    );
    const rejoined = server.received.filter((m) => m.type === "join_channel").map((m) => m.channel_id);
    assert.deepEqual(rejoined, ["static-room", "dm-runtime-1"]);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("Campaign #97: MuseAgentChatClient ignores non-object/array frames, caps joinedChannels, and avoids backoff NaN overflow", async () => {
  const server = new MockServer();
  const port = await server.listen();
  server.onMessage = (msg, socket) => {
    if (msg.type === "auth") {
      server.send(socket, { type: "auth_ok", agent_id: msg.agent_id, session_id: `s-${server.connections}` });
    }
  };
  const debugEvents = [];
  const client = new MuseAgentChatClient({
    url: `ws://127.0.0.1:${port}`,
    agentId: "muse-bot",
    token: "t",
    initialReconnectDelayMs: 0,
    maxReconnectDelayMs: 50,
    onDebug: (event, meta) => debugEvents.push({ event, meta }),
  });
  try {
    await client.connect();
    // Non-object / array frames must be ignored cleanly without throwing
    client.handleMessage("null");
    client.handleMessage("123");
    client.handleMessage('["array","frame"]');
    // Control-char / oversize channel_created must be rejected, and valid channels capped at 256
    client.handleMessage(JSON.stringify({ type: "channel_created", channel_id: "bad\nroom" }));
    for (let i = 0; i < 270; i++) {
      client.joinChannel(`room-${i}`);
    }
    assert.equal(client.joinedChannels.size, 256);

    // Simulate extreme reconnectAttempt=2000 with initialReconnectDelayMs=0 (previously 0 * Infinity === NaN!)
    client.reconnectAttempt = 2000;
    server.sockets[0].destroy();
    await waitFor(() => debugEvents.some((e) => e.event === "reconnect:scheduled"), "reconnect scheduled");
    const sched = debugEvents.find((e) => e.event === "reconnect:scheduled");
    assert.equal(Number.isFinite(sched.meta.delayMs), true);
    assert.equal(sched.meta.delayMs, 0);
  } finally {
    client.disconnect();
    await server.close();
  }
});

test("constructor requires credential-free wss or loopback ws URLs", () => {
  const options = { agentId: "muse-bot", token: "t" };
  for (const url of ["wss://agents-chat.com/ws", "ws://127.0.0.1:1", "ws://localhost/ws", "ws://LOCALHOST:99", "ws://[::1]:80/ws"]) {
    assert.doesNotThrow(() => new MuseAgentChatClient({ ...options, url }));
  }
  for (const url of ["bad-url", "https://agents-chat.com", "file:///tmp/ws", "ws://agents-chat.com", "ws://localhost.evil", "ws://192.168.1.1", "wss://user:secret@agents-chat.com", "ws://user@localhost", "wss://:secret@localhost"]) {
    assert.throws(() => new MuseAgentChatClient({ ...options, url }), /Muse.*URL|credentials/);
  }
});

function fakeSockets(t) {
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    closeCalls = 0;
    constructor() { sockets.push(this); }
    send(raw) {
      if (this.sendError) throw new Error(this.sendError);
      this.sent.push(JSON.parse(raw));
    }
    close() { this.closeCalls += 1; this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  t.after(() => Object.defineProperty(globalThis, "WebSocket", original));
  const client = new MuseAgentChatClient({ url: "ws://localhost:1", agentId: "muse-bot", token: "t", connectTimeoutMs: 0 });
  t.after(() => client.disconnect());
  return { sockets, client };
}

test("repeated connect ignores every stale socket callback and heartbeat", async (t) => {
  const { sockets, client } = fakeSockets(t);
  const heartbeats = [];
  t.mock.method(globalThis, "setInterval", (callback) => { heartbeats.push(callback); return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const errors = [];
  const inbound = [];
  client.onError((err) => errors.push(err.message));
  client.onMessage((m) => inbound.push(m));
  const first = client.connect();
  const old = sockets[0];
  old.open(); old.frame({ type: "auth_ok", session_id: "old" });
  await first;
  const second = client.connect();
  const current = sockets[1];
  const before = old.sent.length;
  old.onopen();
  old.frame({ type: "auth_ok", session_id: "stale" });
  old.frame({ type: "message", content: "stale" });
  old.frame({ type: "auth_error", error: "stale error" });
  old.onerror(); old.onclose(); heartbeats[0]();
  assert.equal(old.sent.length, before);
  assert.equal(client.session, null);
  assert.equal(client.heartbeatTimer, null);
  assert.equal(client.reconnectTimer, null);
  assert.deepEqual(errors, []);
  assert.deepEqual(inbound, []);
  current.open(); current.frame({ type: "auth_ok", session_id: "current" });
  await second;
  const timer = client.heartbeatTimer;
  old.onclose(); old.onerror(); old.frame({ type: "auth_ok", session_id: "stale-again" });
  assert.equal(client.session, "current");
  assert.equal(client.heartbeatTimer, timer);
  heartbeats[1]();
  assert.equal(current.sent.at(-1).type, "ping");
  current.frame({ type: "message", content: "fresh" });
  assert.equal(inbound[0].content, "fresh");
});

test("disconnect detaches socket before synchronous close and settles pending lifecycle", async (t) => {
  const { sockets, client } = fakeSockets(t);
  const errors = [];
  client.onError((err) => errors.push(err.message));
  const connecting = assert.rejects(client.connect(), /Disconnected before authentication/);
  const closed = client.waitUntilClosed();
  const old = sockets[0];
  let detached = false;
  old.close = () => {
    detached = client.ws === null;
    old.onclose();
    old.onerror();
    old.frame({ type: "auth_ok", session_id: "late" });
    throw new Error("close failed");
  };
  assert.doesNotThrow(() => client.disconnect());
  await connecting;
  await closed;
  assert.equal(detached, true);
  assert.equal(client.ws, null);
  assert.equal(client.session, null);
  assert.equal(client.reconnectTimer, null);
  assert.equal(client.lifecycleResolve, null);
  assert.deepEqual(errors, []);
});

test("synchronous auth send failure rejects connect and reports through onError", async (t) => {
  const { sockets, client } = fakeSockets(t);
  const errors = [];
  client.onError((err) => errors.push(err.message));
  const rejected = assert.rejects(client.connect(), /auth send failed/);
  sockets[0].sendError = "auth send failed";
  assert.doesNotThrow(() => sockets[0].open());
  await rejected;
  assert.deepEqual(errors, ["auth send failed"]);
  assert.equal(sockets[0].closeCalls, 1);
  assert.equal(client.heartbeatTimer, null);
});

test("heartbeat catches synchronous send failure and closes for reconnect", async (t) => {
  const { sockets, client } = fakeSockets(t);
  let heartbeat;
  t.mock.method(globalThis, "setInterval", (callback) => { heartbeat = callback; return { unref() {} }; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const errors = [];
  client.onError((err) => errors.push(err.message));
  const connected = client.connect();
  sockets[0].open(); sockets[0].frame({ type: "auth_ok", session_id: "s" });
  await connected;
  sockets[0].sendError = "ping send failed";
  assert.doesNotThrow(() => heartbeat());
  assert.deepEqual(errors, ["ping send failed"]);
  assert.equal(sockets[0].closeCalls, 1);
  assert.equal(client.session, null);
  assert.notEqual(client.reconnectTimer, null);
  client.disconnect();
  assert.doesNotThrow(() => heartbeat());
  assert.deepEqual(errors, ["ping send failed"]);
});
