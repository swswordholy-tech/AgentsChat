/**
 * Wake-webhook — fire an outbound HTTP POST when an @mention/DM arrives, so hosts
 * WITHOUT an MCP channel-notification surface (Grok Bot, generic MCP clients) can
 * be woken by "a POST hit my URL" instead of needing to recognize a host-specific
 * notification method.
 *
 * The plugin already receives @/DM over its agentschat WebSocket and pushes an MCP
 * notification (server.ts). Claude Code acts on that notification; other hosts drop
 * it. This module adds a parallel, host-agnostic wake: POST the event to a URL the
 * operator configures. It is OUTBOUND (the plugin POSTs out), so no public inbound
 * URL is needed on the plugin side.
 *
 * Security:
 *  - The agentschat token is NEVER put in the callback body — the ac_ key stays
 *    local; only message metadata + a content excerpt cross the wire.
 *  - Auth to the receiver is an HMAC-SHA256 signature over the RAW body, keyed by
 *    AGENTCHAT_WAKE_SECRET, in the `x-agentschat-signature` header — so the
 *    receiver can tell a real wake from a forged POST. (The receiver's own secret
 *    in the URL path is its own business; we sign with the shared wake secret.)
 *
 * Delivery is best-effort: a failed/slow POST must never block or break the MCP
 * notification path (which is how Claude Code wakes). One bounded retry, short
 * timeout, then drop with a stderr note.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, win32 as pathWin32 } from "node:path";
import { redactSecrets } from "./redact.ts";

/** Signature header the receiver reads to verify a wake POST. */
export const WAKE_SIG_HEADER = "x-agentschat-signature";
/** Header forwarded on authenticated REST calls when AGENTSCHAT_WAKE_ID is present. */
export const WAKE_ID_HEADER = "X-AgentsChat-Wake-Id";
const SAFE_WAKE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const CREDENTIAL_PREFIX_RE =
  /^(ac_|mcp_(?:at|rt|code)_|agent_key_|whsec_|sk-|sk_|rk_live_|rk_test_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|AKIA|ASIA)/i;
const MAX_WAKE_TIMER_MS = 2_147_483_647;
const GROK_GATEWAY_MAX_BYTES = 1_048_576;
const DIRECT_CHANNEL_RE = /^dm[-:]/i;
const SAFE_ZCODE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isAllowedDarwinSystemLink(dirPath: string): boolean {
  if (process.platform !== "darwin") return false;
  if (dirPath !== "/var" && dirPath !== "/tmp" && dirPath !== "/etc") return false;
  try {
    return readlinkSync(dirPath) === `private${dirPath}`;
  } catch {
    return false;
  }
}

function hasSafeDirChain(dirPath: string): boolean {
  const abs = resolve(dirPath);
  const root = parse(abs).root;
  const rel = abs.slice(root.length);
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let cur = root;
  for (let i = 0; i < segments.length; i++) {
    cur = join(cur, segments[i]!);
    let st: Stats;
    try {
      st = lstatSync(cur);
    } catch (err: any) {
      if (err && err.code === "ENOENT") return true;
      return false;
    }
    if (st.isSymbolicLink()) {
      if (isAllowedDarwinSystemLink(cur)) continue;
      return false;
    }
    if (!st.isDirectory()) return false;
  }
  return true;
}

function isUnsafeMetadataOrLinkLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    !lower ||
    lower === "0.0.0.0" ||
    lower === "::" ||
    lower === "100.100.100.200" ||
    lower === "fd00:ec2::254" ||
    lower === "metadata.google.internal" ||
    lower === "metadata" ||
    lower === "metadata.goog" ||
    lower.endsWith(".metadata.goog") ||
    lower === "instance-data"
  ) {
    return true;
  }
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    const tailParts = tail.startsWith("0:") ? tail.slice(2) : tail;
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(tailParts) || tailParts === "100.100.100.200" || tailParts === "0.0.0.0") {
      return true;
    }
    const hexMatch = tailParts.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      if ((((hi >> 8) & 0xff) === 169 && (hi & 0xff) === 254) || (hi === 0x6464 && lo === 0x64c8) || (hi === 0 && lo === 0)) {
        return true;
      }
    }
  }
  return false;
}

/** Clamp timeout/grace durations to safe positive 32-bit signed integers so setTimeout never overflows to 1ms. */
export function clampWakeTimerMs(raw: unknown, fallback: number, minMs = 1): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_WAKE_TIMER_MS, Math.max(minMs, Math.floor(raw)))
    : fallback;
}

