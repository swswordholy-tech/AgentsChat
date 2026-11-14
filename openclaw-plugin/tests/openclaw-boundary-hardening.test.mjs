import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { buildInboundPolicy } = await jiti.import('../src/policy.ts');
const { buildConversationId, parseConversationId } = await jiti.import('../src/conversation.ts');
const { agentChatMessaging } = await jiti.import('../src/messaging.ts');
const { AgentChatClient } = await jiti.import('../src/agentchat-client.ts');
const { agentChatGateway } = await jiti.import('../src/gateway.ts');
const { getGatewayState } = await jiti.import('../src/state.ts');
const account = { accountId: 'boundary', agentId: 'bot', token: 'ac_auth', wsUrl: 'wss://example.com/ws', enabled: true };
let sequence = 0;
const message = (extra = {}) => ({ type: 'message', id: `m-${++sequence}`, channel_id: 'room', sender_id: 'alice', content: '@bot hello', timestamp: '2026-11-14T20:00:00.000Z', ...extra });
const policy = (extra = {}, options = {}) => buildInboundPolicy({ account, accountId: account.accountId, message: message(extra), ...options });
async function withFetch(fetcher, run) {
  const original = globalThis.fetch; globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
const secrets = [
  'mcp_at_privateToken', 'mcp_rt_privateToken', 'mcp_code_privateToken', 'agent_key_privateToken',
  'sk-privateToken', 'whsec_privateToken', ...'pousr'.split('').map(x => `gh${x}_privateToken`),
  'github_pat_privateToken', 'AIzaPrivateToken123456789', 'AKIAPRIVATETOKEN1234',
];
function context(accountId, wsUrl, extra = {}) {
  let status = {};
  return { accountId, cfg: {}, account: { ...account, accountId, wsUrl }, abortSignal: new AbortController().signal,
    getStatus: () => status, setStatus: next => { status = next; }, log: { info() {}, warn() {}, error() {} }, ...extra };
}
async function server(t) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); });
  return { wss, url: `ws://127.0.0.1:${wss.address().port}` };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function traceEnv(t, path) {
  const previous = process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG;
  process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = path;
  t.after(() => { if (previous === undefined) delete process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG; else process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = previous; });
}

test('colon and hyphen DMs dispatch without mention, suppress self, and never fetch history', async () => {
  let fetches = 0;
  await withFetch(() => { fetches++; throw new Error('unexpected fetch'); }, async () => {
    for (const channel_id of ['dm:alice:bot', 'DM:alice:bot', 'dm-alice-bot', 'DM-alice-bot']) {
      assert.equal((await policy({ channel_id, content: 'hello' })).shouldDispatch, true);
      assert.equal((await policy({ channel_id, content: 'hello', sender_id: 'bot' })).shouldDispatch, false);
    }
    for (const channel_id of ['team', 'dmish', 'team-dm:bot']) assert.equal((await policy({ channel_id, content: 'hello' })).shouldDispatch, false);
  });
  assert.equal(fetches, 0);
});

test('ambiguous conversations fail closed through session and delivery resolution', () => {
  for (const rawId of ['agentchat:channel:general:thread:foo:thread:bar', 'agentchat:channel:r:thread::thread:', 'agentchat:channel:r:thread: :thread:t']) {
    assert.equal(parseConversationId(rawId), null);
    assert.equal(agentChatMessaging.resolveSessionConversation({ rawId }), null);
    assert.equal(agentChatMessaging.resolveDeliveryTarget({ conversationId: rawId }), null);
  }
  for (const [channel, thread] of [['dm:alice:bot', 'thread:ordinary'], ['一般频道', '线程'], ['room', undefined], ['room', '']]) {
    const id = buildConversationId(channel, thread);
    assert.equal(agentChatMessaging.resolveSessionConversation({ rawId: id }).id, id);
  }
  assert.deepEqual(parseConversationId('agentchat:channel:r:thread: '), { channelId: 'r', threadId: undefined });
});

