#!/usr/bin/env node

// dsh/src/cli.ts
import { chmodSync as chmodSync3, copyFileSync as copyFileSync2, lstatSync as lstatSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync7, renameSync as renameSync3, unlinkSync as unlinkSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { randomBytes as randomBytes3 } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname as dirname6, join as join6 } from "node:path";
import { homedir as homedir5 } from "node:os";

// muse/src/policy.ts
var MAX_HISTORY_MESSAGES = 50;
var MAX_CONTEXT_BYTES = 15000;
var MAX_MESSAGE_BYTES = 2000;
function isMentioned(content, agentId, displayName) {
  if (typeof content !== "string")
    return false;
  const haystack = content.toLowerCase();
  const names = [agentId, displayName, "muse"].filter((name) => typeof name === "string" && name.trim().length > 0).map((name) => `@${name.trim().toLowerCase()}`);
  return names.some((name) => {
    let index = haystack.indexOf(name);
    while (index !== -1) {
      const before = haystack[index - 1];
      const afterCodePoint = haystack.codePointAt(index + name.length);
      const after = afterCodePoint === undefined ? "" : String.fromCodePoint(afterCodePoint);
      if ((!before || !/[a-z0-9@]/i.test(before)) && (!after || !/[\p{L}\p{N}\p{M}_-]/u.test(after)))
        return true;
      index = haystack.indexOf(name, index + 1);
    }
    return false;
  });
}
function shouldDispatch(message, opts) {
  if (!message || typeof message !== "object" || typeof message.content !== "string")
    return false;
  if (message.sender_id === opts.agentId)
    return false;
  if (opts.channelKind === "direct")
    return true;
  if (!opts.channelKind && typeof message.channel_id === "string" && /^dm[-:]/i.test(message.channel_id))
    return true;
  return isMentioned(message.content, opts.agentId, opts.displayName);
}
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0)
    return "";
  const encoder = new TextEncoder;
  if (encoder.encode(text).length <= maxBytes)
    return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes)
      low = mid;
    else
      high = mid - 1;
  }
  if (low > 0 && low < text.length && text.charCodeAt(low - 1) >= 55296 && text.charCodeAt(low - 1) <= 56319 && text.charCodeAt(low) >= 56320 && text.charCodeAt(low) <= 57343)
    low -= 1;
  return text.slice(0, low);
}
function buildContext(messages, agentId) {
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines = [];
  let bytes = 0;
  for (const m of [...recent].reverse()) {
    const sender = typeof m.sender_id === "string" ? m.sender_id.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 128) : "unknown";
    const line = `${sender}: ${truncateToBytes(m.content, MAX_MESSAGE_BYTES)}
`;
    const lineBytes = new TextEncoder().encode(line).length;
    if (bytes + lineBytes > MAX_CONTEXT_BYTES)
      break;
    bytes += lineBytes;
    lines.push(line);
  }
  return lines.reverse().join("");
}

// muse/src/typing.ts
var TYPING_HEARTBEAT_MS = 2000;
var TYPING_HEARTBEAT_MAX_MS = 120000;

class TypingHeartbeat {
  timers = new Map;
  send;
  constructor(send) {
    this.send = send;
  }
  pulse(channelId) {
    try {
      this.send(channelId);
    } catch {}
  }
  start(channelId) {
    if (!channelId || process.env.AGENTSCHAT_AUTO_TYPING === "0")
      return;
    this.stop(channelId);
    this.pulse(channelId);
    const interval = setInterval(() => this.pulse(channelId), TYPING_HEARTBEAT_MS);
    interval.unref?.();
    const cap = setTimeout(() => this.stop(channelId), TYPING_HEARTBEAT_MAX_MS);
    cap.unref?.();
    this.timers.set(channelId, { interval, cap });
  }
  stop(channelId) {
    const h = this.timers.get(channelId);
    if (!h)
      return;
    clearInterval(h.interval);
    clearTimeout(h.cap);
    this.timers.delete(channelId);
  }
  stopAll() {
    for (const channelId of [...this.timers.keys()])
      this.stop(channelId);
  }
}

// muse/src/bridge.ts
class MuseBridge {
  client;
  activeReplies = new Map;
  history = new Map;
  opts;
  typing = new TypingHeartbeat((channelId) => this.client.sendTyping(channelId));
  constructor(client, opts) {
    this.client = client;
    this.opts = opts;
    this.client.onMessage((m) => this.handleMessage(m));
  }
  async start() {
    await this.client.connect();
    for (const channelId of this.opts.channels)
      this.client.joinChannel(channelId);
  }
  rejoin() {
    for (const channelId of this.opts.channels)
      this.client.joinChannel(channelId);
  }
  stop() {
    this.typing.stopAll();
    this.activeReplies.clear();
    this.client.disconnect();
  }
  get isConnected() {
    return this.client.isConnected;
  }
  async handleMessage(message) {
    if (!message.channel_id || message.content === "__typing__")
      return;
    if (!this.history.has(message.channel_id) && this.history.size >= 200) {
      const oldest = this.history.keys().next().value;
      if (oldest !== undefined)
        this.history.delete(oldest);
    }
    const list = this.history.get(message.channel_id) ?? [];
    list.push(message);
    this.history.set(message.channel_id, list.slice(-50));
    const kinds = this.opts.channelKinds;
    const kind = kinds && Object.prototype.hasOwnProperty.call(kinds, message.channel_id) ? kinds[message.channel_id] : undefined;
    if (!shouldDispatch(message, { agentId: this.opts.agentId, displayName: this.opts.displayName, channelKind: kind })) {
      return;
    }
    const active = this.activeReplies.get(message.channel_id) ?? 0;
    this.activeReplies.set(message.channel_id, active + 1);
    if (active === 0)
      this.typing.start(message.channel_id);
    try {
      const ctx = {
        message,
        channelKind: kind,
        history: [...this.history.get(message.channel_id) ?? []],
        context: buildContext(this.history.get(message.channel_id) ?? [], this.opts.agentId)
      };
      const reply = await this.opts.responder(ctx);
      if (reply) {
        if (message.thread_id) {
          this.client.sendMessage(message.channel_id, reply, "text", message.thread_id);
        } else {
          this.client.sendMessage(message.channel_id, reply);
        }
      }
    } finally {
      const remaining = (this.activeReplies.get(message.channel_id) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeReplies.delete(message.channel_id);
        this.typing.stop(message.channel_id);
      } else {
        this.activeReplies.set(message.channel_id, remaining);
      }
    }
  }
}