/** Validate explicit Antigravity language_server address strictly as loopback host:port (1..65535). */
export function normalizeLoopbackLsAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/i.exec(raw.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${m[1]!.toLowerCase()}:${port}`;
}

function sanitizeWakeAttachmentUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/[\x00-\x1f\x7f\r\n]+/g, "");
  if (!cleaned || cleaned.length > 2048 || /\s/.test(cleaned) || !/^https?:\/\//i.test(cleaned)) return null;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (isUnsafeMetadataOrLinkLocalHost(parsed.hostname)) return null;
  return cleaned;
}

/**
 * Validate `AGENTSCHAT_WAKE_ID` injected by Cloud Sandbox per wake turn so
 * stdio MCP REST calls (`okr_update_task`, `okr_add_task_comment`) carry
 * explicit process-level wake correlation without ever echoing unsafe tokens.
 */
export function resolveEnvWakeId(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.AGENTSCHAT_WAKE_ID?.trim();
  if (!raw || !SAFE_WAKE_ID_RE.test(raw) || CREDENTIAL_PREFIX_RE.test(raw)) return undefined;
  return raw;
}

/** Cap the content excerpt for generic HTTP wake webhooks so a long message doesn't balloon the POST body. */
export const WAKE_CONTENT_MAX = 500;
/** Cap for native IDE/CLI wake prompts (Antigravity / ZCode), matching get_history per-message cap. */
export const NATIVE_WAKE_CONTENT_MAX = 4000;

export interface WakeAttachment {
  type?: string;
  url?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  transcript?: string;
}

export interface WakeMessage {
  type?: string;
  id?: string;
  channel_id?: string;
  sender_id?: string;
  content?: string;
  attachments?: WakeAttachment[];
  mentioned_ids?: string[];
  timestamp?: string;
  /** True when server verified this DM is between an owner and their own agent, or sibling agents of the same owner. */
  same_owner_direct?: boolean;
  /** Anything credential-shaped is stripped; these are accepted only to be dropped. */
  token?: string;
  agent_key?: string;
  [k: string]: unknown;
}

export interface WakePayload {
  type: string;
  channel_id?: string;
  message_id?: string;
  sender_id?: string;
  content?: string;
  attachments?: WakeAttachment[];
  mentioned_ids?: string[];
  timestamp?: string;
  /**
   * Harness session this wake belongs to, resolved from `session-binds.json`.
   * Absent means "not bound" — receivers must then use their own fallback.
   */
  target_session_id?: string;
}

export function formatWakeAttachments(attachments: unknown): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const lines: string[] = [];
  for (const raw of attachments) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as WakeAttachment;
    const safeUrl = sanitizeWakeAttachmentUrl(a.url);
    if (!safeUrl) continue;
    const t = typeof a.type === "string" ? a.type.replace(/[\x00-\x1f\x7f]+/g, "").slice(0, 32) : "file";
    const dim = typeof a.width === "number" && typeof a.height === "number" ? ` ${a.width}×${a.height}` : "";
    const dur = typeof a.duration_ms === "number" && Number.isFinite(a.duration_ms) ? ` ${(a.duration_ms / 1000).toFixed(1)}s` : "";
    const icon = t === "image" ? "🖼" : t === "video" ? "🎬" : t === "audio" ? "🔊" : "📎";
    let desc = `${icon} ${t}${dim}${dur}: ${safeUrl}`;
    if (typeof a.transcript === "string" && a.transcript.trim()) {
      desc += ` (transcript: "${redactSecrets(a.transcript.trim().slice(0, 300))}")`;
    }
    lines.push(desc);
  }
  return lines.length > 0 ? ` [附件: ${lines.join("; ")}]` : "";
}

function sanitizeWakeHeaderToken(raw: unknown, maxLen = 128): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]+/g, "").trim().slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : undefined;
}

function isAllowedWakeHttpUrl(rawUrl: string): boolean {
  if (!rawUrl || rawUrl.length > 4096 || /[\x00-\x1f\x7f]/.test(rawUrl)) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isUnsafeMetadataOrLinkLocalHost(parsed.hostname)) return false;
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

/**
 * Build the wake body: the fields the receiver needs to wake + decide + optionally
 * skip a history fetch. Credential-shaped fields are never carried across.
 */
export function buildWakePayload(msg: WakeMessage, opts: { targetSessionId?: string } = {}): WakePayload {
  // The content excerpt crosses the wire to the wake receiver, so it goes through
  // the same redactSecrets every other outbound content path uses (reply/edit/
  // caption/status) — a message with an ac_ key or JWT pasted into it must not leak
  // it into the wake body either (except ac_ keys in same-owner direct channels).
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = typeof msg.content === "string" ? redactSecrets(msg.content.slice(0, WAKE_CONTENT_MAX), redactOpts) : undefined;
  const attachments = Array.isArray(msg.attachments) && msg.attachments.length > 0
    ? msg.attachments
        .slice(0, 16)
        .map((a) => {
          if (!a || typeof a !== "object") return null;
          const safeUrl = sanitizeWakeAttachmentUrl(a.url);
          if (!safeUrl) return null;
          return {
            type: sanitizeWakeHeaderToken(a.type, 32),
            url: safeUrl,
            mime: sanitizeWakeHeaderToken(a.mime, 128),
            size: typeof a.size === "number" && Number.isFinite(a.size) && a.size >= 0 ? a.size : undefined,
            width: typeof a.width === "number" && Number.isFinite(a.width) && a.width >= 0 ? a.width : undefined,
            height: typeof a.height === "number" && Number.isFinite(a.height) && a.height >= 0 ? a.height : undefined,
            duration_ms: typeof a.duration_ms === "number" && Number.isFinite(a.duration_ms) && a.duration_ms >= 0 ? a.duration_ms : undefined,
            transcript: typeof a.transcript === "string" ? redactSecrets(a.transcript.slice(0, 300), redactOpts) : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : undefined;
  const targetSessionId = sanitizeWakeHeaderToken(opts.targetSessionId, 256);
  const channelId = sanitizeWakeHeaderToken(msg.channel_id, 128);
  const messageId = sanitizeWakeHeaderToken(msg.id, 128);
  const senderId = sanitizeWakeHeaderToken(msg.sender_id, 128);
  const mentionedIds = Array.isArray(msg.mentioned_ids)
    ? msg.mentioned_ids
        .slice(0, 64)
        .map((x) => sanitizeWakeHeaderToken(x, 128))
        .filter((x): x is string => Boolean(x))
    : undefined;
  return {
    type: sanitizeWakeHeaderToken(msg.type, 64) ?? "message",
    channel_id: channelId,
    message_id: messageId,
    sender_id: senderId,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    mentioned_ids: mentionedIds,
    timestamp: sanitizeWakeHeaderToken(msg.timestamp, 64),
    ...(targetSessionId ? { target_session_id: targetSessionId } : {}),
  };
}

/** HMAC-SHA256 hex digest of `body` under `secret`. */
export function signWakeBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time check that `sigHex` signs `body` under ANY of `secrets` (rotation). */
export function verifyWakeSignature(body: string, sigHex: string, secrets: readonly string[]): boolean {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{64}$/i.test(sigHex)) return false;
  const sigBuf = Buffer.from(sigHex, "hex");
  if (sigBuf.length !== 32) return false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(signWakeBody(body, secret), "hex");
    if (expected.length !== sigBuf.length) continue;
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

/** Strip URL userinfo, query params, and secret-shaped path tokens before logging wake URLs. */
export function sanitizeWakeLogUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    if (parsed.search) parsed.search = "?[REDACTED]";
    parsed.hash = "";
    return redactSecrets(parsed.toString());
  } catch {
    return redactSecrets(String(rawUrl || "")).slice(0, 120);
  }
}

export interface WakeConfig {
  /** Where to POST. Empty/absent disables the wake webhook entirely. */
  url?: string;
  /** Shared secret for signing. Empty → send unsigned (receiver can't verify; still woken). */
  secret?: string;
  /** POST timeout (ms). */
  timeoutMs?: number;
  /** Extra fetch impl for tests. */
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
  /** Harness session the wake belongs to (see buildWakePayload). */
  targetSessionId?: string;
}

/**
 * POST a wake event to the configured URL. Best-effort: resolves void whether it
 * succeeded or not; never throws into the caller's message path.
 */
export async function fireWake(msg: WakeMessage, cfg: WakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  const url = (cfg.url ?? "").trim();
  if (!url) return; // not configured — the wake path is opt-in
  const safeLogUrl = sanitizeWakeLogUrl(url);
  if (!isAllowedWakeHttpUrl(url)) {
    log(`[agentchat] wake POST rejected invalid or non-HTTP(S) URL: ${safeLogUrl}`);
    return;
  }

  const payload = buildWakePayload(msg, { targetSessionId: cfg.targetSessionId });
  if (!payload.timestamp) payload.timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secret) headers[WAKE_SIG_HEADER] = signWakeBody(body, cfg.secret);

  const timeoutMs = clampWakeTimerMs(cfg.timeoutMs, 5000);
  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await f(url, { method: "POST", headers, body, signal: ctrl.signal, redirect: "error" });
      if (!res.ok) log(`[agentchat] wake POST ${safeLogUrl} → HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
    } finally {
      clearTimeout(t);
    }
  };

  try {
    await doPost();
  } catch (e) {
    // one bounded retry, then drop — a slow/absent receiver must not wedge the loop
    try {
      await doPost();
    } catch (e2) {
      log(`[agentchat] wake POST ${safeLogUrl} failed: ${redactSecrets(String(e2)).slice(0, 200)}`);
    }
  }
}