test('history rejects URL normalization hazards and zero ports before authenticated fetch', async () => {
  const urls = [' wss://example.com/ws', 'wss://example.com/ws ', '\nwss://example.com/ws',
    'wss://example.com:0/ws', 'ws://localhost:0/ws', 'wss://example.com:000/ws',
    ...['"', '<', '>', '\\', '\n', '\t', '\0', '\x7f', ' '].map(c => `wss://example.com/a${c}b`)];
  let fetches = 0;
  await withFetch(() => { fetches++; return Response.json({ messages: [] }); }, async () => {
    for (const wsUrl of urls) {
      const logs = [];
      const result = await policy({}, { account: { ...account, wsUrl }, log: (...args) => logs.push(args) });
      assert.equal(result.bodyForAgent, '@bot hello'); assert.equal(logs.length, 1, wsUrl);
      assert.doesNotMatch(logs[0][2].error, /ac_auth/);
    }
  });
  assert.equal(fetches, 0);
});

test('history rejects canonical metadata and link-local host variants before fetch', async () => {
  const hosts = ['169.254.169.254', '169.254.0.1', '169.254.255.255', '0xa9fea9fe', '2852039166',
    'metadata.google.internal', 'METADATA.GOOGLE.INTERNAL.', 'metadata.goog', 'metadata.goog.',
    '[::ffff:169.254.169.254]', '[::ffff:0:169.254.169.254]', '[::ffff:a9fe:a9fe]',
    '[0:0:0:0:ffff:0:a9fe:a9fe]', '[::169.254.169.254]', '[fe80::1]', '[febf::1]'];
  let fetches = 0;
  await withFetch(() => { fetches++; return Response.json({ messages: [] }); }, async () => {
    for (const host of hosts) {
      const logs = [];
      assert.equal((await policy({}, { account: { ...account, wsUrl: `wss://${host}/ws` }, log: (...args) => logs.push(args) })).bodyForAgent, '@bot hello');
      assert.equal(logs.length, 1, host); assert.match(logs[0][2].error, /metadata or link-local/);
    }
  });
  assert.equal(fetches, 0);
});

test('valid remote and loopback history URLs retain prefix and encoded channel routing', async () => {
  for (const [wsUrl, base] of [['wss://example.com:8443/prefix/ws?x=1#hash', 'https://example.com:8443/prefix'],
    ['ws://localhost:1234/ws', 'http://localhost:1234'], ['ws://127.0.0.1/ws', 'http://127.0.0.1'], ['ws://[::1]/ws', 'http://[::1]'],
    ['wss://metadata.goog.example/ws', 'https://metadata.goog.example']]) {
    let fetches = 0;
    await withFetch((url, init) => {
      fetches++; assert.ok(url.startsWith(`${base}/api/channels/room%2F%E6%B1%89/messages?`));
      assert.equal(init.headers.Authorization, 'Bearer ac_auth'); assert.equal(init.redirect, 'error');
      return Response.json({ messages: [{ id: 'past', sender_id: 'friend', content: 'valid context' }] });
    }, async () => assert.match((await policy({ channel_id: 'room/汉' }, { account: { ...account, wsUrl } })).bodyForAgent, /friend: valid context/));
    assert.equal(fetches, 1);
  }
});

test('history own __proto__ causes fallback even when messages would supply context', async () => {
  const logs = [];
  await withFetch(() => new Response('{"__proto__":{},"messages":[{"id":"past","sender_id":"friend","content":"unsafe context"}]}'), async () => {
    const result = await policy({}, { log: (...args) => logs.push(args) });
    assert.equal(result.shouldDispatch, true); assert.equal(result.bodyForAgent, '@bot hello');
  });
  assert.equal(logs.length, 1); assert.match(logs[0][2].error, /Invalid AgentChat history JSON/);
});

