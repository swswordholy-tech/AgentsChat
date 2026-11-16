/**
 * agentschat-inbound — machine-local DSH plugin (no upstream package).
 *
 * Why it exists: @deepseek-ai/dsh-mcp-client bridges only outbound tool calls,
 * so an AgentsChat DM / @mention never reaches a running DSH conversation on its
 * own. DSH does expose a plugin seam for exactly this: `agent.followup(message)`
 * queues an ordinary user-role message and wakes the agent loop (the built-in
 * `schedule` plugin wakes agents the same way).
 *
 * Architecture (reuse over reimplementation):
 *   1. This plugin hosts a loopback-only HTTP endpoint with HMAC-SHA256
 *      verification (same signature scheme as `muse/src/wake.ts`).
 *   2. It supervises `agentschat-mcp --dsh --wake`, the already-tested
 *      WebSocket listener, and points DSH_WAKE_URL at that endpoint.
 *   3. On a signed wake it hands a plugin-sourced user message to the session the
 *      wake names (`payload.target_session_id`, resolved from `session-binds.json`
 *      by the daemon). Delivery is bound-only: no target, or a target that is no
 *      longer live, is dropped rather than guessed into another conversation. A
 *      wake that arrives while the bound session is mid-turn stays queued until
 *      it goes idle. The GUI then shows the inbound message and the model can
 *      answer with the `mcp__agentschat__reply` tool.
 *
 * Session format v4 attribution: every durable message needs a producer-owned
 * `source.kind`. The retired `{ kind: 'plugin', plugin: <name> }` wrapper is
 * rejected at append time with "format v4 message requires a producer-owned
 * source kind", which silently kills the persisted turn. DSH's own convention
 * for third-party producers is `plugin:<name>` (see producerKind() in the
 * released V3->V4 source migration), so that is what we emit.
 *
 * Mid-turn delivery wedge: `agent.followup()` splices the Session inbox
 * synchronously. If the target Session has a step in flight — including the
 * step whose own tool call produced the wake — that splice races the open
 * step: the step never receives its tool result and the Session is stuck in
 * `running` with no further rows. Both 2026-10-28 wedges (session-41a8d6f0 at
 * 09:41:13 and session-dd7406c7 at 09:53:32) end on the tool/call row that
 * POSTed the wake, milliseconds before the injection log line. Delivery is
 * therefore gated on `agent.status === 'idle'`.
 *
 * Security: the endpoint binds 127.0.0.1 and rejects unsigned bodies. The wake
 * secret lives in ~/.agentschat/dsh-inbound.secret (0600) and is shared with
 * the child process through its environment only. The AgentsChat token remains
 * in ~/.agentschat/dsh.json and is read by the child, never by this file.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  openSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

export const name = 'agentschat-inbound';

const LOG_PATH = join(homedir(), '.dsh', 'agentschat-inbound.log');
const SECRET_PATH = join(homedir(), '.agentschat', 'dsh-inbound.secret');
const QUEUE_PATH = join(homedir(), '.agentschat', 'dsh-wake-queue.jsonl');
/** Config root shared with the MCP server: profiles live in `<dir>/profiles/`. */
const AGENTSCHAT_DIR = join(homedir(), '.agentschat');
const PROFILES_DIR = join(AGENTSCHAT_DIR, 'profiles');
const BINDS_PATH = join(AGENTSCHAT_DIR, 'session-binds.json');
const LOG_MAX_BYTES = 512 * 1024;
const MAX_SEEN_IDS = 200;
/**
 * Hard cap on queued wakes. Distinct message_ids — and payloads without a string
 * message_id, which bypass dedupe entirely — must not grow the queue forever.
 */
const MAX_PENDING = 100;
export const MAX_HTTP_BODY_BYTES = 64 * 1024;
const WAKE_PATH = '/agentschat/wake';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOCAL_HTTP_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|(?:tauri|dsh|dsh-app)\.localhost|\[::1\])(?::(\d{1,5}))?$/i;
const LOCAL_SCHEME_ORIGIN_RE = /^(?:app|tauri|dsh|dsh-app):\/\/[a-z0-9._-]+(?::(\d{1,5}))?$/i;
let inboundTmpSeq = 0;

/**
 * Only local DSH UI origins (loopback HTTP/HTTPS or desktop webview schemes)
 * may call this loopback bridge from a browser. External websites and
 * sandboxed `Origin: null` frames are rejected to prevent drive-by CSRF.
 */
export function isAllowedLocalOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 128) return false;
  if (origin === 'file://') return true;
  const httpMatch = LOCAL_HTTP_ORIGIN_RE.exec(origin);
  if (httpMatch) {
    if (httpMatch[1] !== undefined) {
      const p = Number(httpMatch[1]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
    }
    return true;
  }
  const schemeMatch = LOCAL_SCHEME_ORIGIN_RE.exec(origin);
  if (schemeMatch) {
    if (schemeMatch[1] !== undefined) {
      const p = Number(schemeMatch[1]);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
    }
    return true;
  }
  return false;
}

const RESERVED_PROFILE_SIDECARS = new Set([
  'profile',
  'session-binds',
  'session-binds.meta',
  'session-binds_meta',
  'session-binds-meta',
  'agy-binds',
  'agy-binds.meta',
  'agy-binds_meta',
  'agy-binds-meta',
  'agy-session-binds',
  'agy-session-binds.meta',
  'agy-session-binds_meta',
  'grok-binds',
  'grok-binds.meta',
  'grok-binds_meta',
  'grok-binds-meta',
  'identity-guard',
  'cursor',
  'read-cursors',
  'mention-timestamps',
  'wake-pids',
  'config',
  'codex-bots',
  'dsh',
  'muse',
]);

function isSafeKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !FORBIDDEN_KEYS.has(value.toLowerCase()) &&
    value !== '.' && value !== '..' && !/[\/\\]/.test(value) &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)
  );
}

export function isBlockedInboundHost(rawHostname) {
  if (typeof rawHostname !== 'string' || !rawHostname) return true;
  let host = rawHostname.toLowerCase().replace(/\.+$/, '');
  if (
    ['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data'].includes(host) ||
    host.endsWith('.metadata.google.internal') ||
    host.endsWith('.metadata.goog')
  ) {
    return true;
  }
  const unsafeV4 = (ip) => ip.startsWith('0.') || ip === '100.100.100.200' || ip.startsWith('169.254.');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return unsafeV4(host);
  if (!host.startsWith('[')) return false;
  try {
    host = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return true;
  }
  const address = host.slice(1, -1);
  const [left, right = ''] = address.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = (
    address.includes('::')
      ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
      : head
  ).map((x) => parseInt(x, 16));
  if (words.length !== 8 || words.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
  const mapped =
    (words.slice(0, 5).every((x) => x === 0) && words[5] === 0xffff) ||
    (words.slice(0, 4).every((x) => x === 0) && words[4] === 0xffff && words[5] === 0);
  if (mapped) return unsafeV4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  return (
    words.every((x) => x === 0) ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] === 0xfd00 && words[1] === 0xec2 && words.slice(2, 7).every((x) => x === 0) && words[7] === 0x254)
  );
}

function scrubSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(/\b(https?:\/\/)([^/\s@]*@)/gi, '$1[REDACTED]@')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bac_[A-Za-z0-9_-]{8,}/g, 'ac_[REDACTED]')
    .replace(/\bagent_key_[A-Za-z0-9_-]{8,}/g, 'agent_key_[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    .replace(/\b(?:hf_|npm_|mr_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/mcp_(?:at|rt|code)_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/whsec_[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]');
}
/**
 * Identifies the code the *running* instance actually has in memory.
 *
 * Local plugins are loaded from `file://` by the profile patch, and a reload is
 * not the same thing as a re-import: editing this file did not reload the
 * running plugin, while editing the profile patch did. Without a marker there
 * is no way to tell which version is live from the outside, which is how a
 * "fixed" build once delivered into a busy Session. `/health` reports it.
 */
const BUILD = 'inbound/2026-11-16.22-rc3-compat';
/** Producer-owned source kind; a bare `plugin` wrapper is refused by session format v4. */
const SOURCE_KIND = 'plugin:agentschat-inbound';
/** Poll interval while wakes wait for a root agent to finish its turn. */
const DEFAULT_RETRY_MS = 2000;
/** A flush that never settles must not hold delivery (or the next wake) hostage. */
const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/** Await `promise`, reporting a timeout instead of hanging on it. */
function settleWithin(promise, ms) {
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    promise.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    ),
    timedOut,
  ]).finally(() => clearTimeout(timer));
}

function isDarwinCanonicalSystemLink(dirPath) {
  if (process.platform !== 'darwin' || !['/var', '/tmp', '/etc'].includes(dirPath)) return false;
  try {
    return (
      realpathSync(dirPath) === `/private${dirPath}` &&
      !lstatSync('/private').isSymbolicLink() &&
      lstatSync('/private').isDirectory() &&
      !lstatSync(`/private${dirPath}`).isSymbolicLink() &&
      lstatSync(`/private${dirPath}`).isDirectory()
    );
  } catch {
    return false;
  }
}

