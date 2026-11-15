import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { buildInboundPolicy } = await jiti.import('../src/policy.ts');
const { AgentChatClient } = await jiti.import('../src/agentchat-client.ts');
const { agentChatGateway } = await jiti.import('../src/gateway.ts');
const { agentChatConfig: config } = await jiti.import('../src/config.ts');

const baseAccount = {
  accountId: 'c128',
  agentId: 'bot',
  token: 'ac_c128_secret',
  wsUrl: 'wss://example.com/ws',
  enabled: true,
};

let seq = 0;
const makeMsg = (extra = {}) => ({
  type: 'message',
  id: `m-c128-${++seq}`,
  channel_id: 'room-c128',
  sender_id: 'alice',
  content: '@bot status',
  timestamp: '2026-11-15T01:55:00.000Z',
  ...extra,
});

async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('Campaign #128: policy blocks extended SSRF metadata/unspecified hosts and dot/prototype channelIds before fetch', async () => {
  const blockedHosts = [
    '0.0.0.0',
    '[::]',
    '[0:0:0:0:0:0:0:0]',
    '100.100.100.200',
    '[fd00:ec2::254]',
    '[fd00:ec2:0:0:0:0:0:254]',
    'metadata',
    'instance-data',
    'sub.metadata.google.internal',
    'sub.metadata.goog',
    '[::ffff:100.100.100.200]',
    '[::ffff:0.0.0.0]',
  ];
  let fetchCalls = 0;
  await withFetch(
    () => {
      fetchCalls += 1;
      return Response.json({ messages: [] });
    },
    async () => {
      for (const host of blockedHosts) {
        const logs = [];
        const res = await buildInboundPolicy({
          account: { ...baseAccount, wsUrl: `wss://${host}/ws` },
          accountId: baseAccount.accountId,
          message: makeMsg(),
          log: (...args) => logs.push(args),
        });
        assert.equal(res.bodyForAgent, '@bot status');
        assert.equal(logs.length, 1, host);
        assert.match(logs[0][2].error, /metadata or link-local/);
      }

      // Path-traversal and prototype channelIds never issue `/api/channels/../messages`
      for (const badChannel of ['.', '..', '__proto__', 'constructor', 'prototype', 'CONSTRUCTOR']) {
        const logs = [];
        const res = await buildInboundPolicy({
          account: baseAccount,
          accountId: baseAccount.accountId,
          message: makeMsg({ channel_id: badChannel }),
          log: (...args) => logs.push(args),
        });
        assert.equal(res.bodyForAgent, '@bot status');
        assert.equal(logs.length, 1, badChannel);
        assert.match(logs[0][2].error, /Invalid AgentChat channel ID/);
      }
    },
  );
  assert.equal(fetchCalls, 0);
});

test('Campaign #128: AgentChatClient blocks SSRF/remote-plaintext/credentialed connect URLs and dot/prototype channel IDs', async () => {
  const unsafeUrls = [
    'ws://example.com/ws',
    'wss://user:pass@example.com/ws',
    'ws://127.0.0.1:0/ws',
    'wss://0.0.0.0/ws',
    'wss://[::]/ws',
    'wss://169.254.169.254/ws',
    'wss://100.100.100.200/ws',
    'wss://[fd00:ec2::254]/ws',
    'wss://metadata.google.internal/ws',
    'wss://sub.metadata.goog/ws',
    'wss://instance-data/ws',
  ];
  for (const url of unsafeUrls) {
    const client = new AgentChatClient({ url, agentId: 'bot', reconnect: false });
    await assert.rejects(() => client.connect(), /WebSocket/);
    await client.waitUntilClosed();
  }

  const client = new AgentChatClient({ url: 'ws://127.0.0.1:1/ws', agentId: 'bot', reconnect: false });
  const frames = [];
  client.send = (f) => frames.push(f);
  const delivered = [];
  client.onMessage((m) => delivered.push(m));

  for (const badId of ['.', '..', '__proto__', 'constructor', 'prototype', 'PROTOTYPE']) {
    client.joinChannel(badId);
    client.leaveChannel(badId);
    client.handleMessage(JSON.stringify({ type: 'channel_created', channel_id: badId }));
    client.handleMessage(JSON.stringify(makeMsg({ channel_id: badId })));
    client.handleMessage(JSON.stringify(makeMsg({ type: 'thread_reply', channel_id: badId, parent_id: 'p1' })));
    assert.throws(() => client.sendMessage(badId, 'hello'), /Invalid AgentChat channelId/);
  }
  assert.deepEqual(client.getJoinedChannels(), []);
  assert.deepEqual(frames, []);
  assert.deepEqual(delivered, []);
});

