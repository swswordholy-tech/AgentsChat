import { expect, test } from 'bun:test';
import { AgentChatREST, parseSseFrames, type FetchLike } from '../src/rest';
import { AgentChatClient } from '../src/client';
import { redactError } from '../src/security';

const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).concat('\x7f');
const secrets = ['mcp_at_private', 'mcp_rt_private', 'mcp_code_private', 'agent_key_private', 'whsec_private',
  ...'pousr'.split('').map(c => `gh${c}_private`), 'github_pat_private', ...'baprs'.split('').map(c => `xox${c}-private`),
  'AIzaPrivate123456789', 'AKIA1234567890ABCDEF', 'ASIA1234567890ABCDEF'];
const hosts = ['metadata.google.internal', 'METADATA.GOOGLE.INTERNAL.', 'metadata.goog', 'metadata.goog.',
  '169.254.0.1', '169.254.255.255', '0xa9fea9fe', '2852039166', '0251.0376.0251.0376', '169.16689662',
  '[fe80::1]', '[febf:ffff::1]', '[::ffff:169.254.169.254]', '[::ffff:0:169.254.169.254]',
  '[::ffff:a9fe:a9fe]', '[0:0:0:0:ffff:0:a9fe:a9fe]', '[::169.254.169.254]'];
const badIds = ['', ' ', '.', '..', ' . ', ' .. ', 'a/b', 'a\\b', ...controls.map(c => `${c}room${c}`)];
const rest = (fetchImpl: FetchLike = async () => Response.json({})) => new AgentChatREST({ baseUrl: 'https://example.com', fetchImpl });

test('diagnostics scrub SDK credential families, Basic and C0/DEL without changing ordinary text', () => {
  for (const secret of secrets) expect(redactError(`failure ${secret} after`)).toBe('failure [REDACTED] after');
  expect(redactError(`Basic dXNlcjpwYXNz Bearer private ${controls.join('')}`)).toBe('Basic [REDACTED] Bearer [REDACTED] ');
  expect(redactError('中文 room-asia-pacific aiza-guide sk-short')).toBe('中文 room-asia-pacific aiza-guide sk-short');
});

test('REST and WS reject canonical metadata, link-local and zero-port URLs before transport', () => {
  for (const host of hosts) {
    expect(() => restWithUrl(`https://${host}`)).toThrow('Invalid baseUrl');
    expect(() => new AgentChatClient({ url: `wss://${host}/ws`, agentId: 'bot' })).toThrow('Invalid url');
  }
  for (const port of ['0', '000']) {
    expect(() => restWithUrl(`http://localhost:${port}`)).toThrow();
    expect(() => new AgentChatClient({ url: `ws://localhost:${port}`, agentId: 'bot' })).toThrow();
  }
});
function restWithUrl(baseUrl: string) { return new AgentChatREST({ baseUrl }); }

test('metadata lookalikes, public IPv6 and non-link-local private hosts remain valid', () => {
  for (const host of ['metadata.goog.example', '169.253.1.1', '169.255.1.1', '[fe7f::1]', '[fec0::1]', '[::ffff:192.168.1.1]']) {
    expect(restWithUrl(`https://${host}`)).toBeDefined();
    expect(new AgentChatClient({ url: `wss://${host}`, agentId: 'bot' })).toBeDefined();
  }
});

