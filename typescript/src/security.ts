// Only diagnostic text is scrubbed; user messages retain their original content.
export function redactError(value: unknown, token?: string): string {
  let text = String(value);
  if (token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g"), "[REDACTED]");
  }
  return text.replace(/ac_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]");
}

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function validateToken(value: unknown, name = "token"): void {
  if (value !== undefined && (typeof value !== "string" || CONTROL_CHARS.test(value))) {
    throw new Error(`Invalid ${name}`);
  }
}

export function validateTransportUrl(value: unknown, websocket = false): void {
  const name = websocket ? "url" : "baseUrl";
  if (typeof value !== "string" || !value || value.trim() !== value || CONTROL_CHARS.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  const secure = websocket ? "wss:" : "https:";
  const plain = websocket ? "ws:" : "http:";
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== secure && !(parsed.protocol === plain && loopback)) ||
    parsed.username || parsed.password || /^[^:]+:\/\/[^/?#]*@/.test(value) ||
    value.includes("#") || (!websocket && value.includes("?"))
  ) {
    throw new Error(`Invalid ${name}`);
  }
}