// ── Grok mode (A1): loopback /api/sendPrompt to a same-machine Grok gateway ──
//
// A Grok gateway is NOT a generic wake receiver: it expects
//   POST http://127.0.0.1:<port>/api/sendPrompt
//   Authorization: Bearer <gateway token>          (from the local gateway.json)
//   {"agentId": "<gw agent uuid>", "prompt": "..."}
// Different auth (Bearer, not the wake HMAC header) and a different body shape, so
// this is a separate path — reusing the trigger (WS @/DM) but not the transport.

export interface GrokPrompt {
  agentId: string;
  prompt: string;
}

/**
 * Build the sendPrompt body. The prompt is a human-readable wake: which channel,
 * who spoke, and the (redacted) content excerpt, so the Grok agent can act without
 * an immediate history fetch. Credential-shaped fields are never carried.
 */
export function buildGrokPrompt(msg: WakeMessage, agentId: string, contextPrefix = ""): GrokPrompt {
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const isTruncated = rawContent.length > NATIVE_WAKE_CONTENT_MAX;
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = rawContent ? redactSecrets(rawContent.slice(0, NATIVE_WAKE_CONTENT_MAX), redactOpts) : "";
  const cleanPrefix = contextPrefix ? redactSecrets(contextPrefix.trim(), redactOpts) : "";
  const channel = sanitizeWakeHeaderToken(msg.channel_id, 128) ?? "?";
  const sender = sanitizeWakeHeaderToken(msg.sender_id, 128) ?? "someone";
  const msgId = sanitizeWakeHeaderToken(msg.id ?? (msg as any).message_id, 128) ?? "";
  const isDm = DIRECT_CHANNEL_RE.test(channel);
  const where = isDm ? "私聊 (DM)" : `频道 ${channel}`;
  const actionHint = isTruncated
    ? `——消息已截断，可调 get_history 查看全文，再用 reply 回复`
    : `——请直接用 reply 回复；仅需更早历史时调 get_history`;
  const attSummary = formatWakeAttachments(msg.attachments);
  const prompt =
    (cleanPrefix ? `${cleanPrefix}\n\n` : "") +
    `[AgentsChat] ${sender} 在${where}提到了你` +
    (content ? `："${content}${isTruncated ? " …[truncated]" : ""}"` : "。") +
    attSummary +
    (msgId ? ` (channel_id=${channel}, message_id=${msgId}${actionHint})` : "");
  return { agentId, prompt };
}

