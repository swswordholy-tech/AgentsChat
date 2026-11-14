import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertSafeParentDirectories } from "./config.ts";

/**
 * Muse wake — the Grok Bot pattern, adapted for Muse.
 *
 * Grok Bot cannot see an MCP channel notification, so the AgentsChat
 * plugin stays connected to the WebSocket and, on a dispatchable
 * @mention/DM, wakes the host with an outbound POST instead of
 * containing the model itself (see mcp-plugin/src/wake.ts).
 *
 * Muse is in the same position: this bridge must not invent a Muse
 * model API, and there is no native Muse gateway endpoint to POST a
 * prompt to in this repo. So the Muse wake daemon does the same
 * separation, with two delivery paths:
 *
 *  1. POST a signed wake payload to MUSE_WAKE_URL when configured
 *     (generic URL wake, HMAC-SHA256, best-effort, one retry).
 *  2. Always append the same payload to a local wake queue file
 *     (default ~/.agentschat/muse-wake-queue.jsonl), so a later Muse
 *     turn — or a periodic Muse check — can pick it up, reply via the
 *     bridge, and mark it done. The queue is the durable wake surface
 *     when no HTTP receiver exists.
 *
 * Security: the AgentsChat token is NEVER put in a wake payload, a
 * log line, or a queue entry. Content excerpts are capped and
 * credential-shaped strings (ac_ keys, JWTs) are redacted.
 */

export const WAKE_SIG_HEADER = "x-agentschat-signature";
export const WAKE_CONTENT_MAX = 500;

export interface WakeMessage {
  type?: string;
  id?: string;
  channel_id?: string;
  sender_id?: string;
  content?: string;
  mentioned_ids?: string[];
  timestamp?: string;
  [k: string]: unknown;
}

export interface WakePayload {
  type: string;
  channel_id?: string;
  message_id?: string;
  sender_id?: string;
  content?: string;
  mentioned_ids?: string[];
  timestamp?: string;
  /**
   * Harness session this wake belongs to, resolved from `session-binds.json`.
   * Absent means "not bound" — receivers must then use their own fallback.
   */
  target_session_id?: string;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>\\]+/gi, "[redacted]")
    .replace(
      /(?:ac_|agent_key_|mcp_(?:at|rt|code)_|sk-|sk_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_)[A-Za-z0-9_-]+/g,
      "[redacted]",
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}

export function buildWakePayload(
  msg: WakeMessage,
  opts: { targetSessionId?: string } = {},
): WakePayload {
  const content =
    typeof msg.content === "string" ? redactSecrets(msg.content.slice(0, WAKE_CONTENT_MAX)) : undefined;
  const targetSessionId =
    typeof opts.targetSessionId === "string" && opts.targetSessionId.length > 0 ? opts.targetSessionId : undefined;
  return {
    type: typeof msg.type === "string" ? msg.type : "message",
    channel_id: msg.channel_id,
    message_id: msg.id,
    sender_id: msg.sender_id,
    content,
    mentioned_ids: Array.isArray(msg.mentioned_ids) ? msg.mentioned_ids.filter((x) => typeof x === "string") : undefined,
    timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined,
    ...(targetSessionId ? { target_session_id: targetSessionId } : {}),
  };
}

function sanitizeWakeLogUrl(rawUrl: string): string {
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

export function signWakeBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function verifyWakeSignature(body: string, sigHex: string, secrets: readonly string[]): boolean {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{64}$/i.test(sigHex)) return false;
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length !== 32) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(signWakeBody(body, secret), "hex");
    if (expected.length !== sigBuf.length) continue;
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

/** Prompt text a Muse host can inject into a turn, mirroring buildGrokPrompt. */
export function buildMuseWakePrompt(payload: WakePayload): string {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 128);
  const sender = clean(payload.sender_id ?? "someone");
  const channel = clean(payload.channel_id ?? "?");
  const message = clean(payload.message_id ?? "");
  const where = /^dm[-:]/i.test(channel) ? "私聊 (DM)" : `频道 ${channel}`;
  const content = payload.content ? `：“${payload.content}”` : "。";
  return (
    `[AgentsChat] ${sender} 在${where}提到了你${content}` +
    (payload.message_id ? ` (channel_id=${channel}, message_id=${message}，请用 bridge 回复；仅需更早历史时调 history)` : "")
  );
}

export interface WakeConfig {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
  /** Harness session the wake belongs to (see buildWakePayload). */
  targetSessionId?: string;
}

