/**
 * Connector-side relay upgrade-token auth. EXPERIMENTAL.
 *
 * This is the CONNECTOR half of the HMAC scheme the gateway implements in
 * `gateway/relay/auth.py` (which in turn mirrors the reference connector's
 * `relayAuthToken.ts`). The wire bytes must match both exactly:
 *
 *   token   = base64url(f"{payload}:{exp}:{sig}")   — unpadded
 *   sig     = HMAC_SHA256(f"{payload}:{exp}", secret).hexdigest()
 *   payload = gateway_id
 *
 * The gateway sends it as `Authorization: Bearer <token>` on the `/relay`
 * WebSocket upgrade. We peek the gateway_id (the payload head) to select the
 * secret verify list for that gateway, then verify the signature against that
 * gateway's stored secret(s) — a multi-secret rotation window so a rotation
 * never invalidates an outstanding token.
 *
 * EXPERIMENTAL: the relay contract may change without a deprecation cycle until
 * ≥2 Class-1 platforms validate it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Application close code the connector sends when upgrade auth fails (contract §6.1). */
export const CLOSE_UNAUTHORIZED = 4401;

/** Default upgrade-token TTL the gateway uses (mirrors auth.py `_DEFAULT_UPGRADE_TTL_SECONDS`). */
export const DEFAULT_UPGRADE_TTL_SECONDS = 300;

function hmacHex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** HMAC-SHA256 hex digest — the connector's `sign` (mirrors auth.py `sign`). */
export function sign(payload: string, secret: string): string {
  return hmacHex(payload, secret);
}

/** Constant-time check that `sigHex` is a valid HMAC of `payload` under ANY of `secrets`. */
export function verifySignature(payload: string, sigHex: string, secrets: readonly string[]): boolean {
  if (typeof payload !== "string" || !Array.isArray(secrets)) return false;
  if (typeof sigHex !== "string" || !/^[0-9a-f]{64}$/i.test(sigHex)) return false;
  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(sigHex, "hex");
  } catch {
    return false;
  }
  if (sigBuf.length === 0) return false;
  for (const secret of secrets) {
    if (
      typeof secret !== "string" ||
      secret.length === 0 ||
      secret.length > 8192 ||
      DISALLOWED_TOKEN_PAYLOAD_CTRL_RE.test(secret)
    ) {
      continue;
    }
    const expected = Buffer.from(hmacHex(payload, secret), "hex");
    if (expected.length !== sigBuf.length) continue; // no timing leak on length
    if (timingSafeEqual(sigBuf, expected)) return true;
  }
  return false;
}

/**
 * Build a signed, optionally-expiring token (mirrors auth.py `make_token`).
 * `base64url(f"{payload}:{exp}:{sig}")`, unpadded; `exp` is unix-seconds, 0 = never.
 */
const DISALLOWED_TOKEN_PAYLOAD_CTRL_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const PROTOTYPE_PAYLOAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STRICT_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function makeToken(payload: string, secret: string, ttlSeconds = 0): string {
  if (
    typeof payload !== "string" ||
    payload.length > 8192 ||
    DISALLOWED_TOKEN_PAYLOAD_CTRL_RE.test(payload) ||
    PROTOTYPE_PAYLOAD_KEYS.has(payload.toLowerCase())
  ) {
    throw new Error("invalid token payload");
  }
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    secret.length > 8192 ||
    DISALLOWED_TOKEN_PAYLOAD_CTRL_RE.test(secret)
  ) {
    throw new Error("invalid token secret");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
    throw new RangeError("ttlSeconds must be finite and non-negative");
  }
  const exp = ttlSeconds > 0 ? Math.ceil(Math.floor(Date.now() / 1000) + ttlSeconds) : 0;
  if (!Number.isSafeInteger(exp)) throw new RangeError("expiration exceeds safe integer range");
  const signed = `${payload}:${exp}`;
  const sig = hmacHex(signed, secret);
  return Buffer.from(`${signed}:${sig}`, "utf8").toString("base64url");
}

/** The WS-upgrade bearer a gateway sends: `payload = gateway_id` (mirrors `make_upgrade_token`). */
export function makeUpgradeToken(
  gatewayId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_UPGRADE_TTL_SECONDS,
): string {
  return makeToken(gatewayId, secret, ttlSeconds);
}

/**
 * Verify a token from `make_token`; return the payload (gateway_id) or null.
 * Splits from the right so a payload may contain colons; rejects expired tokens and
 * any signature not matching a secret in the verify list.
 */
export function verifyToken(token: string, secrets: readonly string[]): string | null {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    !STRICT_BASE64URL_RE.test(token) ||
    !Array.isArray(secrets)
  ) {
    return null;
  }
  let decoded: string;
  try {
    const rawBuf = Buffer.from(token, "base64url");
    if (rawBuf.toString("base64url") !== token) return null;
    decoded = rawBuf.toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length < 3) return null;
  const sig = parts[parts.length - 1];
  const expText = parts[parts.length - 2];
  if (!/^\d+$/.test(expText)) return null;
  const exp = Number(expText);
  if (!Number.isSafeInteger(exp) || String(exp) !== expText) return null;
  const payload = parts.slice(0, -2).join(":");
  if (
    DISALLOWED_TOKEN_PAYLOAD_CTRL_RE.test(payload) ||
    PROTOTYPE_PAYLOAD_KEYS.has(payload.toLowerCase())
  ) {
    return null;
  }
  if (exp !== 0 && Math.floor(Date.now() / 1000) > exp) return null;
  const signed = `${payload}:${exp}`;
  return verifySignature(signed, sig, secrets) ? payload : null;
}

/** Verify an upgrade token against the verify list for a gateway; alias for clarity at call sites. */
export function verifyUpgradeToken(token: string, secrets: readonly string[]): string | null {
  return verifyToken(token, secrets);
}
