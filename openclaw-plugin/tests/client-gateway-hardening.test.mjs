import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, statSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { AgentChatClient } = await jiti.import('../src/agentchat-client.ts');
const { agentChatGateway } = await jiti.import('../src/gateway.ts');
const { getGatewayState } = await jiti.import('../src/state.ts');
function client(options = {}) { return new AgentChatClient({ url: 'ws://127.0.0.1:1', agentId: 'bot', ...options }); }
function ctx(accountId, wsUrl, extras = {}) {
  let status = {};
  return { accountId, account: { accountId, agentId: 'bot', wsUrl, token: 'test', enabled: true },
    abortSignal: new AbortController().signal, getStatus: () => status, setStatus: next => { status = next; },
    log: { info() {}, warn() {}, error() {} }, ...extras };
}
async function server(t) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); });
  return { wss, url: `ws://127.0.0.1:${wss.address().port}` };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
test('backoff remains finite after 1025 attempts including zero initial delay and timer overflow', () => {
  for (const initial of [0, 1, 1000, Number.MAX_VALUE]) {
    const events = [];
    const c = client({ initialReconnectDelayMs: initial, maxReconnectDelayMs: Number.MAX_VALUE, onDebug: (event, meta) => events.push([event, meta]) });
    try { for (const attempt of [0, 30, 1025, 100000]) {
      c.reconnectAttempt = attempt; c.scheduleReconnect(); const delay = events.at(-1)[1].delayMs;
      assert.ok(Number.isFinite(delay)); assert.ok(delay >= 0 && delay <= 2 ** 31 - 1);
      if (initial === 0) assert.equal(delay, 0);
      if (initial === 1) assert.equal(delay, 2 ** Math.min(attempt, 30));
    } } finally { c.disconnect(); }
  }
});
test('constructor invalid delay options fall back safely while explicit zero remains supported', () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity, '10']) {
    const c = client({ heartbeatInterval: invalid, connectTimeoutMs: invalid, initialReconnectDelayMs: invalid, maxReconnectDelayMs: invalid });
    assert.equal(c.heartbeatInterval, 30000); assert.equal(c.connectTimeoutMs, 15000);
    assert.equal(c.initialReconnectDelayMs, 1000); assert.equal(c.maxReconnectDelayMs, 60000);
  }
  const c = client({ heartbeatInterval: 0, connectTimeoutMs: 0 }); assert.equal(c.heartbeatInterval, 0); assert.equal(c.connectTimeoutMs, 0);
});
test('array frames are rejected before dispatch', () => {
  const events = []; const c = client({ onDebug: event => events.push(event) });
  c.handleMessage('[]'); c.handleMessage('[{"type":"channel_created","channel_id":"room"}]');
  assert.deepEqual(events, ['recv:invalid_json', 'recv:invalid_json']); assert.deepEqual(c.getJoinedChannels(), []);
});
test('join, leave and channel_created normalize and validate IDs before sending', () => {
  const c = client(); const frames = []; c.send = frame => frames.push(frame);
  for (const id of ['', '  ', 'a b', 'a\tb', 'a\nb', 'a\0b', 'a\x7fb', 'x'.repeat(129), null, 10]) {
    c.joinChannel(id); c.leaveChannel(id); c.handleMessage(JSON.stringify({ type: 'channel_created', channel_id: id }));
  }
  assert.deepEqual(frames, []); c.joinChannel(' room ');
  c.handleMessage(JSON.stringify({ type: 'channel_created', channel_id: ' another ' })); c.joinChannel('x'.repeat(128));
  assert.deepEqual(c.getJoinedChannels(), ['room', 'another', 'x'.repeat(128)]);
  c.leaveChannel(' room '); assert.equal(frames.at(-1).channel_id, 'room'); assert.ok(!c.getJoinedChannels().includes('room'));
});
test('channel tracking caps at 256, allows rejoin at capacity and frees capacity on leave', () => {
  const c = client(); const frames = []; c.send = frame => frames.push(frame);
  for (let i = 0; i < 1000; i++) c.handleMessage(JSON.stringify({ type: 'channel_created', channel_id: `r${i}` }));
  assert.equal(c.getJoinedChannels().length, 256); assert.equal(frames.length, 256);
  c.joinChannel('r0'); assert.equal(frames.length, 257); c.leaveChannel('r0'); c.joinChannel('new');
  assert.equal(c.getJoinedChannels().length, 256); assert.ok(c.getJoinedChannels().includes('new'));
});
test('disconnect immediately rejects a handshake and closes lifecycle', async t => {
  const { wss, url } = await server(t); const c = client({ url, connectTimeoutMs: 0 }); t.after(() => c.disconnect());
  const connected = once(wss, 'connection'); const result = assert.rejects(c.connect(), /aborted/);
  await connected; c.disconnect(); await result; await c.waitUntilClosed(); assert.equal(c.reconnectTimer, null);
});
test('stop cancels pending handshake and immediate restart survives old cleanup', async t => {
  const { wss, url } = await server(t); const context = ctx('pending-race', url); t.after(() => agentChatGateway.stopAccount(context));
  let socket = once(wss, 'connection'); const first = assert.rejects(agentChatGateway.startAccount(context), /aborted/); const [oldSocket] = await socket;
  await agentChatGateway.stopAccount(context); socket = once(wss, 'connection'); const second = agentChatGateway.startAccount(context);
  const [newSocket] = await socket; await first; newSocket.send(JSON.stringify({ type: 'auth_ok', session_id: 'new' }));
  await until(() => getGatewayState(context.accountId)); assert.equal(context.getStatus().connected, true); assert.notEqual(oldSocket, newSocket);
  await agentChatGateway.stopAccount(context); await second; await until(() => wss.clients.size === 0);
  assert.equal(getGatewayState(context.accountId), undefined); assert.equal(context.getStatus().running, false);
});
test('stop before client creation cancels start and permits a fresh attempt', async t => {
  const { wss, url } = await server(t); const context = ctx('pre-create-stop', url);
  const first = assert.rejects(agentChatGateway.startAccount(context), /aborted/); await agentChatGateway.stopAccount(context); await first;
  assert.equal(wss.clients.size, 0); const socket = once(wss, 'connection'); const second = agentChatGateway.startAccount(context); t.after(() => agentChatGateway.stopAccount(context));
  const [ws] = await socket; ws.send(JSON.stringify({ type: 'auth_ok', session_id: 'fresh' })); await until(() => getGatewayState(context.accountId));
  await agentChatGateway.stopAccount(context); await second;
});
test('abortSignal cancels pending handshake without leaving state', async t => {
  const { wss, url } = await server(t); const controller = new AbortController(); const context = ctx('signal-stop', url, { abortSignal: controller.signal });
  const socket = once(wss, 'connection'); const first = assert.rejects(agentChatGateway.startAccount(context), /aborted/);
  await socket; controller.abort(); await first; assert.equal(getGatewayState(context.accountId), undefined); assert.equal(context.getStatus().running, false);
});
test('trace rejects symlinks and directories, enforces private mode, rotates and redacts logs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-trace-')); const previous = process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG;
  t.after(() => { if (previous === undefined) delete process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG; else process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = previous; rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  const run = async path => {
    process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = path;
    const context = ctx('Bearer secret-bearer ac_sensitive sk-sensitive', 'bad-url', { log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
    await assert.rejects(agentChatGateway.startAccount(context)); assert.ok(!JSON.stringify(context.getStatus()).includes('secret-bearer'));
  };
  const target = join(dir, 'target'); writeFileSync(target, 'unchanged'); const link = join(dir, 'link'); symlinkSync(target, link);
  await run(link); assert.equal(readFileSync(target, 'utf8'), 'unchanged'); const folder = join(dir, 'folder'); mkdirSync(folder); await run(folder);
  const path = join(dir, 'trace'); await run(path); assert.equal(statSync(path).mode & 0o777, 0o600); assert.ok(readFileSync(path, 'utf8').includes('[REDACTED]'));
  writeFileSync(path, 'z'.repeat(1024 * 1024 + 1)); await run(path); assert.ok(statSync(path).size <= 1024 * 1024); assert.ok(!readFileSync(path, 'utf8').startsWith('z'));
  const all = readFileSync(path, 'utf8') + JSON.stringify(logs);
  for (const secret of ['secret-bearer', 'ac_sensitive', 'sk-sensitive']) assert.ok(!all.includes(secret));
});
test('server authentication errors redact credentials in error sinks, status and trace', async t => {
  const { wss, url } = await server(t);
  const dir = mkdtempSync(join(tmpdir(), 'openclaw-errors-'));
  const previous = process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG;
  const path = join(dir, 'trace'); process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = path;
  t.after(() => { if (previous === undefined) delete process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG; else process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = previous; rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  const context = ctx('secret-error', url, { log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  wss.on('connection', ws => ws.on('message', () => ws.send(JSON.stringify({ type: 'auth_error', message: 'rejected Bearer hidden-bearer ac_hidden sk-hidden' }))));
  await assert.rejects(agentChatGateway.startAccount(context), /Auth failed/);
  const output = JSON.stringify(logs) + JSON.stringify(context.getStatus()) + readFileSync(path, 'utf8');
  for (const secret of ['hidden-bearer', 'ac_hidden', 'sk-hidden']) assert.ok(!output.includes(secret));
  assert.ok(output.includes('[REDACTED]'));
});
test('concurrent pending starts share one handshake and both settle on stop', async t => {
  const { wss, url } = await server(t); const context = ctx('duplicate-start', url);
  let connections = 0; wss.on('connection', () => { connections++; });
  const socket = once(wss, 'connection');
  const a = assert.rejects(agentChatGateway.startAccount(context), /aborted/);
  const b = assert.rejects(agentChatGateway.startAccount(context), /aborted/);
  await socket; assert.equal(connections, 1); await agentChatGateway.stopAccount(context);
  await Promise.all([a, b]); assert.equal(getGatewayState(context.accountId), undefined);
});
test('abort immediately after start prevents socket creation and clears pending start', async t => {
  const { wss, url } = await server(t); const controller = new AbortController();
  const context = ctx('immediate-abort', url, { abortSignal: controller.signal });
  const first = assert.rejects(agentChatGateway.startAccount(context), /aborted/);
  controller.abort(); await first; assert.equal(wss.clients.size, 0);
  const fresh = ctx(context.accountId, url); const socket = once(wss, 'connection');
  const second = agentChatGateway.startAccount(fresh); t.after(() => agentChatGateway.stopAccount(fresh));
  const [ws] = await socket; ws.send(JSON.stringify({ type: 'auth_ok', session_id: 'fresh' }));
  await until(() => getGatewayState(fresh.accountId)); await agentChatGateway.stopAccount(fresh); await second;
});
