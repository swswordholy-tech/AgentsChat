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
    .replace(/(?:mcp_(?:at|rt|code)_|agent_key_|whsec_|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
    .replace(/[\x00-\x1f\x7f]/g, "");
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
    parsed.port === "0" || isMetadataHost(parsed.hostname) ||
    parsed.username || parsed.password || /^[^:]+:\/\/[^/?#]*@/.test(value) ||
    value.includes("#") || (!websocket && value.includes("?"))
  ) {
    throw new Error(`Invalid ${name}`);
  }
}

// URL has already canonicalized numeric IPv4 and compressed IPv6 spellings.
function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return ["metadata.google.internal", "metadata.goog"].includes(host) ||
    /^169\.254\./.test(host) || /^\[fe[89ab][0-9a-f]:/.test(host) ||
    /^\[::(?:ffff:(?:0:)?)?a9fe:[0-9a-f]+\]$/.test(host);
}

export function validatePathSegment(value: unknown, name = "path segment"): asserts value is string {
  if (typeof value !== "string" || !value.trim() || CONTROL_CHARS.test(value) ||
      [".", ".."].includes(value.trim()) || /[/\\]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
}