/**
 * Extract the gateway Bearer token from a parsed gateway.json. Tries the common
 * shapes (`token`, `auth.bearer`); returns null when absent — fail closed, never
 * guess. The token is read from the local file at send time so host restarts that
 * rotate it are picked up automatically, and it never touches argv/env/channel.
 */
export function grokBearerFromGatewayConfig(cfg: any): string | null {
  if (!cfg || typeof cfg !== "object" || Object.prototype.hasOwnProperty.call(cfg, "__proto__")) return null;
  const candidate =
    typeof cfg.token === "string" && cfg.token
      ? cfg.token.trim()
      : cfg.auth &&
          typeof cfg.auth === "object" &&
          !Object.prototype.hasOwnProperty.call(cfg.auth, "__proto__") &&
          typeof cfg.auth.bearer === "string" &&
          cfg.auth.bearer
        ? cfg.auth.bearer.trim()
        : "";
  if (!candidate || candidate.length > 4096 || /[\x00-\x1f\x7f]/.test(candidate)) return null;
  return candidate;
}

/** Extract the gateway port (for the loopback URL) from a parsed gateway.json. */
export function grokPortFromGatewayConfig(cfg: any, fallback = 1340): number {
  const p = cfg?.port;
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535 ? p : fallback;
}

/**
 * Candidate locations for the Grok gateway.json, in preference order. The
 * classic default is `~/.grok/gateway.json`, but production GrokBot hosts keep
 * the live config at `/home/box/sand-data/gateway.json` (the `~/.grok` path
 * does not exist there). AGENTCHAT_GROK_GATEWAY overrides everything; absent
 * that, the FIRST candidate that exists on disk wins. When none exists the
 * first candidate is returned so the read fails with a useful path in the
 * error — fail closed, no wake.
 */
export const GROK_GATEWAY_PATH_CANDIDATES = [
  join(process.env.HOME || process.env.USERPROFILE || homedir(), ".grok", "gateway.json"),
  "/home/box/sand-data/gateway.json",
] as const;