test('all REST path argument families reject unsafe original values before fetch or trimming', async () => {
  let calls = 0; const c = rest(async () => { calls++; return Response.json({}); });
  for (const id of badIds) for (const request of [() => c.getAccount(id), () => c.getChannels(id),
    () => c.getMessages(id), () => c.getMessages('room', 50, id), () => c.getPersonalSkill(id),
    () => c.getChannelDoc('room', id), () => c.getTaskBlocks(id), () => c.pauseCloudAgentLoop('bot', id),
    () => c.getCloudAgentAuditLogs(id), () => c.getChannelDetail(id)]) {
    await expect(request()).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test('WebSocket routing IDs reject unsafe values before socket send', () => {
  const c = new AgentChatClient({ url: 'wss://example.com', agentId: 'bot' });
  let calls = 0; (c as any).ws = { readyState: WebSocket.OPEN, send() { calls++; } };
  for (const id of badIds) for (const send of [() => c.joinChannel(id), () => c.pin('room', id),
    () => c.forward('room', id, 'message'), () => c.markRead('room', id), () => c.setRole('room', id, 'member')]) expect(send).toThrow();
  for (const id of badIds) expect(() => new AgentChatClient({ url: 'wss://example.com', agentId: id })).toThrow();
  expect(calls).toBe(0);
});

test('colon and hyphen DMs preserve encoded REST paths and socket routing', async () => {
  const paths: string[] = []; const c = rest(async (url, init) => {
    paths.push(String(url)); expect(init?.redirect).toBe('error'); return Response.json({ messages: [] });
  });
  const ws = new AgentChatClient({ url: 'wss://example.com', agentId: 'bot' }); const frames: any[] = [];
  (ws as any).ws = { readyState: WebSocket.OPEN, send(raw: string) { frames.push(JSON.parse(raw)); } };
  for (const channel of ['dm:a:b', 'dm-a-b']) { await c.getMessages(channel); ws.joinChannel(channel); }
  expect(paths[0]).toContain('/dm%3Aa%3Ab/messages'); expect(paths[1]).toContain('/dm-a-b/messages');
  expect(frames.map(f => f.channel_id)).toEqual(['dm:a:b', 'dm-a-b']);
});

test('top-level own __proto__ JSON is rejected on success, error and SSE error paths', async () => {
  const payload = '{"__proto__":{},"ok":true,"message":"attacker"}';
  for (const status of [200, 403]) await expect(rest(async () => new Response(payload, { status })).health()).rejects.toThrow('Invalid JSON response object');
  await expect(rest(async () => new Response(payload, { status: 403 })).iterateChannelEvents('room').next()).rejects.toThrow('Invalid JSON response object');
  expect(parseSseFrames(`data: ${payload}\n\ndata: {"type":"safe"}\n\n`).events).toEqual([{ type: 'safe' }]);
});

test('own __proto__ WS objects cannot authenticate or dispatch any handler', () => {
  const c = new AgentChatClient({ url: 'wss://example.com', agentId: 'bot' }); const seen: any[] = [];
  c.onMessage(m => seen.push(m)); c.onError(e => seen.push(e));
  for (const frame of [{ type: 'auth_ok', session_id: 'evil' }, { type: 'message', content: 'bad' }, { type: 'error', message: 'bad' }]) {
    (c as any).handleMessage(JSON.stringify({ ...frame, ['__proto__']: {} }));
  }
  expect((c as any).sessionId).toBeNull(); expect(seen).toEqual([]);
  (c as any).handleMessage('{"type":"message","channel_id":"room","content":"ordinary"}');
  expect(seen.length).toBe(1);
});

test('four MiB limit cancels streamed success/error/archive bodies using bytes despite header lies', async () => {
  for (const kind of ['success', 'error', 'archive']) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { cancelled++; return new Promise<void>(() => {}); } });
    const c = rest(async () => new Response(stream, { status: kind === 'error' ? 403 : 200, headers: { 'Content-Length': '2' } }));
    await expect(kind === 'archive' ? c.archiveChannelDoc('room', 'doc') : c.health()).rejects.toThrow('4 MiB');
    expect(cancelled).toBe(1); expect(stream.locked).toBe(false);
  }
});

test('authenticated transport failure redacts all credential families and terminal controls', async () => {
  const text = `${secrets.join(' ')} Basic dXNlcjpwYXNz${controls.join('')}`;
  try { await rest(async () => { throw new Error(text); }).health(); throw new Error('expected failure'); }
  catch (error) { const message = String(error); for (const secret of secrets) expect(message).not.toContain(secret);
    expect(message).not.toContain('dXNlcjpwYXNz'); expect(message).not.toMatch(/[\x00-\x1f\x7f]/); }
});