test('history errors scrub every requested credential family and all C0/DEL characters', async () => {
  const controls = String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i), 127);
  for (const secret of [...secrets, ...secrets.map(x => x.toUpperCase())]) {
    const logs = [];
    await withFetch(() => { throw new Error(`failed${controls} ${secret} after`); }, async () => {
      await policy({}, { log: (...args) => logs.push(args) });
    });
    const error = logs[0][2].error;
    assert.ok(!error.includes(secret), secret); assert.match(error, /\[redacted\]/); assert.doesNotMatch(error, /[\x00-\x1f\x7f]/);
    assert.ok(error.includes('failed') && error.includes('after'));
  }
});

test('own __proto__ WebSocket objects cannot mutate authentication, membership or dispatch state', () => {
  const c = new AgentChatClient({ url: 'ws://127.0.0.1:1', agentId: 'bot', heartbeatInterval: 0 });
  const delivered = []; const sent = []; c.onMessage(m => delivered.push(m)); c.send = m => sent.push(m);
  for (const frame of [{ type: 'auth_ok', session_id: 'attacker' }, { type: 'channel_created', channel_id: 'evil' }, message(), message({ type: 'thread_reply' })]) {
    c.handleMessage(JSON.stringify({ ...frame, ['__proto__']: {} }));
  }
  assert.equal(c.sessionId, null); assert.deepEqual(c.getJoinedChannels(), []); assert.deepEqual(sent, []); assert.deepEqual(delivered, []);
});

test('malformed inbound channels are rejected before handlers for both message frame types', () => {
  const c = new AgentChatClient({ url: 'ws://127.0.0.1:1', agentId: 'bot' }); const delivered = []; const received = [];
  c.onMessage(m => { received.push(m); buildConversationId(m.channel_id, m.thread_id); delivered.push(m); });
  for (const type of ['message', 'thread_reply']) {
    for (const channel_id of [undefined, null, 1, {}, '', '   ', ':thread:', 'a:thread:b', ...Array.from({ length: 32 }, (_, i) => `a${String.fromCharCode(i)}b`), 'a\x7fb']) {
      c.handleMessage(JSON.stringify(message({ type, channel_id, parent_id: 'parent' })));
    }
  }
  assert.deepEqual(received, []); assert.deepEqual(delivered, []);
  for (const channel_id of ['room', 'dm:a:b', '房间']) c.handleMessage(JSON.stringify(message({ type: 'thread_reply', channel_id, parent_id: 'parent' })));
  assert.deepEqual(delivered.map(m => [m.channel_id, m.thread_id]), [['room', 'parent'], ['dm:a:b', 'parent'], ['房间', 'parent']]);
});

test('gateway metadata logging tolerates BigInt, cycles, undefined serialization and throwing sinks', async t => {
  const { wss, url } = await server(t); const logs = [];
  wss.on('connection', ws => ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'auth') ws.send('{"type":"auth_ok","session_id":"ok"}'); }));
  const ctx = context('safe-log', url, { log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  const running = agentChatGateway.startAccount(ctx); t.after(() => agentChatGateway.stopAccount(ctx));
  await until(() => getGatewayState(ctx.accountId)); const c = getGatewayState(ctx.accountId).client;
  const circular = {}; circular.self = circular;
  for (const meta of [{ value: 1n }, circular, { toJSON: () => undefined }, undefined]) assert.doesNotThrow(() => c.debug('test-meta', meta));
  assert.ok(logs.filter(args => args[1] === '[unserializable metadata]').length >= 3);
  ctx.log.info = () => { throw new Error('broken sink'); };
  assert.doesNotThrow(() => c.debug('sink-failure', { key: secrets[0] }));
  await agentChatGateway.stopAccount(ctx); await running;
  assert.equal(getGatewayState(ctx.accountId), undefined); assert.equal(ctx.getStatus().connected, false);
});