export function resolveGrokGatewayPath(
  explicit: string | undefined,
  exists: (path: string) => boolean,
): string {
  if (explicit && explicit.trim()) return explicit;
  for (const candidate of GROK_GATEWAY_PATH_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return GROK_GATEWAY_PATH_CANDIDATES[0];
}

export interface GrokWakeConfig {
  /** Path to the Grok gateway.json (read at send time). */
  gatewayConfigPath: string;
  /**
   * The gateway agent uuid to address. One plugin instance fronts ONE AgentsChat
   * agent, which binds to ONE Grok agent (1:1) — set this explicitly. If empty,
   * the caller may fall back to resolving by name via listAgents (see
   * resolveGrokAgentId); an unresolved id means no wake is sent.
   */
  agentId: string;
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/**
 * Resolve which Grok agent to wake. Preference order (per the 1:1 design):
 *   1. the explicit agentId (operator-bound, unambiguous) — wins if set;
 *   2. name match against the gateway's listAgents (convenience fallback, warns —
 *      names on the two sides are not guaranteed to agree);
 *   3. null — fail closed (no wake), with a stderr note on how to bind.
 */
export async function resolveGrokAgentId(opts: {
  explicitId?: string;
  agentschatName?: string;
  listAgents?: () => Promise<Array<{ id?: string; name?: string }>>;
  logger?: (msg: string) => void;
}): Promise<string | null> {
  const log = opts.logger ?? (() => {});
  if (opts.explicitId && opts.explicitId.trim()) return opts.explicitId.trim();
  if (opts.listAgents && opts.agentschatName) {
    try {
      const agents = await opts.listAgents();
      const hit = agents.find((a) => a.name && a.name === opts.agentschatName);
      if (hit?.id) {
        log(`[agentchat] grok wake: no AGENTCHAT_GROK_AGENT_ID; matched "${opts.agentschatName}" → ${hit.id} via listAgents (set the env to bind explicitly)`);
        return hit.id;
      }
    } catch (e) {
      log(`[agentchat] grok wake: listAgents fallback failed: ${redactSecrets(String(e)).slice(0, 200)}`);
    }
  }
  log(`[agentchat] grok wake: no Grok agentId bound. Set AGENTCHAT_GROK_AGENT_ID=<gateway agent uuid> (1:1 mapping).`);
  return null;
}

/**
 * Fire a Grok wake: read the gateway token from gateway.json, POST the sendPrompt
 * body to the loopback gateway. Best-effort, never throws into the message path.
 */
export async function fireGrokWake(msg: WakeMessage, cfg: GrokWakeConfig): Promise<void> {
  const log = cfg.logger ?? (() => {});
  if (!cfg.agentId) {
    log(`[agentchat] grok wake: no agentId configured, skipping`);
    return;
  }
  let gwcfg: any;
  try {
    const resolvedGatewayPath = resolve(cfg.gatewayConfigPath);
    if (!hasSafeDirChain(dirname(resolvedGatewayPath))) {
      log(`[agentchat] grok wake: rejected symlinked ancestor directory for ${cfg.gatewayConfigPath}`);
      return;
    }
    const stat = lstatSync(resolvedGatewayPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > GROK_GATEWAY_MAX_BYTES) {
      log(`[agentchat] grok wake: rejected unsafe or oversized gateway config ${cfg.gatewayConfigPath}`);
      return;
    }
    gwcfg = JSON.parse(readFileSync(resolvedGatewayPath, "utf8"));
    if (!gwcfg || typeof gwcfg !== "object" || Object.prototype.hasOwnProperty.call(gwcfg, "__proto__")) {
      log(`[agentchat] grok wake: rejected malformed gateway config ${cfg.gatewayConfigPath}`);
      return;
    }
  } catch (e) {
    log(`[agentchat] grok wake: cannot read ${cfg.gatewayConfigPath}: ${redactSecrets(String(e)).slice(0, 200)}`);
    return;
  }
  const token = grokBearerFromGatewayConfig(gwcfg);
  if (!token) {
    log(`[agentchat] grok wake: no bearer token in ${cfg.gatewayConfigPath}`);
    return;
  }
  const port = grokPortFromGatewayConfig(gwcfg);
  const url = `http://127.0.0.1:${port}/api/sendPrompt`;
  const body = JSON.stringify(buildGrokPrompt(msg, cfg.agentId, cfg.contextPrefix));
  const timeoutMs = clampWakeTimerMs(cfg.timeoutMs, 5000);

  const doPost = async (): Promise<void> => {
    const f = cfg.fetchImpl ?? fetch;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) log(`[agentchat] grok wake POST ${url} → HTTP ${res.status}`);
      await res.body?.cancel().catch(() => {});
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
      log(`[agentchat] grok wake POST ${url} failed: ${redactSecrets(String(e2)).slice(0, 200)}`);
    }
  }
}

// ── Native Host Wake: Antigravity (Connect-RPC SendAgentMessage) & ZCode (--resume) ──

/**
 * Build a human-readable wake prompt for native IDE/CLI sessions (Antigravity, ZCode).
 * Includes any missed channel context (`contextPrefix`) and only recommends `get_history`
 * when earlier history is needed or the message itself was truncated.
 * Never carries tokens or secret-shaped strings.
 */