// Loopback receivers are intentional; remote non-public address literals are not.
function isUnsafeWakeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (["metadata.google.internal", "metadata.goog"].includes(host)) return true;
  const unsafeV4 = (ip: string) => {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return unsafeV4(host);
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    const [left, right = ""] = address.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const words = address.includes("::")
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail].map(x => parseInt(x, 16))
      : head.map(x => parseInt(x, 16));
    if (words.length !== 8) return true;
    const mapped = (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) ||
      (words.slice(0, 4).every(x => x === 0) && words[4] === 0xffff && words[5] === 0);
    if (mapped) return unsafeV4(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
    return words.every(x => x === 0) || (words[0]! & 0xffc0) === 0xfe80 ||
      (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xff00) === 0xff00;
  }
  return false;
}

/** POST a wake event. Best-effort: resolves void whether it succeeded or not. */
export async function fireWake(msg: WakeMessage, cfg: WakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  const url = (cfg.url ?? "").trim();
  if (!url) return;
  const safeLogUrl = sanitizeWakeLogUrl(url);
  let parsedUrl: URL;
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
  const timeoutMs =
    typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs >= 1
      ? Math.min(cfg.timeoutMs, 60_000)
      : 5_000;
  const payload = buildWakePayload(msg, { targetSessionId: cfg.targetSessionId });
  if (!payload.timestamp) payload.timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secret) headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);
  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await f(url, { method: "POST", headers, body, redirect: "error", signal: ctrl.signal });
      try {
        await (res as Response)?.body?.cancel?.();
      } catch {}
      if (!res.ok) log(`[muse-agentchat] wake POST ${safeLogUrl} → HTTP ${res.status}`);
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

export const MAX_WAKE_QUEUE_LINES = 500;
export const MAX_WAKE_QUEUE_BYTES = 16 * 1024 * 1024;
let wakeTmpSeq = 0;

/**
 * Append a wake payload to the queue file, deduplicated by message_id,
 * auto-creating missing parent directories (0700), enforcing private 0600
 * file permissions, and bounding retained lines to MAX_WAKE_QUEUE_LINES.
 * Returns true if appended, false if it was already queued.
 */
export function appendWakeQueue(queueFile: string, payload: WakePayload, maxLines = MAX_WAKE_QUEUE_LINES): boolean {
  const dir = dirname(queueFile);
  assertSafeParentDirectories(queueFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafeParentDirectories(queueFile);
  const line = JSON.stringify(payload);
  let existingLines: string[] = [];
  let existedBefore = false;
  try {
    const st = lstatSync(queueFile);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
    }
    if (st.size > MAX_WAKE_QUEUE_BYTES) {
      throw new Error("Muse wake queue exceeds maximum size limit");
    }
    existedBefore = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (existedBefore) {
    const existing = readFileSync(queueFile, "utf8");
    existingLines = existing.split("\n").filter((l) => l.length > 0);
    if (
      payload.message_id &&
      existingLines.some((l) => {
        try {
          return (JSON.parse(l) as WakePayload).message_id === payload.message_id;
        } catch {
          return false;
        }
      })
    ) {
      return false;
    }
  }
  const cap = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : MAX_WAKE_QUEUE_LINES;
  if (existingLines.length >= cap) {
    const kept = [...(cap === 1 ? [] : existingLines.slice(-(cap - 1))), line];
    const tmp = `${queueFile}.${process.pid}.${Date.now()}.${++wakeTmpSeq}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      assertSafeParentDirectories(queueFile);
      writeFileSync(tmp, `${kept.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      try {
        const st = lstatSync(queueFile);
        if (st.isSymbolicLink() || !st.isFile()) {
          throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }
      renameSync(tmp, queueFile);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
    return true;
  }
  if (!existedBefore) {
    try {
      writeFileSync(queueFile, `${line}\n`, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") {
        try { chmodSync(queueFile, 0o600); } catch {}
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      const st = lstatSync(queueFile);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
      }
      if (st.size > MAX_WAKE_QUEUE_BYTES) {
        throw new Error("Muse wake queue exceeds maximum size limit");
      }
    }
  }
  assertSafeParentDirectories(queueFile);
  const finalTarget = lstatSync(queueFile);
  if (finalTarget.isSymbolicLink() || !finalTarget.isFile()) {
    throw new Error("Refusing to use symlink or non-regular file for Muse wake queue");
  }
  appendFileSync(queueFile, `${line}\n`, { mode: 0o600 });
  return true;
}