test('gateway auth error logs, status and trace redact new credential families and Basic', async t => {
  const { wss, url } = await server(t); const dir = mkdtempSync(join(tmpdir(), 'openclaw-boundary-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); const path = join(dir, 'trace'); traceEnv(t, path);
  const allSecrets = [...secrets, ...secrets.map(x => x.toUpperCase()), 'Basic dXNlcjpwYXNz'];
  wss.on('connection', ws => ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'auth') ws.send(JSON.stringify({ type: 'auth_error', message: allSecrets.join(' ') })); }));
  const logs = []; const ctx = context('redaction', url, { log: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) } });
  await assert.rejects(agentChatGateway.startAccount(ctx), /Auth failed/);
  const output = JSON.stringify(logs) + JSON.stringify(ctx.getStatus()) + readFileSync(path, 'utf8');
  for (const secret of allSecrets) assert.ok(!output.includes(secret), secret);
  assert.ok(!output.includes('dXNlcjpwYXNz')); assert.match(output, /REDACTED/);
});

test('trace rejects symlink ancestors at every depth, relative paths and lexical dot-dot paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-boundary-path-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  traceEnv(t, join(root, 'placeholder'));
  const target = join(root, 'target'); mkdirSync(join(target, 'nested'), { recursive: true });
  const link = join(root, 'link'); symlinkSync(target, link); const sentinel = join(target, 'nested', 'trace'); writeFileSync(sentinel, 'unchanged');
  const relative = join(root, 'relative'); symlinkSync('target', relative);
  // Do not path.join away the symlink/.. portion: the guard must inspect it.
  const paths = [`${link}/nested/trace`, `${link}/new-trace`, `${relative}/nested/trace`, `${link}/../escaped-trace`];
  for (const path of paths) {
    process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = path;
    await assert.rejects(agentChatGateway.startAccount(context(`unsafe-path-${++sequence}`, 'invalid-url')));
  }
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged'); assert.equal(existsSync(join(target, 'new-trace')), false);
  assert.equal(existsSync(join(root, 'escaped-trace')), false);
  const previousCwd = process.cwd();
  try {
    process.chdir(root); process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = 'link/nested/trace';
    await assert.rejects(agentChatGateway.startAccount(context('relative-trace', 'invalid-url')));
  } finally { process.chdir(previousCwd); }
  assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged');
  process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = join(target, 'nested', 'ordinary');
  await assert.rejects(agentChatGateway.startAccount(context('ordinary-trace', 'invalid-url')));
  assert.match(readFileSync(join(target, 'nested', 'ordinary'), 'utf8'), /startAccount/);
});

test('live gateway ignores malformed frames and dispatches colon DM on the same socket', async t => {
  const { wss, url } = await server(t); const delivered = []; const errors = [];
  const ctx = context('live-boundary', url, { log: { info() {}, error: (...args) => errors.push(args) }, channelRuntime: {
    routing: { resolveAgentRoute: () => ({ agentId: 'worker', sessionKey: 'session', accountId: 'live-boundary' }) },
    session: { resolveStorePath: () => '/unused', recordInboundSession: async () => {} },
    reply: { finalizeInboundContext: value => value, dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }) => { delivered.push(ctx); } },
  } });
  wss.on('connection', ws => ws.on('message', raw => { if (JSON.parse(String(raw)).type === 'auth') ws.send('{"type":"auth_ok","session_id":"ok"}'); }));
  const connected = once(wss, 'connection'); const running = agentChatGateway.startAccount(ctx); t.after(() => agentChatGateway.stopAccount(ctx));
  const [ws] = await connected; await until(() => getGatewayState(ctx.accountId));
  for (const channel_id of ['', 'a\0b', 'a:thread:b']) ws.send(JSON.stringify(message({ channel_id })));
  ws.send(JSON.stringify({ ...message({ channel_id: 'dm:a:bot' }), ['__proto__']: {} }));
  ws.send(JSON.stringify(message({ channel_id: 'dm:a:bot', content: 'direct hello' })));
  await until(() => delivered.length === 1);
  assert.equal(delivered[0].RawBody, 'direct hello'); assert.equal(delivered[0].ConversationLabel, 'agentchat:channel:dm:a:bot');
  assert.deepEqual(errors, []); await agentChatGateway.stopAccount(ctx); await running;
});