test('Campaign #128: policy & gateway scrub glpat-, xox*, rk_live/test_, ASIA, JWTs, Basic, and URL userinfo', async (t) => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJib3QifQ', 'fixtureSignature123456'].join('.');
  const extendedSecrets = [
    `${'gl'}${'pat-'}${'fixtureTokenValue'}`,
    `${'xo'}${'xb-'}${'fixtureSlackBot'}`,
    `${'xo'}${'xp-'}${'fixtureSlackUser'}`,
    `${'rk_'}${'live_'}${'fixtureStripe'}`,
    `${'rk_'}${'test_'}${'fixtureStripe'}`,
    `${'AS'}${'IA0000000000FIXTUR'}`,
    jwt,
  ];

  // 1. Policy history error scrubbing
  await withFetch(
    async () => {
      throw new Error(
        `Auth Basic dXNlcjpwYXNz at wss://admin:topSecretPass@example.com/ws ${extendedSecrets.join(' ')}`,
      );
    },
    async () => {
      const logs = [];
      await buildInboundPolicy({
        account: baseAccount,
        accountId: baseAccount.accountId,
        message: makeMsg(),
        log: (...args) => logs.push(args),
      });
      const errText = logs[0][2].error;
      for (const s of [...extendedSecrets, 'dXNlcjpwYXNz', 'topSecretPass']) {
        assert.ok(!errText.includes(s), `leaked in policy log: ${s}`);
      }
      assert.match(errText, /\[redacted\]/);
    },
  );

  // 2. Gateway status, logs, and trace file scrubbing
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  const wsUrl = `ws://127.0.0.1:${wss.address().port}`;
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'auth') {
        ws.send(
          JSON.stringify({
            type: 'auth_error',
            message: `https://svc:ultraSecret@example.com/hook ${extendedSecrets.join(' ')}`,
          }),
        );
      }
    });
  });

  const dir = mkdtempSync(join(tmpdir(), 'openclaw-c128-trace-'));
  const prevDebug = process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG;
  const tracePath = join(dir, 'trace.log');
  process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = tracePath;
  t.after(() => {
    if (prevDebug === undefined) delete process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG;
    else process.env.AGENTCHAT_OPENCLAW_DEBUG_LOG = prevDebug;
    rmSync(dir, { recursive: true, force: true });
  });

  let status = {};
  const logs = [];
  const ctx = {
    accountId: 'c128-gw',
    cfg: {},
    account: { ...baseAccount, accountId: 'c128-gw', wsUrl },
    abortSignal: new AbortController().signal,
    getStatus: () => status,
    setStatus: (next) => {
      status = next;
    },
    log: {
      info: (...args) => logs.push(args),
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
  };

  await assert.rejects(() => agentChatGateway.startAccount(ctx), /Auth failed/);
  const combined = JSON.stringify(logs) + JSON.stringify(status) + readFileSync(tracePath, 'utf8');
  for (const s of [...extendedSecrets, 'ultraSecret']) {
    assert.ok(!combined.includes(s), `leaked in gateway output: ${s}`);
  }
  assert.match(combined, /REDACTED/);
});

test('Campaign #128: config rejects dot, double-dot, control-character, and >128-char account IDs', () => {
  for (const badId of ['.', '..', 'acc\x00id', 'acc\nid', 'acc\x7fid', 'a'.repeat(129)]) {
    const cfg = {
      channels: {
        agentchat: {
          accounts: {
            [badId]: { agentId: 'bad-bot', token: 'ac_bad' },
            clean: { agentId: 'clean-bot', token: 'ac_clean' },
          },
        },
      },
    };
    assert.deepEqual(config.listAccountIds(cfg), ['clean']);
    assert.equal(config.resolveAccount(cfg).agentId, 'clean-bot');
    assert.throws(() => config.resolveAccount(cfg, badId), /missing/);
    assert.throws(() => config.inspectAccount(cfg, badId), /missing/);
  }
});