// muse/src/config.ts
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
var PROFILE_PATH = join(homedir(), ".agentschat", "muse.json");
var MAX_PROFILE_BYTES = 64 * 1024;
function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}
function isUnsafeEndpointHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (["metadata.google.internal", "metadata.goog", "metadata", "instance-data"].includes(host) || host.endsWith(".metadata.goog"))
    return true;
  const unsafeV4 = (ip) => ip === "0.0.0.0" || ip === "100.100.100.200" || ip.startsWith("169.254.");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
    return unsafeV4(host);
  if (!host.startsWith("["))
    return false;
  const address = host.slice(1, -1);
  const [left, right = ""] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words = (address.includes("::") ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head).map((x) => parseInt(x, 16));
  if (words.length !== 8)
    return true;
  const mapped = words.slice(0, 5).every((x) => x === 0) && words[5] === 65535 || words.slice(0, 4).every((x) => x === 0) && words[4] === 65535 && words[5] === 0;
  if (mapped)
    return unsafeV4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  return words.every((x) => x === 0) || (words[0] & 65472) === 65152 || words[0] === 64768 && words[1] === 3778 && words.slice(2, 7).every((x) => x === 0) && words[7] === 596;
}
function assertSafeParentDirectories(file) {
  const parent = dirname(isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`);
  const parts = parent.split(sep);
  for (let i = 1;i <= parts.length; i++) {
    const dir = parts.slice(0, i).join(sep) || sep;
    try {
      const st = lstatSync(dir);
      const systemLink = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(dir) && st.isSymbolicLink() && realpathSync(dir) === `/private${dir}` && !lstatSync(`/private${dir}`).isSymbolicLink() && lstatSync(`/private${dir}`).isDirectory();
      if (!systemLink && st.isSymbolicLink() || !st.isDirectory() && !systemLink) {
        throw new Error("Refusing to write Muse file inside symlinked or non-directory parent");
      }
    } catch (err) {
      if (err?.code !== "ENOENT")
        throw err;
    }
  }
}
function validateEndpointUrl(raw, kind) {
  if (raw !== raw.trim() || /["<>\\\x00-\x20\x7f]/.test(raw)) {
    throw new Error(`Invalid Muse ${kind} URL`);
  }
  const trimmed = raw;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Muse ${kind} URL`);
  }
  if (isUnsafeEndpointHost(parsed.hostname)) {
    throw new Error(`Unsafe Muse ${kind} URL host`);
  }
  if (parsed.port === "0" || parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")) {
    throw new Error(`Invalid Muse ${kind} URL port/query/hash`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Embedded credentials are not allowed in Muse ${kind} URL`);
  }
  if (kind === "ws") {
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new Error(`Invalid Muse ws URL protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === "ws:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("Remote Muse ws URL must use wss://");
    }
  } else {
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Invalid Muse rest URL protocol: ${parsed.protocol}`);
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error("Remote Muse rest URL must use https://");
    }
  }
  return trimmed;
}
function redact(value) {
  if (!value)
    return "(missing)";
  if (value.length <= 4)
    return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

// muse/src/wake.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync as lstatSync2, mkdirSync, readFileSync as readFileSync2, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
var WAKE_SIG_HEADER = "x-agentschat-signature";
var WAKE_CONTENT_MAX = 500;
function redactSecrets(text) {
  return text.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g, "[redacted]").replace(/\b(?:Bearer|Basic)\s+[^\s"'<>\\]+/gi, "[redacted]").replace(/(?:ac_|agent_key_|mcp_(?:at|rt|code)_|sk-|sk_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|whsec_|AIza)[A-Za-z0-9_-]+/g, "[redacted]").replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]").replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}
function sanitizeMuseText(text) {
  return redactSecrets(redactSecrets(text).replace(/[\x00-\x1f\x7f]/g, ""));
}
function buildWakePayload(msg, opts = {}) {
  const clean = (value, cap = 128) => typeof value === "string" ? sanitizeMuseText(value).slice(0, cap) : undefined;
  const targetSessionId = clean(opts.targetSessionId);
  return {
    type: clean(msg.type, 64) ?? "message",
    channel_id: clean(msg.channel_id),
    message_id: clean(msg.id, 256),
    sender_id: clean(msg.sender_id),
    content: clean(msg.content, WAKE_CONTENT_MAX),
    mentioned_ids: Array.isArray(msg.mentioned_ids) ? msg.mentioned_ids.filter((x) => typeof x === "string").slice(0, 256).map((x) => clean(x)) : undefined,
    timestamp: clean(msg.timestamp, 64),
    ...targetSessionId ? { target_session_id: targetSessionId } : {}
  };
}
function sanitizeWakeLogUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return redactSecrets(rawUrl.split(/[?#]/)[0] ?? "[invalid-url]");
  }
}
function signWakeBody(body, secret) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}
function isUnsafeWakeHost(hostname) {
  if (isUnsafeEndpointHost(hostname))
    return true;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (["metadata.google.internal", "metadata.goog"].includes(host))
    return true;
  const unsafeV4 = (ip) => {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
    return unsafeV4(host);
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    const [left, right = ""] = address.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const words = address.includes("::") ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail].map((x) => parseInt(x, 16)) : head.map((x) => parseInt(x, 16));
    if (words.length !== 8)
      return true;
    const mapped = words.slice(0, 5).every((x) => x === 0) && words[5] === 65535 || words.slice(0, 4).every((x) => x === 0) && words[4] === 65535 && words[5] === 0;
    if (mapped)
      return unsafeV4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
    return words.every((x) => x === 0) || (words[0] & 65472) === 65152 || (words[0] & 65024) === 64512 || (words[0] & 65280) === 65280;
  }
  return false;
}
async function fireWake(msg, cfg) {
  const log = (text) => cfg.logger?.(sanitizeMuseText(text));
  const url = (cfg.url ?? "").trim();
  if (!url)
    return;
  const safeLogUrl = sanitizeWakeLogUrl(url);
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    log(`[muse-agentchat] wake POST rejected invalid URL: ${safeLogUrl}`);
    return;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    log(`[muse-agentchat] wake POST rejected unsupported protocol: ${parsedUrl.protocol}`);
    return;
  }
  if (parsedUrl.port === "0" || parsedUrl.username || parsedUrl.password || isUnsafeWakeHost(parsedUrl.hostname)) {
    log(`[muse-agentchat] wake POST rejected unsafe URL: ${safeLogUrl}`);
    return;
  }
  const timeoutMs = typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs >= 1 ? Math.min(cfg.timeoutMs, 60000) : 5000;
  const payload = buildWakePayload(msg, { targetSessionId: cfg.targetSessionId });
  if (!payload.timestamp)
    payload.timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (cfg.secret)
    headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);
  const doPost = async () => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController;
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await f(url, { method: "POST", headers, body, redirect: "error", signal: ctrl.signal });
      try {
        await res?.body?.cancel?.();
      } catch {}
      if (!res.ok)
        log(`[muse-agentchat] wake POST ${safeLogUrl} → HTTP ${res.status}`);
    } finally {
      clearTimeout(t);
    }
  };
  try {
    await doPost();
  } catch (e) {
    try {
      await doPost();
    } catch (e2) {
      log(`[muse-agentchat] wake POST ${safeLogUrl} failed: ${redactSecrets(String(e2))}`);
    }
  }
}
var MAX_WAKE_QUEUE_LINES = 500;
var MAX_WAKE_QUEUE_BYTES = 16 * 1024 * 1024;
var wakeTmpSeq = 0;
function appendWakeQueue(queueFile, payload, maxLines = MAX_WAKE_QUEUE_LINES) {
  const dir = dirname2(queueFile);
  assertSafeParentDirectories(queueFile);
  mkdirSync(dir, { recursive: true, mode: 448 });
  assertSafeParentDirectories(queueFile);
  const line = JSON.stringify(payload);
  let existingLines = [];
  let existedBefore = false;
  try {
    const st = lstatSync2(queueFile);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
    }
    if (st.size > MAX_WAKE_QUEUE_BYTES) {
      throw new Error("Muse wake queue exceeds maximum size limit");
    }
    existedBefore = true;
  } catch (err) {
    if (err?.code !== "ENOENT")
      throw err;
  }
  if (existedBefore) {
    const existing = readFileSync2(queueFile, "utf8");
    existingLines = existing.split(`
`).filter((l) => l.length > 0);
    if (payload.message_id && existingLines.some((l) => {
      try {
        return JSON.parse(l).message_id === payload.message_id;
      } catch {
        return false;
      }
    })) {
      return false;
    }
  }
  const cap = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : MAX_WAKE_QUEUE_LINES;
  if (existingLines.length >= cap) {
    const kept = [...cap === 1 ? [] : existingLines.slice(-(cap - 1)), line];
    const tmp = `${queueFile}.${process.pid}.${Date.now()}.${++wakeTmpSeq}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      assertSafeParentDirectories(queueFile);
      writeFileSync(tmp, `${kept.join(`
`)}
`, { mode: 384, flag: "wx" });
      try {
        const st = lstatSync2(queueFile);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
        }
      } catch (err) {
        if (err?.code !== "ENOENT")
          throw err;
      }
      renameSync(tmp, queueFile);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
    return true;
  }
  if (!existedBefore) {
    try {
      writeFileSync(queueFile, `${line}
`, { mode: 384, flag: "wx" });
      if (process.platform !== "win32") {
        try {
          chmodSync(queueFile, 384);
        } catch {}
      }
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST")
        throw err;
      const st = lstatSync2(queueFile);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
      }
      if (st.size > MAX_WAKE_QUEUE_BYTES) {
        throw new Error("Muse wake queue exceeds maximum size limit");
      }
    }
  }
  assertSafeParentDirectories(queueFile);
  const finalTarget = lstatSync2(queueFile);
  if (finalTarget.isSymbolicLink() || !finalTarget.isFile()) {
    throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
  }
  appendFileSync(queueFile, `${line}
`, { mode: 384 });
  return true;
}

// src/reconnect.ts
function safeUnitRand(rand) {
  let r;
  try {
    r = rand();
  } catch {
    return 0;
  }
  if (!Number.isFinite(r) || r <= 0)
    return 0;
  return r >= 1 ? 0.999999 : r;
}
function computePleaseReconnectDelay(jitterMs, rand = Math.random) {
  const maxJitter = typeof jitterMs === "number" && Number.isFinite(jitterMs) && jitterMs > 0 ? Math.min(Math.floor(jitterMs), 1e4) : 2000;
  return 200 + Math.floor(safeUnitRand(rand) * maxJitter);
}
function resolveDrainReconnectDelay(frame, rand = Math.random) {
  const safeFrame = frame && typeof frame === "object" && !Array.isArray(frame) && !Object.prototype.hasOwnProperty.call(frame, "__proto__") ? frame : null;
  return computePleaseReconnectDelay(safeFrame?.jitter_ms ?? safeFrame?.within_ms, rand);
}

// muse/src/client.ts
var MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
var MAX_JOINED_CHANNELS = 256;
function safeDelayMs(value, fallback, min = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min)
    return fallback;
  return Math.min(value, MAX_TIMER_DELAY_MS);
}
function normalizeChannelId(raw) {
  if (typeof raw !== "string")
    return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || /[\/\\\x00-\x20\x7f]/.test(trimmed) || [".", "..", "__proto__", "constructor", "prototype"].includes(trimmed.toLowerCase()))
    return null;
  return trimmed;
}