export function buildWakePrompt(msg: WakeMessage, contextPrefix = ""): string {
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const isTruncated = rawContent.length > NATIVE_WAKE_CONTENT_MAX;
  const redactOpts = msg.same_owner_direct === true ? { preserveAcKeys: true } : undefined;
  const content = rawContent ? redactSecrets(rawContent.slice(0, NATIVE_WAKE_CONTENT_MAX), redactOpts) : "";
  const cleanPrefix = contextPrefix ? redactSecrets(contextPrefix.trim(), redactOpts) : "";
  const channel = sanitizeWakeHeaderToken(msg.channel_id, 128) ?? "?";
  const sender = sanitizeWakeHeaderToken(msg.sender_id, 128) ?? "someone";
  const msgId = sanitizeWakeHeaderToken(msg.id ?? (msg as any).message_id, 128) ?? "";
  const isDm = DIRECT_CHANNEL_RE.test(channel);
  const where = isDm ? `私聊 (${channel})` : `频道 ${channel}`;
  const actionHint = isTruncated
    ? ` —— 消息过长已截断，可调用 get_history(chat_id, message_id) 查看全文，再用 reply 回复并 mark_read 标记已读`
    : ` —— 请直接用 reply 回复并用 mark_read 标记已读；仅在需要更早上下文时调用 get_history`;
  const attSummary = formatWakeAttachments(msg.attachments);
  return (
    (cleanPrefix ? `${cleanPrefix}\n\n` : "") +
    `[AgentsChat] ${sender} 在${where}给你发了消息` +
    (content ? `："${content}${isTruncated ? " …[truncated]" : ""}"` : "。") +
    attSummary +
    ` (channel_id=${channel}` +
    (msgId ? `, message_id=${msgId}` : "") +
    `${actionHint})`
  );
}

export interface AntigravityWakeConfig {
  /** Target Antigravity conversation UUID (`<uuid>` from `~/.gemini/antigravity/presence/<uuid>.lock`). */
  conversationId: string;
  /** CSRF token from the parent `language_server` (`--csrf_token`). */
  csrfToken: string;
  /** Optional explicit `host:port` (e.g. from `ANTIGRAVITY_LS_ADDRESS`). */
  lsAddress?: string;
  /** Candidate localhost ports on `127.0.0.1` (sorted highest-first so HTTP port is tried before HTTPS). */
  ports?: number[];
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  /** Optional prompt override (e.g. for loop_tick). */
  promptOverride?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: (msg: string) => void;
}

/**
 * Wake an open Antigravity conversation directly via its local `language_server`
 * Connect-RPC endpoint (`SendAgentMessage`). No external `url-wake` daemon required.
 */
export async function fireAntigravityWake(msg: WakeMessage, cfg: AntigravityWakeConfig): Promise<boolean> {
  const log = cfg.logger ?? (() => {});
  const conversationId = (cfg.conversationId ?? "").trim();
  const csrfToken = (cfg.csrfToken ?? "").trim();
  if (
    !conversationId ||
    conversationId.length > 128 ||
    /[\x00-\x1f\x7f]/.test(conversationId) ||
    !csrfToken ||
    csrfToken.length > 1024 ||
    /[\x00-\x1f\x7f]/.test(csrfToken)
  ) {
    log(`[agentchat] antigravity wake: missing or unsafe conversationId or csrfToken, skipping`);
    return false;
  }

  const addresses: string[] = [];
  if (cfg.lsAddress && cfg.lsAddress.trim()) {
    const safeAddr = normalizeLoopbackLsAddress(cfg.lsAddress);
    if (safeAddr) {
      addresses.push(safeAddr);
    } else {
      log(`[agentchat] antigravity wake: rejected non-loopback or invalid lsAddress`);
    }
  }
  for (const p of cfg.ports ?? []) {
    if (typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535) {
      const addr = `127.0.0.1:${p}`;
      if (!addresses.includes(addr)) addresses.push(addr);
    }
  }
  if (addresses.length === 0) {
    log(`[agentchat] antigravity wake: no language_server ports found, skipping`);
    return false;
  }

  const prompt = cfg.promptOverride ?? buildWakePrompt(msg, cfg.contextPrefix);
  const channel = sanitizeWakeHeaderToken(redactSecrets(String(msg.channel_id ?? "")), 128) ?? "chat";
  const sender = sanitizeWakeHeaderToken(redactSecrets(String(msg.sender_id ?? "")), 128) ?? "channel";
  const body = JSON.stringify({
    recipient: conversationId,
    senderId: `agentschat:${sender}`,
    displayTitle: `AgentsChat #${channel}`,
    content: prompt,
  });

  const f = cfg.fetchImpl ?? fetch;
  const timeoutMs = clampWakeTimerMs(cfg.timeoutMs, 5000);
  for (const addr of addresses) {
    const url = `http://${addr}/exa.language_server_pb.LanguageServerService/SendAgentMessage`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrfToken,
        },
        body,
        signal: ctrl.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (res.ok) {
        return true;
      }
      log(`[agentchat] antigravity wake POST ${url} → HTTP ${res.status}`);
    } catch {
      // Try next candidate port (e.g., if the first port was HTTPS or closed)
    } finally {
      clearTimeout(t);
    }
  }
  log(`[agentchat] antigravity wake: all candidate ports (${addresses.join(", ")}) failed for ${conversationId}`);
  return false;
}