export function checkParentDirectory(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(targetPath)) {
    throw new Error('Refusing unsafe parent directory');
  }
  const absRaw = isAbsolute(targetPath) ? targetPath : `${process.cwd()}${sep}${targetPath}`;
  const rawParent = dirname(absRaw);
  const root = parse(rawParent).root;
  const rawSegments = rawParent.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (rawSegments.includes('..')) {
    let cur = root;
    for (const seg of rawSegments) {
      if (seg === '.') continue;
      if (seg === '..') {
        cur = dirname(cur);
        continue;
      }
      const next = join(cur, seg);
      try {
        const lst = lstatSync(next);
        if (lst.isSymbolicLink() && !isDarwinCanonicalSystemLink(next)) {
          throw new Error('Refusing unsafe parent directory');
        }
        if (!lst.isSymbolicLink() && !lst.isDirectory()) {
          throw new Error('Refusing unsafe parent directory');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      cur = next;
    }
  }
  let parent = dirname(resolve(targetPath));
  for (;;) {
    try {
      const lst = lstatSync(parent);
      if (lst.isSymbolicLink()) {
        if (!isDarwinCanonicalSystemLink(parent)) throw new Error('Refusing unsafe parent directory');
      } else if (!lst.isDirectory()) {
        throw new Error('Refusing unsafe parent directory');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

function checkTarget(path) {
  try {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink() || !lst.isFile()) throw new Error('Refusing non-regular target');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function atomicReplaceRegular(tmp, target, fsOps) {
  const renameFn = fsOps?.renameSync ?? renameSync;
  const copyFn = fsOps?.copyFileSync ?? copyFileSync;
  const unlinkFn = fsOps?.unlinkSync ?? unlinkSync;
  checkParentDirectory(target);
  checkTarget(target);
  try {
    renameFn(tmp, target);
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      checkParentDirectory(target);
      checkTarget(target);
      copyFn(tmp, target);
      try {
        unlinkFn(tmp);
      } catch {}
      return;
    }
    throw err;
  }
}

/** Bound actual response bytes, regardless of Content-Length. */
async function readRegistrationText(res) {
  if (!res.body) throw new Error("Empty registration response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Registration response exceeds 1MiB");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function isSafeAgentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value !== "." && value !== ".." &&
    !FORBIDDEN_KEYS.has(value.toLowerCase()) && !/[\s\x00-\x1f\x7f-\x9f\u2028\u2029/\\]/.test(value);
}

function writeLog(logPath, line) {
  let fd;
  try {
    checkParentDirectory(logPath);
    mkdirSync(dirname(logPath), { recursive: true });
    checkParentDirectory(logPath);
    checkTarget(logPath);
    fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const lst = fstatSync(fd);
    if (!lst.isFile()) return;
    if (lst.size > LOG_MAX_BYTES) {
      closeSync(fd);
      fd = undefined;
      const tmp = `${logPath}.${process.pid}.${Date.now()}.${++inboundTmpSeq}.tmp`;
      let created = false;
      try {
        writeFileSync(tmp, '', { flag: 'wx', mode: 0o600 });
        created = true;
        atomicReplaceRegular(tmp, logPath);
      } finally {
        if (created) { try { unlinkSync(tmp); } catch {} }
      }
      fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    }
    appendFileSync(fd, `${new Date().toISOString()} ${line}\n`);
  } catch {} finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read the shared wake secret, creating it (0600) atomically when absent. */
function loadSecret(secretPath, logFn) {
  try {
    checkParentDirectory(secretPath);
    try {
      const lst = lstatSync(secretPath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        logFn(`refusing non-regular wake secret path: ${secretPath}`);
        return undefined;
      }
      const existing = readFileSync(secretPath, 'utf8').trim();
      if (existing) return existing;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    checkParentDirectory(secretPath);
    const secret = randomBytes(32).toString('hex');
    const tmp = `${secretPath}.${process.pid}.${Date.now()}.${++inboundTmpSeq}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, `${secret}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
      atomicReplaceRegular(tmp, secretPath);
      try {
        chmodSync(secretPath, 0o600);
      } catch (error) {
        logFn(`WARNING: could not chmod ${secretPath}: ${error?.message ?? error}`);
      }
    } catch (err) {
      try {
        if (created) unlinkSync(tmp);
      } catch {}
      throw err;
    }
    return secret;
  } catch (error) {
    logFn(`cannot load wake secret: ${error?.message ?? error}`);
    return undefined;
  }
}

export function verifySignature(body, sigHex, secret) {
  if (typeof body !== 'string' || typeof secret !== 'string' || secret.length === 0) return false;
  if (typeof sigHex !== 'string' || sigHex.length === 0) return false;
  const normalized = sigHex.startsWith('sha256=') ? sigHex.slice(7) : sigHex;
  if (!/^[0-9a-f]{64}$/i.test(normalized)) return false;
  const received = Buffer.from(normalized, 'hex');
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Render the inbound message as a normal user turn for the agent. */
function renderInbound(payload) {
  const header = (value) => String(value ?? '(unknown)').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 128);
  const channel = header(payload.channel_id);
  const kind = /^dm[-:]/i.test(channel) ? 'direct message' : 'channel message';
  return [
    '[AgentsChat inbound message]',
    `channel_id: ${channel}`,
    payload.message_id ? `message_id: ${header(payload.message_id)}` : undefined,
    `from: ${header(payload.sender_id)}`,
    `kind: ${kind}`,
    'content:',
    payload.content ?? '(empty)',
    '',
    `When a reply is appropriate, use the mcp__agentschat__reply tool with chat_id "${channel}".`,
    'Keep the reply concise. Never include tokens, keys, or claim URLs.',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

export function apply(ctx, config = {}) {
  const rawPort = Number(config.port ?? 8799);
  const requestedPort = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 8799;
  let boundPort = requestedPort;
  const agentschatDir = config.agentschatDir ?? AGENTSCHAT_DIR;
  const profilesDir = join(agentschatDir, 'profiles');
  const bindsPath = join(agentschatDir, 'session-binds.json');
  const secretPath = config.secretPath ?? (config.agentschatDir ? join(agentschatDir, 'dsh-inbound.secret') : SECRET_PATH);
  const queuePath = config.queuePath ?? (config.agentschatDir ? join(agentschatDir, 'dsh-wake-queue.jsonl') : QUEUE_PATH);
  const logPath = config.logPath ?? LOG_PATH;
  const log = (line) => writeLog(logPath, line);

  const seen = [];
  const seenSet = new Set();

  /** Deduplicate wake retries by message_id; bounded memory per plugin instance. */
  function firstDelivery(payload) {
    const id = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    if (!id) return true;
    if (seenSet.has(id)) return false;
    seenSet.add(id);
    seen.push(id);
    if (seen.length > MAX_SEEN_IDS) {
      const evicted = seen.shift();
      if (evicted !== undefined) seenSet.delete(evicted);
    }
    return true;
  }

  /**
   * Release a claim taken by firstDelivery() after a delivery that never landed.
   */
  function forgetDelivery(payload) {
    const id = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    if (!id || !seenSet.delete(id)) return;
    const index = seen.indexOf(id);
    if (index >= 0) seen.splice(index, 1);
  }

  // When installed as the published `agentschat-mcp` DSH bundle, `../../dist/dsh.js`
  // sits right inside the package so the wake daemon starts zero-config. Machine-local
  // copies (`~/.dsh/plugins/...`) lack `../../dist/dsh.js` and fall back to config/env.
  const defaultBundledMcpBin = (() => {
    try {
      const candidate = fileURLToPath(new URL('../../dist/dsh.js', import.meta.url));
      return existsSync(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  })();
  const mcpBin = config.mcpBin ?? process.env.AGENTSCHAT_DSH_BRIDGE_BIN ?? defaultBundledMcpBin;
  const nodeBin =
    config.nodeBin ??
    process.env.DSH_NODE_BIN ??
    process.env.DSH_NODE ??
    (process.versions?.electron ? process.execPath : 'node');
  const channels = Array.isArray(config.channels) && config.channels.length > 0 ? config.channels : ['welcome'];
  const rawRetryMs = Number(config.retryMs ?? DEFAULT_RETRY_MS);
  const retryMs = Number.isFinite(rawRetryMs) && rawRetryMs >= 10 ? Math.min(Math.floor(rawRetryMs), 300_000) : DEFAULT_RETRY_MS;
  const rawFlushTimeoutMs = Number(config.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
  const flushTimeoutMs = Number.isFinite(rawFlushTimeoutMs) && rawFlushTimeoutMs >= 10 ? Math.min(Math.floor(rawFlushTimeoutMs), 300_000) : DEFAULT_FLUSH_TIMEOUT_MS;

  const secret = loadSecret(secretPath, log);
  if (secret === undefined) {
    log('not starting: no wake secret');
    return;
  }

  let stopping = false;
  let daemon;
  let restartTimer;
  let consecutiveFailures = 0;

  /**
   * DSH >= 0.2.1-rc.3 removed `AgentRegistry.roots()` in favor of `list()` and
   * marks delegated child sessions via `session.header.origin === 'subagent'`
   * or `delegationDepth > 0`.
   */
  function isOrdinaryRootAgent(agent) {
    if (!agent || typeof agent !== 'object') return false;
    const header = agent.session?.header;
    if (header && typeof header === 'object') {
      if (header.origin === 'subagent') return false;
      if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return false;
    }
    return true;
  }

  function isArchivedSession(sessionId) {
    try {
      const archived = ctx.get('workspaceRegistry')?.archivedSessionIds;
      return Array.isArray(archived) && archived.includes(sessionId);
    } catch {
      return false;
    }
  }

  /** Live root agents, oldest first, with the status the gate reads. */
  function rootStatuses() {
    return liveRoots().map((agent) => {
      let status;
      try {
        status = agent.status;
      } catch (error) {
        status = `error: ${error?.message ?? error}`;
      }
      return { id: agent.id, status };
    });
  }

  /** Live root agents, oldest first (compatible with both DSH 0.1.x `roots()` and 0.2.1-rc.3+ `list()`). */
  function liveRoots() {
    let agents;
    try {
      agents = ctx.get('agents');
    } catch (error) {
      log(`agents service unavailable: ${error?.message ?? error}`);
      return [];
    }
    if (agents === undefined || agents === null) return [];
    try {
      if (typeof agents.roots === 'function') {
        return agents.roots();
      }
      if (typeof agents.list === 'function') {
        return agents.list().filter(isOrdinaryRootAgent);
      }
      log('cannot list root agents: neither agents.roots() nor agents.list() is available');
      return [];
    } catch (error) {
      log(`cannot list root agents: ${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * Resolve a bound session to its live Agent, activating a cold persisted
   * session through `sessionController.resolveAgent()` on DSH >= 0.2.1-rc.3
   * (same activation seam `@deepseek-ai/dsh-schedule` uses).
   */
  async function resolveBoundTargetAgent(wanted) {
    const live = liveRoots().find((agent) => agent.id === wanted);
    if (live !== undefined) return live;
    if (isArchivedSession(wanted)) return undefined;
    let sessionController;
    try {
      sessionController = ctx.get('sessionController');
    } catch {
      return undefined;
    }
    if (sessionController && typeof sessionController.resolveAgent === 'function') {
      const outcome = await settleWithin(
        Promise.resolve().then(() => sessionController.resolveAgent(wanted)),
        10_000,
      );
      if (outcome.timedOut === true) {
        log(`WARNING: session activation for ${wanted} timed out after 10000ms`);
        return undefined;
      }
      if (outcome.ok === true && outcome.value && typeof outcome.value === 'object' && !('error' in outcome.value) && outcome.value.agent) {
        return isOrdinaryRootAgent(outcome.value.agent) ? outcome.value.agent : undefined;
      }
    }
    return undefined;
  }

  /** Wake deliveries waiting for their bound session to go idle, oldest first. */
  const pending = [];
  let retryTimer;
  let draining = false;

  function scheduleRetry() {
    if (stopping || retryTimer !== undefined || pending.length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      drain().catch((error) => log(`drain failed: ${error?.message ?? error}`));
    }, retryMs);
  }

  /**
   * Deliver the queued head to its bound session, or report why it must wait.
   *
   * Delivery is bound-only: a wake lands in the session named by
   * `payload.target_session_id` (resolved from `session-binds.json` by the
   * daemon), never in a guess. A busy target is steered into its current turn
   * rather than waited for; an idle one takes the plain `followup()` splice.
   */
  async function attempt(entry) {
    const id = entry.payload.message_id ?? '(no id)';
    const wanted = typeof entry.payload.target_session_id === 'string' ? entry.payload.target_session_id : undefined;
    if (wanted === undefined) {
      log(`wake ${id} dropped: identity is unbound (bind a session in the identity chip to receive it here)`);
      return 'dropped';
    }
    const target = await resolveBoundTargetAgent(wanted);
    if (target === undefined) {
      log(`wake ${id} dropped: bound session ${wanted} is not live (bind the identity to an open session)`);
      return 'dropped';
    }
    if (target.status !== 'idle') {
      // Busy target → cut in, do not wait. `agent.steer()` hands the message to the
      // *running* turn at its next step boundary; it is the same call DSH's own
      // session controller uses for a prompt typed while the agent works. Only if
      // that API is absent or throws do we fall back to waiting for idle.
      if (typeof target.steer === 'function') {
        try {
          target.steer(entry.message);
          log(
            `injected ${id} from ${entry.payload.sender_id ?? '?'} into agent=${wanted} ` +
              '(steered into the running turn)',
          );
          return 'delivered';
        } catch (error) {
          log(`steer failed for ${wanted}: ${error?.message ?? error}; queuing instead`);
        }
      }
      if (entry.waited !== true) {
        entry.waited = true;
        log(`wake ${id} queued: bound session ${wanted} is not idle`);
      }
      return 'deferred';
    }
    try {
      target.followup(entry.message);
    } catch (error) {
      log(`followup failed for agent=${target.id}: ${error?.message ?? error}`);
      forgetDelivery(entry.payload);
      return 'dropped';
    }
    // followup splices the inbox synchronously; flushing here only proves the
    // Session log accepted the row, so a rejected message is reported in this
    // log instead of surfacing as a dead turn in the GUI.
    try {
      const sessions = ctx.get('sessions');
      if (sessions === undefined) {
        log(`WARNING: sessions service unavailable; ${id} queued unverified`);
      } else {
        const outcome = await settleWithin(sessions.flush(target.session), flushTimeoutMs);
        if (outcome.timedOut === true) {
          log(`WARNING: flush for ${id} did not finish within ${flushTimeoutMs}ms`);
        } else if (outcome.ok !== true) {
          log(`persist failed for agent=${target.id}: ${outcome.error?.message ?? outcome.error}`);
        }
      }
    } catch (error) {
      log(`persist failed for agent=${target.id}: ${error?.message ?? error}`);
    }
    log(
      `injected ${id} from ${entry.payload.sender_id ?? '?'} into agent=${target.id} ` +
        `roots=[${liveRoots()
          .map((root) => root.id)
          .join(', ')}]`,
    );
    return 'delivered';
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0 && !stopping) {
        let outcome;
        try {
          outcome = await attempt(pending[0]);
        } catch (error) {
          log(`attempt failed: ${error?.message ?? error}`);
          break;
        }
        if (outcome === 'deferred') break;
        pending.shift();
      }
    } finally {
      draining = false;
      // Reschedule inside `finally`: an unexpected throw above must not strand
      // the queue head without a timer.
      scheduleRetry();
    }
  }

  async function inject(payload) {
    if (payload === null || typeof payload !== 'object') {
      log('ignoring non-object wake payload');
      return;
    }
    if (!firstDelivery(payload)) {
      log(`duplicate wake for ${payload.message_id}, ignored`);
      return;
    }
    if (pending.length >= MAX_PENDING) {
      // Bounded, not lossless: drop the oldest so the newest inbound — the one a
      // human is most likely waiting on — still gets delivered.
      const dropped = pending.shift();
      log(`pending at ${MAX_PENDING}; dropped oldest wake ${dropped?.payload?.message_id ?? '(no id)'}`);
    }
    pending.push({
      payload,
      message: {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderInbound(payload) }],
        source: { kind: SOURCE_KIND },
      },
    });
    await drain();
  }

  /**
   * Profiles the identity chip may bind, newest first. Never exposes tokens.
   *
   * Both layouts are scanned because the MCP server resolves either: nested
   * `<config>/profiles/<name>.json` first, then the flat legacy `<config>/<name>.json`
   * (that is where a hand-written `DSH_Live.json` lives). Nested wins on a name
   * collision, matching the server's precedence; entries without `agent_id` are
   * cursors/manifests, not profiles.
   */
  function listProfiles() {
    const out = [];
    const seenNames = new Set();
    const scan = (dir) => {
      try {
        const dirStat = lstatSync(dir);
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
      } catch {
        return;
      }
      let files;
      try {
        files = readdirSync(dir).filter((file) => /\.json$/i.test(file));
      } catch {
        return;
      }
      for (const file of files) {
        const name = file.replace(/\.json$/i, '');
        if (!isSafeKey(name) || RESERVED_PROFILE_SIDECARS.has(name.toLowerCase()) || seenNames.has(name)) continue;
        const path = join(dir, file);
        try {
          const lst = lstatSync(path);
          if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 256 * 1024) continue;
          const parsed = JSON.parse(readFileSync(path, 'utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, '__proto__')) continue;
          const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id.trim() : '';
          if (!isSafeAgentId(agentId)) continue;
          seenNames.add(name);
          out.push({
            name,
            agentId,
            displayName: typeof parsed.display_name === 'string' ? parsed.display_name : undefined,
            mtime: lst.mtimeMs,
          });
        } catch {}
      }
    };
    scan(profilesDir);
    scan(agentschatDir);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  function readBinds() {
    try {
      const lst = lstatSync(bindsPath);
      if (lst.isSymbolicLink() || !lst.isFile() || lst.size > 256 * 1024) return {};
      const parsed = JSON.parse(readFileSync(bindsPath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, '__proto__')) return {};
      const clean = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!isSafeKey(k) || typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (!isSafeKey(trimmed)) continue;
        clean[k] = trimmed;
      }
      return clean;
    } catch {
      return {};
    }
  }

  /** Same shape the MCP server reads: `{ [sessionId]: profileName }`. */
  function writeBinds(binds) {
    checkParentDirectory(bindsPath);
    try {
      const lst = lstatSync(bindsPath);
      if (lst.isSymbolicLink() || !lst.isFile()) {
        throw new Error(`Refusing to overwrite non-regular session-binds path: ${bindsPath}`);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    mkdirSync(agentschatDir, { recursive: true, mode: 0o700 });
    checkParentDirectory(bindsPath);
    const tmp = `${bindsPath}.${process.pid}.${Date.now()}.${++inboundTmpSeq}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, `${JSON.stringify(binds, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      created = true;
      atomicReplaceRegular(tmp, bindsPath);
      try {
        chmodSync(bindsPath, 0o600);
      } catch {}
    } catch (err) {
      try {
        if (created) unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }

  function buildCorsHeaders(origin) {
    if (typeof origin !== 'string' || !isAllowedLocalOrigin(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin',
    };
  }

  function sendJson(res, status, value, corsHeaders = {}) {
    res.writeHead(status, {
      'content-type': 'application/json',
      ...corsHeaders,
    });
    res.end(JSON.stringify(value));
  }

  /** Read a bounded UTF-8 request body; rejects payloads above `MAX_HTTP_BODY_BYTES` with 413. */
  function readBoundedBody(req, res, corsHeaders, onText) {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        settled = true;
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
        }
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      settled = true;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      onText(Buffer.concat(chunks).toString('utf8'));
    });
  }

  /** Read a bounded JSON body; the endpoint is loopback-only and unauthenticated. */
  function readJsonBody(req, res, corsHeaders, onBody) {
    readBoundedBody(req, res, corsHeaders, (rawText) => {
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' }, corsHeaders);
        return;
      }
      onBody(parsed);
    });
  }

  const server = createServer((req, res) => {
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && (typeof originHeader !== 'string' || !isAllowedLocalOrigin(originHeader))) {
      log(`rejected cross-origin request from origin=${String(originHeader).slice(0, 120)}`);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    const corsHeaders = buildCorsHeaders(originHeader);

    if (req.method === 'OPTIONS') {
      const preflightHeaders = { ...corsHeaders };
      if (req.headers['access-control-request-private-network'] === 'true' && typeof originHeader === 'string') {
        preflightHeaders['access-control-allow-private-network'] = 'true';
      }
      res.writeHead(204, preflightHeaders);
      res.end();
      return;
    }
    // Identity API for the Client chip: which profiles exist, which one this
    // conversation is bound to, and binding it. Bindings are the same
    // `session-binds.json` the MCP server reads per tool call, so the chip needs
    // no separate storage — and the next tool call from this session picks the
    // identity up without a restart.
    if (req.method === 'GET' && req.url === '/identity') {
      sendJson(res, 200, { ok: true, build: BUILD, profiles: listProfiles(), binds: readBinds() }, corsHeaders);
      return;
    }
    if (req.method === 'POST' && req.url === '/identity/bind') {
      readJsonBody(req, res, corsHeaders, (body) => {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        const profileName = typeof body?.profileName === 'string' ? body.profileName.trim() : '';
        if (!isSafeKey(sessionId) || !isSafeKey(profileName) || !listProfiles().some((entry) => entry.name === profileName)) {
          sendJson(res, 400, { ok: false, error: 'sessionId and a known profileName are required' }, corsHeaders);
          return;
        }
        const binds = readBinds();
        binds[sessionId] = profileName;
        try {
          writeBinds(binds);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: scrubSecrets(String(error?.message ?? error)) }, corsHeaders);
          return;
        }
        log(`identity bound: ${sessionId} -> ${profileName}`);
        sendJson(res, 200, { ok: true, binds }, corsHeaders);
      });
      return;
    }
    // Probe used by the Client chip: proves the browser module actually ran, and
    // carries whatever failed. Without it a blank UI is indistinguishable from a
    // module that never loaded.
    if (req.method === 'POST' && req.url === '/identity/alive') {
      readJsonBody(req, res, corsHeaders, (body) => {
        log(`client-alive ${scrubSecrets(JSON.stringify(body).slice(0, 512))}`);
        sendJson(res, 200, { ok: true, build: BUILD }, corsHeaders);
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/identity/create') {
      readJsonBody(req, res, corsHeaders, async (body) => {
        const rawSessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        if (rawSessionId && !isSafeKey(rawSessionId)) {
          sendJson(res, 400, { ok: false, error: 'invalid sessionId' }, corsHeaders);
          return;
        }
        const sessionId = rawSessionId;
        const rawName = typeof body?.name === 'string' && body.name.trim()
          ? body.name.trim().replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '').slice(0, 48)
          : `DSH_${sessionId ? sessionId.replace(/^session-/, '').slice(0, 6) : randomBytes(3).toString('hex')}`;
        const sanitizedBase = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
        const baseName =
          isSafeKey(sanitizedBase) && !RESERVED_PROFILE_SIDECARS.has(sanitizedBase.toLowerCase())
            ? sanitizedBase
            : `DSH_${randomBytes(3).toString('hex')}`;
        let profileName = baseName;
        let suffix = 2;
        try {
          checkParentDirectory(join(profilesDir, 'placeholder'));
        } catch {
          sendJson(res, 500, { ok: false, error: 'refusing unsafe profiles directory' }, corsHeaders);
          return;
        }
        mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
        while (existsSync(join(profilesDir, `${profileName}.json`)) || existsSync(join(agentschatDir, `${profileName}.json`))) {
          profileName = `${baseName}_${suffix++}`;
        }
        const restBase = String(
          config.apiUrl ??
          process.env.AGENTCHAT_REST_URL ??
          process.env.AGENTSCHAT_API_URL ??
          'https://agents-chat.com',
        )
          .trim()
          .replace(/\/+$/, '');
        let parsedRest;
        try {
          parsedRest = new URL(restBase);
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid API URL' }, corsHeaders);
          return;
        }
        const host = parsedRest.hostname.toLowerCase().replace(/\.+$/, '');
        const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
        if ((parsedRest.protocol !== 'https:' && !(parsedRest.protocol === 'http:' && loopback)) ||
            isBlockedInboundHost(parsedRest.hostname) ||
            parsedRest.username || parsedRest.password || parsedRest.port === '0' || parsedRest.search || parsedRest.hash ||
            /[\x00-\x20\x7f-\x9f\u2028\u2029"<>\\]/.test(restBase)) {
          sendJson(res, 400, { ok: false, error: 'unsupported API URL protocol' }, corsHeaders);
          return;
        }
        const wsUrl =
          process.env.AGENTCHAT_WS_URL ??
          `${restBase.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')}/ws`;
        try {
          const regRes = await fetch(`${restBase}/api/account/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: rawName,
              type: 'agent',
              capabilities: ['dsh', 'coding', 'chat'],
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          });
          if (!regRes.ok) {
            const errText = scrubSecrets(await readRegistrationText(regRes)).slice(0, 200);
            sendJson(res, 502, { ok: false, error: `register HTTP ${regRes.status}: ${errText}` }, corsHeaders);
            return;
          }
          const data = JSON.parse(await readRegistrationText(regRes));
          const rawAgentId = data?.agentId ?? data?.agent_id ?? data?.id;
          const rawToken = data?.agentKey ?? data?.token ?? data?.key;
          const agentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
          const token = typeof rawToken === 'string' ? rawToken.trim() : '';
          if (!isSafeAgentId(rawAgentId) || !token || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(agentId) || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(token)) {
            sendJson(res, 502, { ok: false, error: 'register response missing agent_id/token' }, corsHeaders);
            return;
          }
          const profilePath = join(profilesDir, `${profileName}.json`);
          try {
            const lst = lstatSync(profilePath);
            if (lst.isSymbolicLink() || !lst.isFile()) {
              sendJson(res, 500, { ok: false, error: 'refusing non-regular profile path' }, corsHeaders);
              return;
            }
          } catch (err) {
            if (err?.code !== 'ENOENT') throw err;
          }
          const record = {
            name: profileName,
            display_name: rawName,
            agent_id: agentId,
            token,
            server: wsUrl,
            api_url: restBase,
            created_at: new Date().toISOString(),
          };
          const tmp = `${profilePath}.${process.pid}.${Date.now()}.${++inboundTmpSeq}.tmp`;
          let created = false;
          try {
            writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            created = true;
            atomicReplaceRegular(tmp, profilePath);
            try {
              chmodSync(profilePath, 0o600);
            } catch {}
          } catch (err) {
            try {
              if (created) unlinkSync(tmp);
            } catch {}
            throw err;
          }
          const binds = readBinds();
          if (sessionId) {
            binds[sessionId] = profileName;
            writeBinds(binds);
          }
          log(`identity created: ${profileName} (${agentId})${sessionId ? ` bound to ${sessionId}` : ''}`);
          sendJson(
            res,
            200,
            {
              ok: true,
              profile: { name: profileName, agentId, displayName: rawName },
              profiles: listProfiles(),
              binds,
            },
            corsHeaders,
          );
        } catch (error) {
          sendJson(res, 500, { ok: false, error: scrubSecrets(String(error?.message ?? error)) }, corsHeaders);
        }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/identity/unbind') {
      readJsonBody(req, res, corsHeaders, (body) => {
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!isSafeKey(sessionId)) {
          sendJson(res, 400, { ok: false, error: 'sessionId required' }, corsHeaders);
          return;
        }
        const binds = readBinds();
        delete binds[sessionId];
        try {
          writeBinds(binds);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: scrubSecrets(String(error?.message ?? error)) }, corsHeaders);
          return;
        }
        log(`identity unbound: ${sessionId}`);
        sendJson(res, 200, { ok: true, binds }, corsHeaders);
      });
      return;
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/selftest')) {
      const roots = rootStatuses();
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      if (req.url === '/health') {
        // `build` is the only way to tell which file:// version is actually in
        // memory; `agents` is kept for scripts that predate `roots`.
        res.end(
          JSON.stringify({
            ok: true,
            plugin: name,
            build: BUILD,
            port: boundPort,
            agents: roots.map((root) => root.id),
            roots,
            daemon: daemon !== undefined,
          }),
        );
        return;
      }
      // Dry run: which bound sessions would accept a wake *right now*, with no
      // splice. The gate's failure mode (freezing a busy Session) is
      // unrecoverable, so it has to be answerable before anything is delivered.
      // Delivery is bound-only, so the useful answer is per binding, not "the
      // newest idle root".
      const byId = new Map(liveRoots().map((agent) => [agent.id, agent]));
      let hasActivator = false;
      try {
        hasActivator = typeof ctx.get('sessionController')?.resolveAgent === 'function';
      } catch {}
      const bound = Object.entries(readBinds()).map(([sessionId, profileName]) => {
        const agent = byId.get(sessionId);
        const canActivate = agent === undefined && hasActivator && !isArchivedSession(sessionId);
        return {
          sessionId,
          profile: profileName,
          status: agent === undefined ? (canActivate ? 'cold' : 'missing') : agent.status,
          decision:
            agent === undefined
              ? canActivate
                ? 'activate'
                : 'drop'
              : agent.status === 'idle'
                ? 'deliver'
                : typeof agent.steer === 'function'
                  ? 'steer'
                  : 'queue',
        };
      });
      res.end(
        JSON.stringify({
          ok: true,
          build: BUILD,
          dryRun: true,
          policy: 'bound-only',
          busyPolicy: 'steer',
          bound,
          roots,
          pending: pending.length,
        }),
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== WAKE_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain', ...corsHeaders });
      res.end('not found');
      return;
    }
    readBoundedBody(req, res, corsHeaders, (body) => {
      const signature = req.headers['x-agentschat-signature'];
      if (!verifySignature(body, typeof signature === 'string' ? signature : '', secret)) {
        log('rejected wake: bad or missing signature');
        res.writeHead(403, { 'content-type': 'text/plain', ...corsHeaders });
        res.end('forbidden');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        log(`rejected wake: invalid JSON (${error?.message ?? error})`);
        res.writeHead(400, { 'content-type': 'text/plain', ...corsHeaders });
        res.end('bad request');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
      res.end('{"ok":true}');
      inject(payload).catch((error) => log(`inject failed: ${error?.message ?? error}`));
    });
  });
  server.on('error', (error) => {
    log(`http server error: ${error?.message ?? error}`);
    // The supervisor must not exist without an endpoint of its own: it would post
    // to whatever else happens to own the port.
    log('not starting the wake daemon: the endpoint is not ours');
  });
  server.listen(requestedPort, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object' && typeof addr.port === 'number') {
      boundPort = addr.port;
    }
    log(`listening on http://127.0.0.1:${boundPort}${WAKE_PATH} (health: /health, selftest: /selftest, build: ${BUILD})`);
    if (typeof config.onListening === 'function') {
      try {
        config.onListening({ port: boundPort });
      } catch {}
    }
    startDaemon();
  });

  function startDaemon() {
    if (stopping) return;
    if (typeof mcpBin !== 'string' || mcpBin.length === 0) {
      log('not starting the wake daemon: no mcpBin configured (set config.mcpBin or AGENTSCHAT_DSH_BRIDGE_BIN)');
      return;
    }
    const args = [mcpBin, '--dsh', '--wake'];
    for (const channel of channels) args.push('--channel', channel);
    const env = {
      ...process.env,
      ...(process.versions?.electron && nodeBin === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      DSH_WAKE_URL: `http://127.0.0.1:${boundPort}${WAKE_PATH}`,
      DSH_WAKE_SECRET: secret,
      DSH_WAKE_QUEUE: queuePath,
    };
    log(`starting wake daemon: ${nodeBin} ${args.join(' ')}`);
    daemon = spawn(nodeBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[daemon] ${text}`);
      if (text.includes('wake daemon listening')) consecutiveFailures = 0;
    });
    daemon.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[daemon] ${text}`);
    });
    daemon.on('error', (error) => log(`[daemon] spawn failed: ${error?.message ?? error}`));
    daemon.on('exit', (code, signal) => {
      log(`[daemon] exited code=${code} signal=${signal}`);
      daemon = undefined;
      if (stopping) return;
      consecutiveFailures += 1;
      if (consecutiveFailures > 10) {
        log('wake daemon failed 10 times; giving up until the plugin reloads');
        return;
      }
      const delay = Math.min(5000 * consecutiveFailures, 60000);
      log(`[daemon] restarting in ${Math.round(delay / 1000)}s`);
      restartTimer = setTimeout(startDaemon, delay);
    });
  }

  ctx.effect(
    () => () => {
      stopping = true;
      if (restartTimer !== undefined) clearTimeout(restartTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      if (pending.length > 0) log(`stopping with ${pending.length} undelivered wake(s)`);
      try {
        daemon?.kill('SIGTERM');
      } catch {}
      try {
        server.close();
      } catch {}
      log('stopped');
    },
    'agentschat-inbound',
  );
}
