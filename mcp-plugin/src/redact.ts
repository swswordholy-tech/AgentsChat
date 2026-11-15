/**
 * Redact sensitive tokens from outgoing message content.
 *
 * Last line of defense against leaking credentials into channel messages
 * or logs (the MCP server instructions forbid sharing ac_ keys / tokens /
 * JWTs). Extracted from server.ts so it can be unit-tested without importing
 * the side-effecting server entrypoint (which connects a WebSocket on load).
 *
 * Covers ac_ API keys and JWTs. Claim URLs / ?key= params / passwords are
 * not yet covered — tracked as a separate hardening finding.
 */
export interface RedactOptions {
  /** When true (same-owner direct channel), preserve `ac_...` keys while still redacting JWTs. */
  preserveAcKeys?: boolean;
}

export function redactSecrets(text: string, opts?: RedactOptions): string {
  if (typeof text !== "string" || !text) return "";
  const step = opts?.preserveAcKeys
    ? text
    : text.replace(/ac_[A-Za-z0-9_-]{16,}/g, "ac_***REDACTED***");
  return step
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
      "***PRIVATE_KEY_REDACTED***",
    )
    .replace(/mcp_(?:at|rt|code)_[A-Za-z0-9_-]{16,}/g, "mcp_***REDACTED***")
    .replace(/agent_key_[A-Za-z0-9_-]{12,}/g, "agent_key_***REDACTED***")
    .replace(/whsec_[A-Za-z0-9_-]{12,}/g, "whsec_***REDACTED***")
    .replace(/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "sk-***REDACTED***")
    .replace(/\brk_(?:live|test)_[A-Za-z0-9]{12,}/g, "rk_***REDACTED***")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, "gh_***REDACTED***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "github_pat_***REDACTED***")
    .replace(/\bglpat-[A-Za-z0-9_-]{12,}/g, "glpat-***REDACTED***")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox-***REDACTED***")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza***REDACTED***")
    .replace(/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "AKIA***REDACTED***")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "***JWT_REDACTED***");
}

const PHONE_PII_RE = /^\+?\d[\d\s()-]{5,}[\d)]$/;

function isPhoneShapedPii(s: string): boolean {
  return PHONE_PII_RE.test(s) && s.replace(/\D/g, "").length >= 7;
}

/**
 * True when an identifier looks like a human login email or phone number
 * rather than an agent handle. Matches the AgentsChat Server PII contract.
 */
export function isHumanPiiHandle(rawId: unknown): boolean {
  const s = String(rawId ?? "").trim();
  if (!s) return false;
  if (s.includes("@")) return true;
  if (isPhoneShapedPii(s)) return true;
  return false;
}

/**
 * Mask human login emails (`user@domain` -> `user:us***`) and phone numbers
 * (`+86 138...99` -> `user:phone_***99`) while preserving non-PII agent handles
 * in full (no 8/12-char truncation).
 */
export function redactParticipantPii(rawId: unknown): string {
  const s = String(rawId ?? "").replace(/[\x00-\x1f\x7f]+/g, "").trim();
  if (!s) return "unknown";
  const atIdx = s.indexOf("@");
  if (atIdx >= 0) {
    const local = s.slice(0, atIdx).replace(/[^a-zA-Z0-9]/g, "");
    return `user:${(local.slice(0, 2) || "u").toLowerCase()}***`;
  }
  if (isPhoneShapedPii(s)) {
    const digits = s.replace(/\D/g, "");
    return `user:phone_***${digits.slice(-2) || "00"}`;
  }
  return s.slice(0, 128);
}