class MuseAgentChatClient {
  ws = null;
  sessionId = null;
  heartbeatTimer = null;
  reconnectTimer = null;
  connectTimer = null;
  nextReconnectDelayOverrideMs = null;
  messageHandlers = [];
  errorHandlers = [];
  joinedChannels = new Set;
  sessionJoined = new Set;
  connectResolve = null;
  connectReject = null;
  lifecycleResolve = null;
  explicitlyDisconnected = false;
  reconnectAttempt = 0;
  isReconnecting = false;
  connectSettled = false;
  url;
  agentId;
  token;
  capabilities;
  heartbeatIntervalMs;
  connectTimeoutMs;
  reconnect;
  initialReconnectDelayMs;
  maxReconnectDelayMs;
  onDebug;
  onReconnect;
  constructor(options) {
    this.url = validateEndpointUrl(options.url, "ws");
    this.agentId = options.agentId;
    this.token = options.token;
    this.capabilities = options.capabilities ?? ["chat"];
    this.heartbeatIntervalMs = safeDelayMs(options.heartbeatIntervalMs, 30000, 100);
    this.connectTimeoutMs = safeDelayMs(options.connectTimeoutMs, 15000, 0);
    this.reconnect = options.reconnect ?? true;
    this.initialReconnectDelayMs = safeDelayMs(options.initialReconnectDelayMs, 1000, 0);
    this.maxReconnectDelayMs = safeDelayMs(options.maxReconnectDelayMs, 60000, 0);
    this.onDebug = options.onDebug;
    this.onReconnect = options.onReconnect;
  }
  clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
  emitError(err) {
    for (const h of this.errorHandlers) {
      try {
        h(err);
      } catch {}
    }
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.clearConnectTimer();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      const prevWs = this.ws;
      this.ws = null;
      this.sessionId = null;
      this.sessionJoined.clear();
      if (prevWs) {
        try {
          prevWs.close();
        } catch {}
      }
      this.connectSettled = false;
      this.explicitlyDisconnected = false;
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket();
    });
  }
  waitUntilClosed() {
    if (!this.lifecycleResolve) {
      return new Promise((resolve) => {
        this.lifecycleResolve = resolve;
      });
    }
    return new Promise((resolve) => {
      const prev = this.lifecycleResolve;
      this.lifecycleResolve = () => {
        prev?.();
        resolve();
      };
    });
  }
  disconnect() {
    this.explicitlyDisconnected = true;
    this.clearConnectTimer();
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer)
      clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    if (!this.connectSettled) {
      this.connectSettled = true;
      this.connectReject?.(new Error("Disconnected before authentication completed"));
    }
    this.connectResolve = null;
    this.connectReject = null;
    this.lifecycleResolve?.();
    this.lifecycleResolve = null;
    const prev = this.ws;
    this.ws = null;
    this.sessionId = null;
    this.sessionJoined.clear();
    try {
      prev?.close();
    } catch {}
  }
  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }
  get session() {
    return this.sessionId;
  }
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }
  onError(handler) {
    this.errorHandlers.push(handler);
  }
  joinChannel(channelId) {
    const clean = normalizeChannelId(channelId);
    if (!clean)
      return;
    if (!this.joinedChannels.has(clean) && this.joinedChannels.size >= MAX_JOINED_CHANNELS)
      return;
    this.joinedChannels.add(clean);
    this.sessionJoined.add(clean);
    this.send({ type: "join_channel", channel_id: clean, agent_id: this.agentId });
  }
  leaveChannel(channelId) {
    const clean = normalizeChannelId(channelId);
    if (!clean)
      return;
    this.joinedChannels.delete(clean);
    this.sessionJoined.delete(clean);
    this.send({ type: "leave_channel", channel_id: clean, agent_id: this.agentId });
  }
  sendMessage(channelId, content, contentType = "text", replyTo) {
    const clean = normalizeChannelId(channelId);
    if (!clean || replyTo !== undefined && (typeof replyTo !== "string" || replyTo.length > 256 || /[\x00-\x1f\x7f]/.test(replyTo)))
      return;
    this.send({
      type: "message",
      id: crypto.randomUUID(),
      channel_id: clean,
      sender_id: this.agentId,
      sender_type: "agent",
      content,
      content_type: contentType,
      timestamp: new Date().toISOString(),
      ...replyTo ? { reply_to: replyTo } : {}
    });
  }
  sendTyping(channelId) {
    const clean = normalizeChannelId(channelId);
    if (!clean)
      return;
    this.send({ type: "typing", channel_id: clean, sender_id: this.agentId, cross_pod: true });
  }
  debug(event, meta) {
    this.onDebug?.(event, meta);
  }
  openSocket() {
    this.debug("connect:start", { url: this.url, agentId: this.agentId });
    this.clearConnectTimer();
    this.sessionJoined.clear();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    if (this.connectTimeoutMs > 0) {
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (this.ws !== ws)
          return;
        const err = new Error(`AgentsChat connect timed out after ${this.connectTimeoutMs}ms`);
        if (!this.connectSettled) {
          this.connectSettled = true;
          this.explicitlyDisconnected = true;
          try {
            ws.close();
          } catch {}
          this.connectReject?.(err);
          this.emitError(err);
        } else if (this.sessionId === null) {
          this.emitError(err);
          try {
            ws.close();
          } catch {}
        }
      }, this.connectTimeoutMs);
      this.connectTimer.unref?.();
    }
    ws.onopen = () => {
      if (this.ws !== ws)
        return;
      try {
        this.send({
          type: "auth",
          agent_id: this.agentId,
          token: this.token,
          capabilities: this.capabilities
        });
      } catch (err) {
        this.clearConnectTimer();
        if (!this.connectSettled) {
          this.connectSettled = true;
          this.connectReject?.(err instanceof Error ? err : new Error(String(err)));
        }
        this.emitError(err instanceof Error ? err : new Error(String(err)));
        try {
          ws.close();
        } catch {}
        return;
      }
      if (this.heartbeatTimer)
        clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.ws !== ws)
          return;
        if (ws.readyState === WebSocket.OPEN) {
          try {
            this.send({ type: "ping", timestamp: new Date().toISOString() });
          } catch (err) {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
            try {
              ws.close();
            } catch {}
          }
        }
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws)
        return;
      this.handleMessage(String(event.data));
    };
    ws.onerror = () => {
      if (this.ws !== ws)
        return;
      const err = new Error("WebSocket error");
      if (!this.connectSettled) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.emitError(err);
    };
    ws.onclose = () => {
      if (this.ws !== ws)
        return;
      this.clearConnectTimer();
      if (this.heartbeatTimer)
        clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.sessionId = null;
      this.sessionJoined.clear();
      if (!this.connectSettled && !this.reconnect) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(new Error("WebSocket closed before authentication"));
      }
      if (this.explicitlyDisconnected) {
        this.lifecycleResolve?.();
        return;
      }
      if (!this.reconnect) {
        this.lifecycleResolve?.();
        return;
      }
      let delay;
      if (this.nextReconnectDelayOverrideMs !== null) {
        delay = this.nextReconnectDelayOverrideMs;
        this.nextReconnectDelayOverrideMs = null;
      } else {
        const exp = Math.min(Math.max(0, this.reconnectAttempt), 30);
        delay = Math.min(this.initialReconnectDelayMs * 2 ** exp, this.maxReconnectDelayMs);
        this.reconnectAttempt += 1;
      }
      this.isReconnecting = true;
      this.debug("reconnect:scheduled", { delayMs: delay, attempt: this.reconnectAttempt });
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
      this.reconnectTimer.unref?.();
    };
  }
  send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("AgentsChat socket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }
  handleMessage(raw) {
    if (Buffer.byteLength(raw, "utf8") > 1048576)
      return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.hasOwn(parsed, "__proto__")) {
      return;
    }
    const msg = parsed;
    if (msg.type === "auth_ok") {
      this.clearConnectTimer();
      this.sessionId = typeof msg.session_id === "string" ? msg.session_id : null;
      this.reconnectAttempt = 0;
      const wasReconnect = this.isReconnecting;
      this.isReconnecting = false;
      if (!this.connectSettled) {
        this.connectSettled = true;
        this.connectResolve?.();
      } else if (wasReconnect) {
        this.onReconnect?.();
        for (const ch of this.joinedChannels) {
          if (!this.sessionJoined.has(ch) && this.ws?.readyState === WebSocket.OPEN) {
            this.joinChannel(ch);
          }
        }
      }
      return;
    }
    if (msg.type === "auth_error" || msg.type === "error") {
      const text = typeof msg.error === "string" ? msg.error : typeof msg.message === "string" ? msg.message : msg.type === "auth_error" ? "AgentsChat authentication error" : "AgentsChat error";
      const err = new Error(sanitizeMuseText(text).slice(0, 1024));
      if (msg.type === "auth_error") {
        this.explicitlyDisconnected = true;
        try {
          this.ws?.close();
        } catch {}
      }
      if (!this.connectSettled) {
        this.clearConnectTimer();
        this.connectSettled = true;
        this.connectReject?.(err);
      }
      this.emitError(err);
      return;
    }
    if (msg.type === "please_reconnect" || msg.type === "shard_moved") {
      this.nextReconnectDelayOverrideMs = resolveDrainReconnectDelay(msg);
      this.reconnectAttempt = 0;
      try {
        this.ws?.close();
      } catch {}
      return;
    }
    if (msg.type === "pong")
      return;
    if (msg.type === "channel_created" && typeof msg.channel_id === "string" && msg.channel_id) {
      if (this.ws?.readyState === WebSocket.OPEN)
        this.joinChannel(msg.channel_id);
      return;
    }
    if (msg.type === "message" || msg.type === "thread_reply") {
      if (msg.content === "__typing__")
        return;
      const chat = {
        id: String(msg.id ?? ""),
        channel_id: String(msg.channel_id ?? ""),
        sender_id: String(msg.sender_id ?? ""),
        sender_type: msg.sender_type ?? "agent",
        content: String(msg.content ?? ""),
        content_type: msg.content_type ?? "text",
        timestamp: String(msg.timestamp ?? new Date().toISOString()),
        channel_type: msg.channel_type,
        thread_id: typeof msg.thread_id === "string" ? msg.thread_id : typeof msg.parent_id === "string" ? msg.parent_id : undefined
      };
      for (const h of this.messageHandlers) {
        try {
          Promise.resolve(h(chat)).catch((err) => {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
          });
        } catch (err) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
}

// src/session-route.ts
import { lstatSync as lstatSync4, readFileSync as readFileSync4, readlinkSync as readlinkSync2, realpathSync as realpathSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, isAbsolute as isAbsolute3, join as join3, parse as parse2, resolve as resolve2, sep as sep2 } from "node:path";

// src/session-bind.ts
import { closeSync, lstatSync as lstatSync3, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, readSync, readdirSync, readlinkSync, realpathSync as realpathSync2, statSync, unlinkSync as unlinkSync2 } from "node:fs";
import { isAbsolute as isAbsolute2, join as join2, parse, resolve } from "node:path";

// src/profile-store.ts
var MAX_PROFILE_JSON_BYTES = 64 * 1024;
var DARWIN_SYSTEM_SYMLINKS = new Set(["/var", "/tmp", "/etc"]);
var NON_PROFILE_JSON_FILES = new Set([
  "session-binds.json",
  "session-binds.meta.json",
  "agy-session-binds.json",
  "agy-binds.json",
  "agy-binds.meta.json",
  "grok-binds.json",
  "grok-binds-meta.json",
  "grok-binds.meta.json",
  "identity-guard.json",
  "cursor.json",
  "read-cursors.json",
  "mention-timestamps.json",
  "wake-pids.json",
  "dsh.json",
  "config.json",
  "muse.json"
]);

// src/session-bind.ts
var DEFAULT_SESSION_BINDS_FILENAME = "session-binds.json";
var LEGACY_AGY_BINDS_FILENAME = "agy-binds.json";
var LOCK_FILE_MAX_BYTES = 64 * 1024;
var SESSION_BINDS_MAX_BYTES = 1024 * 1024;
var MAX_SESSION_BINDS_ENTRIES = 1024;
var CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
var RESERVED_BIND_SIDECARS = new Set([
  "session-binds",
  "session-binds.meta",
  "session-binds_meta",
  "agy-binds",
  "agy-binds.meta",
  "agy-binds_meta",
  "grok-binds",
  "grok-binds.meta",
  "grok-binds_meta",
  "agy-session-binds",
  "identity-guard",
  "cursor",
  "read-cursors",
  "mention-timestamps",
  "wake-pids",
  "config",
  "codex-bots",
  "dsh",
  "muse"
]);
function readBoundedRegularJson(path, maxBytes) {
  try {
    const st = lstatSync3(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes)
      return null;
    const parsed = JSON.parse(readFileSync3(path, "utf8"));
    if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function isAllowedDarwinSystemLink(dirPath) {
  if (process.platform !== "darwin")
    return false;
  if (dirPath !== "/var" && dirPath !== "/tmp" && dirPath !== "/etc")
    return false;
  try {
    const expected = `/private${dirPath}`;
    return readlinkSync(dirPath) === `private${dirPath}` && realpathSync2(dirPath) === expected && !lstatSync3("/private").isSymbolicLink() && lstatSync3("/private").isDirectory() && !lstatSync3(expected).isSymbolicLink() && statSync(expected).isDirectory();
  } catch {
    return false;
  }
}
function hasSafeRawDotDotSegments(rawPath) {
  if (!rawPath.includes(".."))
    return true;
  const baseAbs = isAbsolute2(rawPath) ? rawPath : `${process.cwd()}/${rawPath}`;
  const root = parse(baseAbs).root;
  const rawParts = baseAbs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (const part of rawParts) {
    if (part === ".")
      continue;
    if (part === "..") {
      cur = resolve(cur, "..");
      continue;
    }
    cur = join2(cur, part);
    try {
      const st = lstatSync3(cur);
      if (st.isSymbolicLink()) {
        if (isAllowedDarwinSystemLink(cur))
          continue;
        return false;
      }
      if (!st.isDirectory())
        return false;
    } catch (e) {
      if (e && typeof e === "object" && e.code === "ENOENT")
        continue;
      return false;
    }
  }
  return true;
}
function isSafeDirOrMissing(dirPath) {
  if (!dirPath || CONTROL_CHAR_RE.test(dirPath))
    return false;
  if (!hasSafeRawDotDotSegments(dirPath))
    return false;
  const abs = resolve(dirPath);
  const root = parse(abs).root;
  const segments = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (let i = 0;i < segments.length; i++) {
    cur = join2(cur, segments[i]);
    try {
      const st = lstatSync3(cur);
      if (st.isSymbolicLink()) {
        if (isAllowedDarwinSystemLink(cur))
          continue;
        return false;
      }
      if (!st.isDirectory())
        return false;
    } catch (e) {
      if (e && typeof e === "object" && e.code === "ENOENT")
        return true;
      return false;
    }
  }
  return true;
}
function isValidBindToken(value) {
  return value.length > 0 && value.length <= 256 && !CONTROL_CHAR_RE.test(value);
}
function isValidBoundProfileName(value) {
  if (!isValidBindToken(value) || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    return false;
  }
  const stem = value.replace(/\.json$/i, "").toLowerCase();
  const normalizedStem = stem.replace(/[^a-z0-9_-]/g, "_");
  return Boolean(stem) && !isUnsafeBindKey(value) && !isUnsafeBindKey(stem) && !RESERVED_BIND_SIDECARS.has(stem) && !RESERVED_BIND_SIDECARS.has(normalizedStem);
}
function isUnsafeBindKey(key) {
  const lower = key.toLowerCase();
  return lower === "__proto__" || lower === "constructor" || lower === "prototype";
}
function parseSessionBinds(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {};
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (count >= MAX_SESSION_BINDS_ENTRIES)
      break;
    const key = k.trim();
    if (!isValidBindToken(key) || key === "." || key === ".." || isUnsafeBindKey(key))
      continue;
    if (typeof v === "string") {
      const val = v.trim();
      if (isValidBoundProfileName(val)) {
        out[key] = val;
        count += 1;
      }
    } else if (v && typeof v === "object" && typeof v.profile === "string") {
      const val = v.profile.trim();
      if (isValidBoundProfileName(val)) {
        out[key] = val;
        count += 1;
      }
    }
  }
  return out;
}
function loadSessionBinds(configDir) {
  if (!isSafeDirOrMissing(configDir))
    return {};
  const merged = {};
  for (const filename of [LEGACY_AGY_BINDS_FILENAME, DEFAULT_SESSION_BINDS_FILENAME]) {
    const path = join2(configDir, filename);
    const parsed = readBoundedRegularJson(path, SESSION_BINDS_MAX_BYTES);
    if (parsed !== null) {
      Object.assign(merged, parseSessionBinds(parsed));
    }
  }
  return merged;
}
var DSH_HEALTH_MAX_BYTES = 256 * 1024;

// src/session-route.ts
var MAX_PROFILE_BYTES2 = 64 * 1024;
var MAX_DIR_PATH_LENGTH = 4096;
var MAX_SESSION_ID_LENGTH = 256;
var RESERVED_PROFILE_KEY = /^(?:__proto__|constructor|prototype)$/i;
var RESERVED_ROUTE_SIDECARS = new Set([
  "profile",
  "session-binds",
  "session-binds_meta",
  "session-binds-meta",
  "agy-binds",
  "agy-binds_meta",
  "agy-binds-meta",
  "agy-session-binds",
  "agy-session-binds_meta",
  "grok-binds",
  "grok-binds_meta",
  "grok-binds-meta",
  "identity-guard",
  "cursor",
  "read-cursors",
  "mention-timestamps",
  "wake-pids",
  "config",
  "codex-bots",
  "dsh",
  "muse"
]);
function isSafeAbsoluteDirEnv(raw) {
  if (typeof raw !== "string")
    return false;
  const s = raw.trim();
  return s.length > 0 && s.length <= MAX_DIR_PATH_LENGTH && !s.startsWith("-") && !/[\x00-\x1f\x7f]/.test(s) && isAbsolute3(s);
}
function agentschatConfigDir(env = process.env) {
  if (isSafeAbsoluteDirEnv(env.AGENTSCHAT_CONFIG_DIR)) {
    return env.AGENTSCHAT_CONFIG_DIR.trim();
  }
  const homeCandidate = env.HOME || env.USERPROFILE || "";
  const home = isSafeAbsoluteDirEnv(homeCandidate) ? homeCandidate.trim() : homedir2();
  return join3(home, ".agentschat");
}
function isSafeAgentId(id) {
  return id.length > 0 && id.length <= 128 && id !== "." && id !== ".." && !RESERVED_PROFILE_KEY.test(id) && !/[/\\\s\x00-\x1f\x7f]/.test(id);
}
function isSafeRegularProfileFile(path) {
  try {
    const st = lstatSync4(path);
    return !st.isSymbolicLink() && st.isFile() && st.size <= MAX_PROFILE_BYTES2;
  } catch {
    return false;
  }
}
function isSafeSessionId(sessionId) {
  return sessionId.length > 0 && sessionId.length <= MAX_SESSION_ID_LENGTH && sessionId !== "." && sessionId !== ".." && !RESERVED_PROFILE_KEY.test(sessionId) && !/[\x00-\x1f\x7f]/.test(sessionId);
}
function isAllowedDarwinSystemLink2(dirPath) {
  if (process.platform !== "darwin")
    return false;
  if (dirPath !== "/var" && dirPath !== "/tmp" && dirPath !== "/etc")
    return false;
  try {
    return readlinkSync2(dirPath) === `private${dirPath}` && realpathSync3(dirPath) === `/private${dirPath}` && !lstatSync4("/private").isSymbolicLink() && lstatSync4("/private").isDirectory() && !lstatSync4(`/private${dirPath}`).isSymbolicLink() && lstatSync4(`/private${dirPath}`).isDirectory();
  } catch {
    return false;
  }
}
function hasSafeRawDotDotSegments2(rawPath) {
  const absRaw = isAbsolute3(rawPath) ? rawPath : `${process.cwd()}${sep2}${rawPath}`;
  const root = parse2(absRaw).root;
  const segments = absRaw.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (!segments.includes(".."))
    return true;
  let cur = root;
  for (const seg of segments) {
    if (seg === ".")
      continue;
    if (seg === "..") {
      cur = dirname3(cur);
      continue;
    }
    const next = join3(cur, seg);
    try {
      const st = lstatSync4(next);
      if (st.isSymbolicLink() && !isAllowedDarwinSystemLink2(next)) {
        return false;
      }
    } catch (err) {
      if (err?.code !== "ENOENT")
        return false;
    }
    cur = next;
  }
  return true;
}
function isSafeRealDir(path) {
  try {
    if (!path || /[\x00-\x1f\x7f]/.test(path) || !hasSafeRawDotDotSegments2(path)) {
      return false;
    }
    const st = lstatSync4(path);
    if (st.isSymbolicLink() || !st.isDirectory())
      return false;
    const abs = resolve2(path);
    const root = parse2(abs).root;
    const segments = abs.slice(root.length).split(/[\\/]+/).filter(Boolean);
    let cur = root;
    for (let i = 0;i < segments.length; i++) {
      cur = join3(cur, segments[i]);
      const anc = lstatSync4(cur);
      if (anc.isSymbolicLink()) {
        if (isAllowedDarwinSystemLink2(cur))
          continue;
        return false;
      }
      if (!anc.isDirectory())
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
function profilePathForName(configDir, name) {
  if (typeof name !== "string" || !name || name.length > 133 || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name) || !isSafeRealDir(configDir)) {
    return;
  }
  const base = name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!base || base.length > 128 || RESERVED_PROFILE_KEY.test(base) || RESERVED_ROUTE_SIDECARS.has(base.toLowerCase())) {
    return;
  }
  const profilesDir = join3(configDir, "profiles");
  if (isSafeRealDir(profilesDir)) {
    const nested = join3(profilesDir, `${base}.json`);
    if (isSafeRegularProfileFile(nested))
      return nested;
  }
  const flat = join3(configDir, `${base}.json`);
  return isSafeRegularProfileFile(flat) ? flat : undefined;
}
function readAgentId(path) {
  try {
    if (!isSafeRegularProfileFile(path))
      return;
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
      return;
    }
    const id = typeof parsed.agent_id === "string" ? parsed.agent_id.trim() : "";
    return isSafeAgentId(id) ? id : undefined;
  } catch {
    return;
  }
}
function resolveSessionForAgent(agentId, opts = {}) {
  const targetAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!isSafeAgentId(targetAgentId))
    return;
  const configDir = opts.configDir ?? agentschatConfigDir(opts.env);
  let binds;
  try {
    binds = loadSessionBinds(configDir);
  } catch {
    return;
  }
  for (const [sessionId, profileName] of Object.entries(binds).reverse()) {
    if (!isSafeSessionId(sessionId))
      continue;
    if (opts.filter && !opts.filter(sessionId))
      continue;
    const path = profilePathForName(configDir, profileName);
    if (path === undefined)
      continue;
    if (readAgentId(path) !== targetAgentId)
      continue;
    return { sessionId, profileName, agentId: targetAgentId };
  }
  return;
}

// src/wake.ts
import { existsSync as existsSync2, lstatSync as lstatSync5, readFileSync as readFileSync5, readlinkSync as readlinkSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname4, isAbsolute as isAbsolute4, join as join4, parse as parse3, resolve as resolve3, win32 as pathWin32 } from "node:path";
var GROK_GATEWAY_PATH_CANDIDATES = [
  join4(process.env.HOME || process.env.USERPROFILE || homedir3(), ".grok", "gateway.json"),
  "/home/box/sand-data/gateway.json"
];
var zcodeSessionQueues = new Map;
function resolveWindowsCliSpawn(cmd, args, opts) {
  const platform = opts?.platform ?? process.platform;
  const trimmed = (cmd || "").trim();
  if (!trimmed)
    return { cmd, args };
  const execPath = opts?.execPath ?? process.execPath;
  if (/\.(?:cjs|mjs|js)$/i.test(trimmed)) {
    return { cmd: execPath, args: [trimmed, ...args] };
  }
  if (platform !== "win32") {
    return { cmd: trimmed, args };
  }
  const env = opts?.env ?? process.env;
  const exists = opts?.existsImpl ?? existsSync2;
  const readText = opts?.readTextImpl ?? ((p) => readFileSync5(p, "utf8"));
  const hasSep = /[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed);
  const hasWinExt = /\.(?:exe|cmd|bat)$/i.test(trimmed);
  const candidates = [];
  if (hasSep) {
    if (hasWinExt) {
      candidates.push(trimmed);
    } else {
      candidates.push(`${trimmed}.exe`, `${trimmed}.cmd`, trimmed);
    }
  } else {
    const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
    for (const rawDir of rawPath.split(";")) {
      const dir = rawDir.trim().replace(/^"+|"+$/g, "");
      if (!dir)
        continue;
      if (hasWinExt) {
        candidates.push(pathWin32.join(dir, trimmed));
      } else {
        candidates.push(pathWin32.join(dir, `${trimmed}.exe`), pathWin32.join(dir, `${trimmed}.cmd`));
      }
    }
  }
  for (const candidate of candidates) {
    if (!exists(candidate))
      continue;
    if (/\.exe$/i.test(candidate)) {
      return { cmd: candidate, args };
    }
    if (/\.(?:cmd|bat)$/i.test(candidate)) {
      try {
        const content = readText(candidate);
        const m = content.match(/%(?:~)?dp0%?[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))/i);
        if (m && m[1]) {
          const cmdDir = pathWin32.dirname(candidate);
          const scriptPath = pathWin32.resolve(cmdDir, m[1].replace(/\//g, "\\"));
          if (exists(scriptPath)) {
            const bundledNode = pathWin32.join(cmdDir, "node.exe");
            const runner = exists(bundledNode) ? bundledNode : execPath;
            return { cmd: runner, args: [scriptPath, ...args] };
          }
        }
      } catch {}
      return { cmd: candidate, args };
    }
    return { cmd: candidate, args };
  }
  return { cmd: trimmed, args };
}

// dsh/src/patch.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { chmodSync as chmodSync2, copyFileSync, lstatSync as lstatSync6, mkdirSync as mkdirSync3, readFileSync as readFileSync6, realpathSync as realpathSync4, renameSync as renameSync2, statSync as statSync2, unlinkSync as unlinkSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname5, isAbsolute as isAbsolute5, join as join5, resolve as resolve4 } from "node:path";
import { homedir as homedir4 } from "node:os";
var FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
var DARWIN_ROOT_LINKS = new Set(["/var", "/tmp", "/etc"]);
function isAllowedDarwinSystemLink3(dirPath) {
  if (process.platform !== "darwin" || !DARWIN_ROOT_LINKS.has(dirPath))
    return false;
  try {
    const real = realpathSync4(dirPath);
    return real === `/private${dirPath}` && statSync2(real).isDirectory();
  } catch {
    return false;
  }
}
function checkRawDotDotAncestors(rawPath) {
  const trimmed = rawPath.trim();
  if (!trimmed || !isAbsolute5(trimmed))
    return;
  const normalizedSep = process.platform === "win32" ? trimmed.replace(/\//g, "\\") : trimmed;
  const sepChar = process.platform === "win32" ? "\\" : "/";
  const parts = normalizedSep.split(sepChar);
  if (!parts.includes(".."))
    return;
  const winDrive = process.platform === "win32" && /^[A-Za-z]:$/.test(parts[0] || "");
  let current = winDrive ? `${parts[0]}\\` : sepChar;
  for (let i = 1;i < parts.length; i++) {
    const seg = parts[i];
    if (!seg || seg === ".")
      continue;
    if (seg === "..") {
      current = dirname5(current);
      continue;
    }
    const candidate = current.endsWith(sepChar) ? `${current}${seg}` : `${current}${sepChar}${seg}`;
    if (i < parts.length - 1 || parts.slice(i + 1).includes("..")) {
      if (!isAllowedDarwinSystemLink3(candidate)) {
        try {
          const stat = lstatSync6(candidate);
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error(`Refusing symlinked or non-directory parent: ${candidate}`);
          }
        } catch (err) {
          if (err?.code !== "ENOENT")
            throw err;
        }
      }
    }
    current = candidate;
  }
}
function checkParentDirectory(path) {
  checkRawDotDotAncestors(path);
  let parent = dirname5(resolve4(path));
  for (;; ) {
    if (!isAllowedDarwinSystemLink3(parent)) {
      try {
        const stat = lstatSync6(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Refusing symlinked or non-directory parent: ${parent}`);
        }
      } catch (err) {
        if (err?.code !== "ENOENT")
          throw err;
      }
    }
    const next = dirname5(parent);
    if (next === parent)
      break;
    parent = next;
  }
}
function isBlockedNormalizedHost(host) {
  if (!host)
    return true;
  if (host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "100.100.100.200" || host === "fd00:ec2::254" || host === "fd00:ec2:0:0:0:0:0:254" || host === "metadata" || host === "instance-data" || host === "metadata.google.internal" || host.endsWith(".metadata.google.internal") || host === "metadata.goog" || host.endsWith(".metadata.goog") || /^169\.254\./.test(host)) {
    return true;
  }
  if (/^::ffff:(?:0:)?(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3}|6464:64c8|100\.100\.100\.200|0:0|0\.0\.0\.0)$/.test(host) || /^(?:0:){5}ffff:(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3}|6464:64c8|100\.100\.100\.200|0:0|0\.0\.0\.0)$/.test(host)) {
    return true;
  }
  const first = host.split(":")[0];
  return host.includes(":") && /^[0-9a-f]{1,4}$/.test(first) && (parseInt(first, 16) & 65472) === 65152;
}
function isBlockedDshHost(hostname) {
  const raw = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (isBlockedNormalizedHost(raw))
    return true;
  try {
    const bracketed = raw.includes(":") ? `[${raw}]` : raw;
    const canonical = new URL(`http://${bracketed}`).hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
    if (canonical && canonical !== raw && isBlockedNormalizedHost(canonical))
      return true;
  } catch {}
  return false;
}
function resolveDshPatchPath(opts = {}) {
  const home = opts.dshHome ?? process.env.DSH_HOME ?? join5(homedir4(), ".dsh");
  if (!home || home.length > 4096 || home.startsWith("-") || !isAbsolute5(home) || /[\x00-\x1f\x7f]/.test(home)) {
    throw new Error("Invalid DSH home path");
  }
  if (opts.dshProfile !== undefined) {
    const profile = opts.dshProfile.trim();
    if (!profile || profile.length > 64 || !/^[A-Za-z0-9._-]+$/.test(profile) || profile === "." || profile.includes("..") || FORBIDDEN_KEYS.has(profile.toLowerCase())) {
      throw new Error("Invalid DSH profile name");
    }
    return join5(home, "profiles", profile, "cordis.patch.yml");
  }
  return join5(home, "cordis.patch.yml");
}
function buildMcpAgentsChatArgs(opts = {}) {
  const pkg = (opts.packageSpec ?? "agentschat-mcp@latest").trim();
  if (!pkg || pkg.startsWith("-") || /[\x00-\x20\x7f]/.test(pkg)) {
    throw new Error("Invalid packageSpec");
  }
  const args = ["-y", pkg];
  if (opts.agentsChatProfile !== undefined && opts.agentsChatProfile !== "") {
    const profile = opts.agentsChatProfile.trim();
    if (!profile || profile.length > 64 || profile.startsWith("-") || profile.includes("..") || profile.includes("/") || profile.includes("\\") || FORBIDDEN_KEYS.has(profile.toLowerCase()) || /[\x00-\x1f\x7f]/.test(profile)) {
      throw new Error("Invalid AgentsChat profile name");
    }
    args.push("--profile", profile);
  }
  if (opts.apiUrl !== undefined && opts.apiUrl !== "") {
    const rawUrl = opts.apiUrl.trim();
    if (!rawUrl || rawUrl.startsWith("-") || /[\x00-\x20\x7f]/.test(rawUrl)) {
      throw new Error("Invalid AgentsChat API URL");
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("Invalid AgentsChat API URL");
    }
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    if (isBlockedDshHost(parsed.hostname) || parsed.username || parsed.password || parsed.port === "0" || parsed.search || parsed.hash || parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
      throw new Error("Invalid AgentsChat API URL");
    }
    args.push("--url", rawUrl);
  }
  return args;
}
function yamlQuote(val) {
  if (/^[A-Za-z0-9._/@:-]+$/.test(val))
    return `'${val}'`;
  return JSON.stringify(val);
}
function renderMcpAgentsChatEntry(indent, opts = {}) {
  const args = buildMcpAgentsChatArgs(opts);
  const lines = [
    `${indent}- id: mcp-agentschat`,
    `${indent}  name: '@deepseek-ai/dsh-mcp-client'`,
    `${indent}  config:`,
    `${indent}    serverName: agentschat`,
    `${indent}    transport: stdio`,
    `${indent}    command: npx`,
    `${indent}    args:`,
    ...args.map((a) => `${indent}      - ${yamlQuote(a)}`)
  ];
  return lines.join(`
`);
}
function mergeDshCordisPatch(existingContent, opts = {}) {
  if (/(?:^|\n)\s*-\s*id:\s*['"]?mcp-agentschat['"]?(?:\s|$)/m.test(existingContent)) {
    return { content: existingContent, changed: false };
  }
  const trimmed = existingContent.trim();
  const withoutComments = existingContent.split(`
`).filter((line) => !/^\s*#/.test(line)).join(`
`).trim();
  if (!trimmed || withoutComments === "" || withoutComments === "[]") {
    const commentLines = existingContent.split(`
`).filter((line) => /^\s*#/.test(line));
    const prefix = commentLines.length > 0 ? `${commentLines.join(`
`)}
` : "";
    const block2 = `- insert:
${renderMcpAgentsChatEntry("    ", opts)}
`;
    return { content: `${prefix}${block2}`, changed: true };
  }
  const normalizedLines = existingContent.replace(/\r\n/g, `
`).split(`
`);
  const insertLineIdx = normalizedLines.findIndex((line) => /^-\s*insert:\s*(?:#.*)?$/.test(line));
  if (insertLineIdx >= 0) {
    let detectedIndent = null;
    let lastBodyLineIdx = insertLineIdx;
    for (let i = insertLineIdx + 1;i < normalizedLines.length; i++) {
      const line = normalizedLines[i];
      if (/^\s*$/.test(line) || /^\s*#/.test(line))
        continue;
      if (/^\S/.test(line))
        break;
      const itemMatch = line.match(/^([ \t]+)-\s+/);
      if (itemMatch && detectedIndent === null) {
        detectedIndent = itemMatch[1];
      }
      lastBodyLineIdx = i;
    }
    const entryLines = renderMcpAgentsChatEntry(detectedIndent ?? "    ", opts).split(`
`);
    normalizedLines.splice(lastBodyLineIdx + 1, 0, ...entryLines);
    const merged = normalizedLines.join(`
`);
    return {
      content: merged.endsWith(`
`) ? merged : `${merged}
`,
      changed: true
    };
  }
  const normalized = existingContent.endsWith(`
`) ? existingContent : `${existingContent}
`;
  const block = `- insert:
${renderMcpAgentsChatEntry("    ", opts)}
`;
  return {
    content: `${normalized}${block}`,
    changed: true
  };
}
function applyDshCordisPatchFile(opts = {}) {
  const rawHome = opts.dshHome ?? process.env.DSH_HOME;
  if (rawHome) {
    checkRawDotDotAncestors(`${rawHome}/_`);
  }
  const patchPath = resolveDshPatchPath(opts);
  checkParentDirectory(patchPath);
  let existed = false;
  let mode = 384;
  try {
    const lst = lstatSync6(patchPath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error(`Refusing to modify non-regular or symlinked DSH patch file: ${patchPath}`);
    }
    if (lst.size > 1048576) {
      throw new Error(`Refusing to modify oversized DSH patch file (>1MiB): ${patchPath}`);
    }
    existed = true;
    mode = lst.mode & 511;
  } catch (err) {
    if (err?.code !== "ENOENT")
      throw err;
  }
  const existing = existed ? readFileSync6(patchPath, "utf8") : "";
  const { content, changed } = mergeDshCordisPatch(existing, opts);
  if (changed) {
    mkdirSync3(dirname5(patchPath), { recursive: true });
    checkParentDirectory(patchPath);
    const tmp = `${patchPath}.${process.pid}.${randomBytes2(4).toString("hex")}.tmp`;
    let created = false;
    try {
      writeFileSync2(tmp, content, { encoding: "utf8", mode, flag: "wx" });
      created = true;
      checkParentDirectory(patchPath);
      try {
        const cur = lstatSync6(patchPath);
        if (cur.isSymbolicLink() || !cur.isFile()) {
          throw new Error(`Refusing to overwrite symlinked or non-regular DSH patch file: ${patchPath}`);
        }
      } catch (err) {
        if (err?.code !== "ENOENT")
          throw err;
      }
      const doRename = opts.fsOps?.renameSync ?? renameSync2;
      const doCopy = opts.fsOps?.copyFileSync ?? copyFileSync;
      try {
        doRename(tmp, patchPath);
      } catch (renameErr) {
        if (renameErr?.code !== "EPERM" && renameErr?.code !== "EACCES") {
          throw renameErr;
        }
        checkParentDirectory(patchPath);
        try {
          const cur = lstatSync6(patchPath);
          if (cur.isSymbolicLink() || !cur.isFile()) {
            throw new Error(`Refusing to overwrite symlinked or non-regular DSH patch file: ${patchPath}`);
          }
        } catch (err) {
          if (err?.code !== "ENOENT")
            throw err;
        }
        doCopy(tmp, patchPath);
        try {
          unlinkSync3(tmp);
        } catch {}
        created = false;
      }
      if (process.platform !== "win32") {
        try {
          chmodSync2(patchPath, mode);
        } catch {}
      }
    } catch (err) {
      try {
        if (created)
          unlinkSync3(tmp);
      } catch {}
      throw err;
    }
  }
  return { patchPath, changed };
}

// dsh/src/cli.ts
var DSH_PROFILE_PATH = join6(homedir5(), ".agentschat", "dsh.json");
var DEFAULT_WS_URL = "wss://agents-chat.com/ws";
var DEFAULT_REST_URL = "https://agents-chat.com";
function arg(name, argv) {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value?.startsWith("--") ? undefined : value;
}
function has(name, argv) {
  return argv.includes(name);
}
var FORBIDDEN_KEYS2 = new Set(["__proto__", "constructor", "prototype"]);
var RESERVED_DSH_PROFILE_BASENAMES = new Set([
  "profile",
  "session-binds",
  "session-binds_meta",
  "agy-binds",
  "agy-binds_meta",
  "grok-binds",
  "grok-binds_meta",
  "agy-session-binds",
  "identity-guard",
  "cursor",
  "read-cursors",
  "mention-timestamps",
  "wake-pids",
  "config",
  "codex-bots",
  "dsh",
  "muse"
]);
async function readRegistrationText(res) {
  if (!res.body)
    throw new Error("Empty registration response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024)
        throw new Error("Registration response exceeds 1MiB");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function isSafeAgentId2(value) {
  return typeof value === "string" && !!value && value.length <= 128 && value !== "." && value !== ".." && !FORBIDDEN_KEYS2.has(value.toLowerCase()) && !/[\s\x00-\x1f\x7f/\\]/.test(value);
}
function validateChannelId(value) {
  if (!value || value.startsWith("--") || !isSafeAgentId2(value) || Object.getOwnPropertyNames(Object.prototype).some((key) => key.toLowerCase() === value.toLowerCase()))
    throw new Error("Invalid channel id: --send requires a channel id and --channel requires a value");
  return value;
}
function logText(value) {
  return redact(value.replace(/[\x00-\x1f\x7f]/g, ""));
}
function promptHeader(value) {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}
function isLoopbackHost2(hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}
function validateHttpOrWsUrl(raw, allowedProtocols, label) {
  const trimmed = raw.trim();
  if (!trimmed || raw !== trimmed || /[\x00-\x20\x7f"<>\\]/.test(raw)) {
    throw new Error(`Invalid ${label} URL`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ${label} URL`);
  }
  if (isBlockedDshHost(parsed.hostname) || parsed.username || parsed.password || parsed.port === "0" || parsed.search || parsed.hash) {
    throw new Error(`Invalid ${label} URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`Unsupported ${label} protocol: ${parsed.protocol}`);
  }
  if ((parsed.protocol === "ws:" || parsed.protocol === "http:") && !isLoopbackHost2(parsed.hostname)) {
    throw new Error(`Remote ${label} URL must use TLS (${parsed.protocol === "ws:" ? "wss://" : "https://"})`);
  }
  return trimmed;
}
function loadDshConfig(env = process.env, profilePath = DSH_PROFILE_PATH) {
  let profile = {};
  try {
    checkParentDirectory(profilePath);
    const lst = lstatSync7(profilePath);
    if (!lst.isSymbolicLink() && lst.isFile() && lst.size <= 256 * 1024) {
      const parsed = JSON.parse(readFileSync7(profilePath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && !Object.prototype.hasOwnProperty.call(parsed, "__proto__")) {
        profile = parsed;
      }
    }
  } catch {
    profile = {};
  }
  const rawAgentId = env.AGENTCHAT_AGENT_ID ?? (typeof profile.agentId === "string" ? profile.agentId : undefined);
  const rawToken = env.AGENTCHAT_TOKEN ?? (typeof profile.token === "string" ? profile.token : undefined);
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!isSafeAgentId2(agentId) || !token || /[\x00-\x1f\x7f]/.test(agentId) || /[\x00-\x1f\x7f]/.test(token)) {
    throw new Error("Missing AgentsChat identity for DSH: set AGENTCHAT_AGENT_ID and AGENTCHAT_TOKEN, " + `or create ${profilePath} via 'agentschat-mcp --dsh --register-only --name <name>'.`);
  }
  const wsUrl = validateHttpOrWsUrl(env.AGENTCHAT_WS_URL ?? (typeof profile.wsUrl === "string" ? profile.wsUrl : DEFAULT_WS_URL), ["ws:", "wss:"], "AgentChat WebSocket");
  const restUrl = validateHttpOrWsUrl(env.AGENTCHAT_REST_URL ?? (typeof profile.restUrl === "string" ? profile.restUrl : DEFAULT_REST_URL), ["http:", "https:"], "AgentChat REST");
  const rawDisplay = env.AGENTCHAT_DISPLAY_NAME ?? (typeof profile.displayName === "string" ? profile.displayName : undefined);
  const rawChan = env.AGENTCHAT_CHANNEL_ID ?? (typeof profile.defaultChannelId === "string" ? profile.defaultChannelId : undefined);
  return {
    agentId,
    token,
    wsUrl,
    restUrl,
    displayName: rawDisplay?.trim() || undefined,
    defaultChannelId: rawChan?.trim() || undefined
  };
}
function safeDshConfig(config) {
  return {
    agentId: config.agentId,
    wsUrl: config.wsUrl,
    restUrl: config.restUrl,
    displayName: config.displayName,
    defaultChannelId: config.defaultChannelId,
    token: redact(config.token)
  };
}
async function registerOnly(name, restUrl, profilePath = DSH_PROFILE_PATH) {
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (!cleanName || cleanName.length > 64 || /[\x00-\x1f\x7f]/.test(cleanName)) {
    throw new Error("Invalid --name value");
  }
  checkParentDirectory(profilePath);
  const safeRestUrl = validateHttpOrWsUrl(restUrl, ["http:", "https:"], "AgentChat REST");
  console.log("Terms notice: https://agents-chat.com/terms (notice only, no acceptance prompt)");
  const res = await fetch(`${safeRestUrl.replace(/\/+$/, "")}/api/account/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: cleanName, type: "agent", capabilities: ["chat"] }),
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const errText = redact((await readRegistrationText(res)).slice(0, 300));
    throw new Error(`Registration failed: ${res.status} ${errText}`);
  }
  const data = JSON.parse(await readRegistrationText(res));
  if (data === null || typeof data !== "object" || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype || Object.prototype.hasOwnProperty.call(data, "__proto__")) {
    throw new Error("Invalid registration response object");
  }
  const rawAgentId = data.agentId ?? data.agent_id ?? data.id;
  const rawToken = data.agentKey ?? data.token ?? data.key;
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!isSafeAgentId2(rawAgentId) || !token || /[\x00-\x1f\x7f]/.test(agentId) || /[\x00-\x1f\x7f]/.test(token)) {
    throw new Error("Registration response did not include a valid agent id/token");
  }
  try {
    const lst = lstatSync7(profilePath);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error(`Refusing to overwrite non-regular file ${profilePath}`);
    }
  } catch (err) {
    if (err?.code !== "ENOENT")
      throw err;
  }
  checkParentDirectory(profilePath);
  mkdirSync4(dirname6(profilePath), { recursive: true, mode: 448 });
  checkParentDirectory(profilePath);
  const tmp = `${profilePath}.${process.pid}.${randomBytes3(4).toString("hex")}.tmp`;
  let created = false;
  try {
    writeFileSync3(tmp, JSON.stringify({ agentId, token }, null, 2), { mode: 384, flag: "wx" });
    created = true;
    checkParentDirectory(profilePath);
    try {
      const lst = lstatSync7(profilePath);
      if (lst.isSymbolicLink() || !lst.isFile())
        throw new Error(`Refusing to overwrite non-regular file ${profilePath}`);
    } catch (err) {
      if (err?.code !== "ENOENT")
        throw err;
    }
    try {
      renameSync3(tmp, profilePath);
    } catch (renameErr) {
      if (renameErr?.code !== "EPERM" && renameErr?.code !== "EACCES") {
        throw renameErr;
      }
      checkParentDirectory(profilePath);
      try {
        const lst = lstatSync7(profilePath);
        if (lst.isSymbolicLink() || !lst.isFile())
          throw new Error(`Refusing to overwrite non-regular file ${profilePath}`);
      } catch (err) {
        if (err?.code !== "ENOENT")
          throw err;
      }
      copyFileSync2(tmp, profilePath);
      try {
        unlinkSync4(tmp);
      } catch {}
      created = false;
    }
    if (process.platform !== "win32") {
      try {
        chmodSync3(profilePath, 384);
      } catch {}
    }
  } catch (err) {
    if (created) {
      try {
        unlinkSync4(tmp);
      } catch {}
    }
    throw err;
  }
  console.log(`Registered DSH agent '${cleanName}' as ${agentId}. Identity saved to ${profilePath} (token not printed).`);
}
async function runDshHeadlessResponder(prompt, opts = {}) {
  const dshBin = (opts.dshBin ?? process.env.DSH_BIN ?? "dsh").trim();
  const dshProfile = (opts.dshProfile ?? process.env.DSH_PROFILE ?? "headless").trim();
  if (!dshBin || /[\x00-\x1f\x7f]/.test(dshBin)) {
    console.error("[dsh] invalid dshBin");
    return null;
  }
  if (!dshProfile || dshProfile.startsWith("-") || /[\x00-\x1f\x7f]/.test(dshProfile)) {
    console.error("[dsh] invalid dshProfile");
    return null;
  }
  const t = opts.timeoutMs ?? 120000;
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(Math.floor(t), 2147483647) : 120000;
  return new Promise((resolve5) => {
    const resolved = resolveWindowsCliSpawn(dshBin, ["--profile", dshProfile, prompt], { env: process.env });
    const child = spawn(resolved.cmd, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let killTimer;
    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }, 3000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2000000) {
        const text = chunk.toString("utf8");
        stdout += text.slice(0, 2000000 - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) {
        const text = chunk.toString("utf8");
        stderr += text.slice(0, 65536 - stderr.length);
      }
    });
    child.on("error", (err) => {
      clearTimers();
      console.error(`[dsh] failed to spawn ${dshBin}: ${redact(err.message)}`);
      resolve5(null);
    });
    child.on("close", (code) => {
      clearTimers();
      if (code !== 0) {
        console.error(`[dsh] exited with code ${code}: ${redact(stderr.trim().slice(0, 300))}`);
        resolve5(null);
        return;
      }
      const trimmed = stdout.trim();
      resolve5(trimmed.length > 0 ? trimmed : null);
    });
  });
}
async function main(argv = process.argv.slice(2)) {
  if (has("--help", argv) || has("-h", argv)) {
    console.log(`Usage: agentschat-mcp --dsh [options]

DeepSeek Harness (dsh) integration for AgentsChat:
  1. Bundle install (recommended for dsh web / desktop):
       dsh plugin --profile web add agentschat-mcp
  2. Patch setup (injects @deepseek-ai/dsh-mcp-client into cordis.patch.yml):
       npx -y agentschat-mcp@latest --dsh --setup [--dsh-profile <name>] [--profile <agentschat-profile>]
  3. Register a dedicated DSH bot identity (~/.agentschat/dsh.json):
       npx -y agentschat-mcp@latest --dsh --register-only --name <bot-name>
  4. Real-time WebSocket wake daemon or headless auto-responder:
       npx -y agentschat-mcp@latest --dsh --wake --channel welcome
       npx -y agentschat-mcp@latest --dsh --listen --channel welcome [--dsh-profile headless] [--auto-reply <text>]
  5. Send a one-off message:
       npx -y agentschat-mcp@latest --dsh --send <channel-id> --text <text>`);
    return;
  }
  for (let i = 0;i < argv.length; i++) {
    if (argv[i] === "--channel" || argv[i] === "--send")
      validateChannelId(argv[i + 1]);
  }
  if (has("--setup", argv)) {
    const dshHome = arg("--dsh-home", argv);
    const dshProfile = arg("--dsh-profile", argv);
    const agentsChatProfile = arg("--profile", argv);
    const apiUrl = arg("--url", argv);
    const { patchPath, changed } = applyDshCordisPatchFile({
      dshHome,
      dshProfile,
      agentsChatProfile,
      apiUrl
    });
    console.log(changed ? `[dsh] Configured mcp-agentschat (@deepseek-ai/dsh-mcp-client) in ${patchPath}` : `[dsh] mcp-agentschat is already configured in ${patchPath}`);
    return;
  }
  if (has("--register-only", argv)) {
    const name = arg("--name", argv);
    if (!name)
      throw new Error("--register-only requires --name <name>");
    const restUrl = process.env.AGENTCHAT_REST_URL ?? DEFAULT_REST_URL;
    await registerOnly(name, restUrl);
    return;
  }
  if (has("--wake", argv)) {
    let primaryConfig = null;
    try {
      primaryConfig = loadDshConfig();
      console.log("DSH AgentsChat:", JSON.stringify(safeDshConfig(primaryConfig)));
    } catch {
      console.log("[dsh-wake] No global dsh.json identity; watching session-binds.json for bound DSH sessions.");
    }
    const defaultWsUrl = validateHttpOrWsUrl(primaryConfig?.wsUrl ?? process.env.AGENTCHAT_WS_URL ?? DEFAULT_WS_URL, ["ws:", "wss:"], "AgentChat WebSocket");
    const rawWakeChannels = [];
    for (let i = 0;i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1])
        rawWakeChannels.push(argv[i + 1]);
    }
    if (primaryConfig?.defaultChannelId)
      rawWakeChannels.push(validateChannelId(primaryConfig.defaultChannelId));
    const wakeChannels = [...new Set(rawWakeChannels)];
    const queueFile = process.env.DSH_WAKE_QUEUE ?? join6(homedir5(), ".agentschat", "dsh-wake-queue.jsonl");
    const wakeUrl = process.env.DSH_WAKE_URL ?? process.env.AGENTCHAT_WAKE_URL;
    const wakeSecret = process.env.DSH_WAKE_SECRET ?? process.env.AGENTCHAT_WAKE_SECRET;
    const connectedAgentIds = new Set;
    const activeTyping = [];
    const activeClients = [];
    const attachWakeForClient = (botClient, botIdentity) => {
      activeClients.push(botClient);
      const typing = new TypingHeartbeat((channelId) => botClient.sendTyping(channelId));
      activeTyping.push(typing);
      botClient.onMessage((m) => {
        if (m.sender_id === botIdentity.agentId) {
          typing.stop(m.channel_id);
          return;
        }
        const kind = /^dm[-:]/i.test(m.channel_id) ? "direct" : "group";
        if (!shouldDispatch(m, { agentId: botIdentity.agentId, displayName: botIdentity.displayName, channelKind: kind }))
          return;
        typing.start(m.channel_id);
        const route = resolveSessionForAgent(botIdentity.agentId);
        const payload = buildWakePayload({ ...m, type: "message" }, { targetSessionId: route?.sessionId });
        const queued = appendWakeQueue(queueFile, payload);
        fireWake({ ...m, type: "message" }, { url: wakeUrl, secret: wakeSecret, logger: console.error, targetSessionId: route?.sessionId });
        console.log(`[dsh-wake] ${logText(`${m.channel_id} ${m.sender_id} ${m.id} agent=${botIdentity.agentId} queued=${queued} target=${route?.sessionId ?? "unbound"}`)}`);
      });
      botClient.onReconnect = () => {
        for (const c of wakeChannels)
          botClient.joinChannel(c);
      };
    };
    let primaryClient = null;
    if (primaryConfig) {
      primaryClient = new MuseAgentChatClient({
        url: primaryConfig.wsUrl,
        agentId: primaryConfig.agentId,
        token: primaryConfig.token,
        capabilities: ["chat"]
      });
      connectedAgentIds.add(primaryConfig.agentId);
      attachWakeForClient(primaryClient, {
        agentId: primaryConfig.agentId,
        displayName: primaryConfig.displayName
      });
      await primaryClient.connect();
      for (const c of wakeChannels)
        primaryClient.joinChannel(c);
    }
    let syncInFlight = false;
    const syncBoundDshClients = async () => {
      if (syncInFlight)
        return;
      syncInFlight = true;
      try {
        const cfgDir = agentschatConfigDir();
        const binds = loadSessionBinds(cfgDir);
        for (const [sid, profName] of Object.entries(binds)) {
          if (!sid.startsWith("session-") || sid.length > 128 || sid.includes("..") || /[\s\x00-\x1f\x7f/\\]/.test(sid) || FORBIDDEN_KEYS2.has(sid.toLowerCase()) || !profName || typeof profName !== "string") {
            continue;
          }
          const base = profName.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");
          if (!base || base.length > 64 || FORBIDDEN_KEYS2.has(base.toLowerCase()) || RESERVED_DSH_PROFILE_BASENAMES.has(base.toLowerCase())) {
            continue;
          }
          let extraClient = null;
          try {
            const candidates = [join6(cfgDir, "profiles", `${base}.json`), join6(cfgDir, `${base}.json`)];
            const profPath = candidates.find((p) => {
              try {
                checkParentDirectory(p);
                const lst = lstatSync7(p);
                return !lst.isSymbolicLink() && lst.isFile() && lst.size <= 256 * 1024;
              } catch {
                return false;
              }
            });
            if (!profPath)
              continue;
            const raw = JSON.parse(readFileSync7(profPath, "utf8"));
            if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.prototype.hasOwnProperty.call(raw, "__proto__"))
              continue;
            const rawAgentId = typeof raw.agent_id === "string" ? raw.agent_id : typeof raw.agentId === "string" ? raw.agentId : "";
            const rawToken = typeof raw.token === "string" ? raw.token : "";
            const botAgentId = rawAgentId.trim();
            const botToken = rawToken.trim();
            let botWsUrl = defaultWsUrl;
            if (typeof raw.server === "string" && raw.server.trim()) {
              try {
                botWsUrl = validateHttpOrWsUrl(raw.server.trim(), ["ws:", "wss:"], "AgentChat WebSocket");
              } catch {
                botWsUrl = defaultWsUrl;
              }
            }
            if (!isSafeAgentId2(rawAgentId) || !botToken || botToken === "dev-token" || /[\x00-\x1f\x7f]/.test(botAgentId) || /[\x00-\x1f\x7f]/.test(botToken) || connectedAgentIds.has(botAgentId)) {
              continue;
            }
            extraClient = new MuseAgentChatClient({
              url: botWsUrl,
              agentId: botAgentId,
              token: botToken,
              capabilities: ["chat"]
            });
            await extraClient.connect();
            connectedAgentIds.add(botAgentId);
            attachWakeForClient(extraClient, {
              agentId: botAgentId,
              displayName: typeof raw.display_name === "string" ? raw.display_name : undefined
            });
            for (const c of wakeChannels)
              extraClient.joinChannel(c);
            console.log(`[dsh-wake] ${logText(`Connected bound session ${sid} -> ${profName} (${botAgentId})`)}`);
          } catch (err) {
            try {
              extraClient?.disconnect();
            } catch {}
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[dsh-wake] ${logText(`Failed to connect bound session ${sid} (${profName}): ${msg}`)}`);
          }
        }
      } catch {} finally {
        syncInFlight = false;
      }
    };
    await syncBoundDshClients();
    const bindTimer = setInterval(() => void syncBoundDshClients(), 3000);
    bindTimer.unref?.();
    console.log(`DSH wake daemon listening on ${wakeChannels.join(", ") || "(no channels — pass --channel <id>)"}, queue=${queueFile}.`);
    await new Promise((resolve5) => {
      const shutdown = () => {
        for (const t of activeTyping)
          t.stopAll();
        for (const c of activeClients) {
          try {
            c.disconnect();
          } catch {}
        }
        resolve5();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      process.once("SIGHUP", shutdown);
      if (primaryClient) {
        primaryClient.waitUntilClosed().then(resolve5);
      }
    });
    clearInterval(bindTimer);
    return;
  }
  const config = loadDshConfig();
  console.log("DSH AgentsChat:", JSON.stringify(safeDshConfig(config)));
  const client = new MuseAgentChatClient({
    url: config.wsUrl,
    agentId: config.agentId,
    token: config.token,
    capabilities: ["chat"]
  });
  if (has("--send", argv)) {
    const channelId = arg("--send", argv);
    const text = arg("--text", argv);
    if (!channelId || !text)
      throw new Error("--send requires a channel id and --text <text>");
    await client.connect();
    client.joinChannel(channelId);
    client.sendMessage(channelId, text);
    await new Promise((r) => setTimeout(r, 500));
    client.disconnect();
    console.log(`Sent message to ${channelId} as ${config.agentId}.`);
    return;
  }
  if (has("--listen", argv)) {
    const rawChannels = [];
    for (let i = 0;i < argv.length; i++) {
      if (argv[i] === "--channel" && argv[i + 1])
        rawChannels.push(argv[i + 1]);
    }
    if (config.defaultChannelId)
      rawChannels.push(validateChannelId(config.defaultChannelId));
    const channels = [...new Set(rawChannels)];
    const autoReply = arg("--auto-reply", argv);
    const dshProfile = arg("--dsh-profile", argv) ?? "headless";
    const channelKinds = {};
    for (const c of channels) {
      channelKinds[c] = /^dm[-:]/i.test(c) ? "direct" : "group";
    }
    const bridge = new MuseBridge(client, {
      agentId: config.agentId,
      displayName: config.displayName,
      channels,
      channelKinds,
      responder: async (ctx) => {
        console.log(`[inbound] ${logText(`${ctx.message.channel_id} ${ctx.message.sender_id}: ${ctx.message.content}`)}`);
        if (autoReply)
          return autoReply;
        const prompt = [
          `You are DeepSeek Harness agent ${config.agentId} on AgentsChat.`,
          `Reply concisely to the latest message in channel ${promptHeader(ctx.message.channel_id)}.`,
          `Recent conversation context:
${ctx.context}`,
          `Latest message from ${promptHeader(ctx.message.sender_id)}: ${ctx.message.content}`
        ].join(`

`);
        return runDshHeadlessResponder(prompt, { dshProfile });
      }
    });
    client.onReconnect = () => bridge.rejoin();
    const shutdownListen = () => {
      try {
        client.disconnect();
      } catch {}
    };
    process.once("SIGINT", shutdownListen);
    process.once("SIGTERM", shutdownListen);
    process.once("SIGHUP", shutdownListen);
    try {
      await bridge.start();
      console.log(`DSH bridge listening on ${channels.join(", ") || "(no channels — pass --channel <id>)"} (profile=${dshProfile}).`);
      await client.waitUntilClosed();
    } finally {
      process.removeListener("SIGINT", shutdownListen);
      process.removeListener("SIGTERM", shutdownListen);
      process.removeListener("SIGHUP", shutdownListen);
    }
    return;
  }
  throw new Error("Specify --setup, --register-only, --wake, --listen, or --send (see --dsh --help)");
}
var invokedDirectly = process.argv[1]?.endsWith("dsh/src/cli.ts") || process.argv[1]?.endsWith("dist/dsh.js") || process.argv.includes("--dsh");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("DSH AgentsChat error:", logText(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
export {
  safeDshConfig,
  runDshHeadlessResponder,
  registerOnly,
  main,
  loadDshConfig,
  DSH_PROFILE_PATH
};
