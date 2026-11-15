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
    .replace(/(?:mcp_(?:at|rt|code)_|agent_key_|whsec_|gh[pousr]_|github_pat_|glpat-|rk_(?:live|test)_|xox[baprs]-|(?:hf|npm)_)[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]+:[^\s/@"'<>]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[^\s"'<>]+/gi, "$1 [REDACTED]")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;
const PROTOTYPE_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PATH_SEGMENT_LEN = 256;

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

export function isValidTransportUrl(value: unknown, websocket = false): value is string {
  try {
    validateTransportUrl(value, websocket);
    return true;
  } catch {
    return false;
  }
}

// URL has already canonicalized numeric IPv4 and compressed IPv6 spellings.
function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "0.0.0.0" ||
    host === "[::]" ||
    host === "[0:0:0:0:0:0:0:0]" ||
    host === "100.100.100.200" ||
    host === "[fd00:ec2::254]" ||
    host === "metadata" ||
    host === "instance-data" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata.goog" ||
    host.endsWith(".metadata.goog")
  ) {
    return true;
  }
  return (
    /^169\.254\./.test(host) ||
    /^\[fe[89ab][0-9a-f]:/.test(host) ||
    /^\[(?:::(?:ffff:(?:0:)?)?|(?:0+:){2,6}(?:ffff:(?:0+:)?|0+:)?)(?:a9fe:[0-9a-f]{1,4}|169\.254\.\d{1,3}\.\d{1,3}|6464:64c8|100\.100\.100\.200|0(?::0)?|0\.0\.0\.0)\]$/.test(host)
  );
}

export function validatePathSegment(value: unknown, name = "path segment"): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${name}`);
  }
  const trimmed = value.trim();
  if (
    !trimmed ||
    value.length > MAX_PATH_SEGMENT_LEN ||
    CONTROL_CHARS.test(value) ||
    trimmed === "." ||
    trimmed === ".." ||
    PROTOTYPE_PATH_KEYS.has(trimmed.toLowerCase()) ||
    /[/\\]/.test(value) ||
    /%2f|%5c|%00|%2e%2e/i.test(value)
  ) {
    throw new Error(`Invalid ${name}`);
  }
}