export interface ZcodeWakeConfig {
  /** ZCode session ID (`sess_...`) captured from `_meta.session_id` or `ZCODE_SESSION_ID`. */
  sessionId: string;
  /** Workspace path for `--cwd` when resuming the session. */
  workspacePath?: string;
  /** Bound profile name so the resumed turn's tool calls inherit the exact identity. */
  profileName?: string;
  /** PID of the parent MCP server holding `<agent_id>.lock`. */
  lockOwnerPid?: number;
  /** Optional override for the `zcode` binary or script path. */
  zcodeBin?: string;
  /** Optional missed channel messages prefix fetched since last @mention. */
  contextPrefix?: string;
  /** Optional prompt override (e.g. for loop_tick). */
  promptOverride?: string;
  /** Timeout per turn in ms (default 180s). */
  timeoutMs?: number;
  /** Grace period in ms after SIGTERM before escalating to SIGKILL (default 2000ms). */
  killGraceMs?: number;
  /** Injectable runner for unit tests. */
  runCommandImpl?: (cmd: string, args: string[], opts: { cwd?: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<{ code: number; stderr?: string }>;
  logger?: (msg: string) => void;
}

const zcodeSessionQueues = new Map<string, Promise<void>>();

export interface ResolveWindowsCliOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  execPath?: string;
  existsImpl?: (path: string) => boolean;
  readTextImpl?: (path: string) => string;
}

/**
 * Safely resolve a CLI command on Windows (`win32`) without `shell: true`
 * (preventing Node CVE-2024-27980 `EINVAL` / `ENOENT` on npm `.cmd` shims AND
 * preventing `cmd.exe` `%VAR%` / `&` metacharacter injection on user prompts).
 *
 * Resolution order on `win32`:
 *  1. `.js` / `.cjs` / `.mjs` script -> `{ cmd: execPath, args: [script, ...args] }`
 *  2. `<cmd>.exe` (explicit path or on `PATH`) -> `{ cmd: exePath, args }`
 *  3. npm `<cmd>.cmd` shim wrapping a JS/CJS/MJS script (`"%~dp0\...\cli.js" %*`
 *     or `"%dp0%\...\cli.cjs" %*`) -> `{ cmd: execPath, args: [resolvedJsPath, ...args] }`
 */
export function resolveWindowsCliSpawn(
  cmd: string,
  args: string[],
  opts?: ResolveWindowsCliOptions,
): { cmd: string; args: string[] } {
  const platform = opts?.platform ?? process.platform;
  const trimmed = (cmd || "").trim();
  if (!trimmed) return { cmd, args };
  const execPath = opts?.execPath ?? process.execPath;
  if (/\.(?:cjs|mjs|js)$/i.test(trimmed)) {
    return { cmd: execPath, args: [trimmed, ...args] };
  }
  if (platform !== "win32") {
    return { cmd: trimmed, args };
  }

  const env = opts?.env ?? process.env;
  const exists = opts?.existsImpl ?? existsSync;
  const readText = opts?.readTextImpl ?? ((p: string) => readFileSync(p, "utf8"));
  const hasSep = /[\\/]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed);
  const hasWinExt = /\.(?:exe|cmd|bat)$/i.test(trimmed);

  const candidates: string[] = [];
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
      if (!dir) continue;
      if (hasWinExt) {
        candidates.push(pathWin32.join(dir, trimmed));
      } else {
        candidates.push(pathWin32.join(dir, `${trimmed}.exe`), pathWin32.join(dir, `${trimmed}.cmd`));
      }
    }
  }

  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
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

/**
 * Resolve the executable command + prefix args for `zcode` CLI.
 * Supports `zcode` on PATH or macOS `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`.
 */
export async function resolveZcodeCommand(explicitBin?: string): Promise<{ cmd: string; prefixArgs: string[] }> {
  const fromArg = (explicitBin ?? process.env.ZCODE_BIN ?? "").trim();
  if (fromArg) {
    if (/\.(?:cjs|mjs|js)$/i.test(fromArg)) {
      return { cmd: process.execPath, prefixArgs: [fromArg] };
    }
    return { cmd: fromArg, prefixArgs: [] };
  }
  if (process.platform === "darwin") {
    const macAppBundleCjs = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
    try {
      if (existsSync(macAppBundleCjs)) {
        return { cmd: process.execPath, prefixArgs: [macAppBundleCjs] };
      }
    } catch {}
  }
  return { cmd: "zcode", prefixArgs: [] };
}

/**
 * Wake a ZCode session by running a single-flight `zcode -p "<prompt>" --resume <sessionId>` turn.
 * Sets `AGENTSCHAT_TOOL_ONLY=1` and `AGENTSCHAT_LOCK_OWNER_PID` so the child's MCP server
 * executes tools without opening a competing WebSocket connection or failing the agent lock.
 */
export function fireZcodeWake(msg: WakeMessage, cfg: ZcodeWakeConfig): Promise<boolean> {
  const log = cfg.logger ?? (() => {});
  const sessionId = (cfg.sessionId ?? "").trim();
  if (!sessionId || !SAFE_ZCODE_SESSION_ID_RE.test(sessionId)) {
    log(`[agentchat] zcode wake: missing or unsafe sessionId, skipping`);
    return Promise.resolve(false);
  }

  const prompt = cfg.promptOverride ?? buildWakePrompt(msg, cfg.contextPrefix);
  const prev = zcodeSessionQueues.get(sessionId) ?? Promise.resolve();

  let succeeded = false;
  const runTurn = async (): Promise<void> => {
    try {
      const { cmd, prefixArgs } = await resolveZcodeCommand(cfg.zcodeBin);
      const rawArgs = [...prefixArgs, "-p", prompt, "--resume", sessionId];
      if (cfg.workspacePath && cfg.workspacePath.trim()) {
        const wsPath = cfg.workspacePath.trim();
        if (!wsPath.startsWith("-") && !/[\x00-\x1f\x7f]/.test(wsPath)) {
          rawArgs.push("--cwd", wsPath);
        }
      }
      const env: Record<string, string | undefined> = {
        ...process.env,
        AGENTSCHAT_TOOL_ONLY: "1",
        AGENTSCHAT_LOCK_OWNER_PID: String(cfg.lockOwnerPid ?? process.pid),
        ZCODE_SESSION_ID: sessionId,
        ...(cfg.profileName ? { AGENTSCHAT_PROFILE: cfg.profileName } : {}),
      };
      const resolved = resolveWindowsCliSpawn(cmd, rawArgs, { env });
      const timeoutMs = clampWakeTimerMs(cfg.timeoutMs, 180_000);
      const killGraceMs = clampWakeTimerMs(cfg.killGraceMs, 2000);

      if (cfg.runCommandImpl) {
        const res = await cfg.runCommandImpl(resolved.cmd, resolved.args, { cwd: cfg.workspacePath, env, timeoutMs });
        succeeded = res.code === 0;
        if (!succeeded) {
          log(`[agentchat] zcode wake (${sessionId}) exited with code ${res.code}${res.stderr ? `: ${redactSecrets(res.stderr).slice(0, 200)}` : ""}`);
        }
        return;
      }

      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve) => {
        const child = spawn(resolved.cmd, resolved.args, {
          cwd: cfg.workspacePath || process.cwd(),
          env: env as NodeJS.ProcessEnv,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          if (stderr.length < 500) stderr += String(chunk).slice(0, 500 - stderr.length);
        });
        let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
        const clearTimers = () => {
          clearTimeout(timer);
          if (killGraceTimer) {
            clearTimeout(killGraceTimer);
            killGraceTimer = null;
          }
        };
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {}
          killGraceTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, killGraceMs);
          killGraceTimer.unref?.();
        }, timeoutMs);
        timer.unref?.();
        child.on("error", (err) => {
          clearTimers();
          log(`[agentchat] zcode wake spawn error (${sessionId}): ${redactSecrets(String(err)).slice(0, 200)}`);
          resolve();
        });
        child.on("close", (code) => {
          clearTimers();
          succeeded = code === 0;
          if (!succeeded) {
            log(`[agentchat] zcode wake (${sessionId}) exited code=${code}${stderr ? `: ${redactSecrets(stderr.trim()).slice(0, 200)}` : ""}`);
          }
          resolve();
        });
      });
    } catch (e) {
      log(`[agentchat] zcode wake failed (${sessionId}): ${redactSecrets(String(e)).slice(0, 200)}`);
    }
  };

  const next = prev.then(runTurn, runTurn);
  zcodeSessionQueues.set(sessionId, next);
  return next.then(() => {
    if (zcodeSessionQueues.get(sessionId) === next) {
      zcodeSessionQueues.delete(sessionId);
    }
    return succeeded;
  });
}
