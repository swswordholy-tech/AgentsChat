const OWNER_FORBIDDEN_KEYS = new Set<string>([
  "__proto__",
  "prototype",
  ...Object.getOwnPropertyNames(Object.prototype),
  ...Object.getOwnPropertyNames(Object.prototype).map(k => k.toLowerCase()),
]);
const isOwnerForbiddenKey = (key: string) => OWNER_FORBIDDEN_KEYS.has(key) || OWNER_FORBIDDEN_KEYS.has(key.toLowerCase());

/** URL parsing canonicalizes numeric IPv4 and mapped IPv6 before this check. */
export function blockedServerHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host || host === "0.0.0.0" || /^0\./.test(host) || host === "::" || host === "0:0:0:0:0:0:0:0" ||
    /^169\.254\./.test(host) || host === "100.100.100.200" ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "fd00:ec2::254" || host === "fd00:ec2:0:0:0:0:0:254" ||
    host === "metadata" || host === "instance-data" ||
    host === "metadata.google.internal" || host.endsWith(".metadata.google.internal") ||
    host === "metadata.goog" || host.endsWith(".metadata.goog") ||
    /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    const rawTail = host.slice(7);
    if (rawTail === "0:0" || rawTail === "0.0.0.0") return true;
    const tail = /^0:(?:[0-9a-f]{1,4}:|\d{1,3}\.)/.test(rawTail) ? rawTail.slice(2) : rawTail;
    if (tail === "0:0" || tail === "0.0.0.0" || /^0\./.test(tail) || /^[0-9a-f]{1,2}:[0-9a-f]{1,4}$/.test(tail) ||
      /^127\./.test(tail) || /^7f[0-9a-f]{2}:/.test(tail) ||
      /^169\.254\./.test(tail) || /^a9fe:/.test(tail) ||
      tail === "100.100.100.200" || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(tail) || tail === "6464:64c8") {
      return true;
    }
    const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1]!, 16);
      const lo = parseInt(hexMatch[2]!, 16);
      const firstOctet = (hi >> 8) & 0xff;
      const secondOctet = hi & 0xff;
      if (
        firstOctet === 0 ||
        firstOctet === 127 ||
        (firstOctet === 169 && secondOctet === 254) ||
        (firstOctet === 100 && (secondOctet & 0xc0) === 0x40) ||
        (hi === 0x6464 && lo === 0x64c8)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Read bounded response bytes before decoding or parsing untrusted JSON. */
async function ownerJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing owner response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        // Cancel without awaiting a possibly stalled transport cancellation.
        void reader.cancel().catch(() => {});
        throw new Error("Owner response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Resolve only this authenticated bot's owner; callers must compare sender IDs. */
export async function getBotOwner(
  base: string,
  agentId: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<string | null> {
  try {
    if (!base || base !== base.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(base) ||
      !agentId || agentId !== agentId.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(agentId) ||
      /%(?:2e%2e|2f|5c|00)/i.test(agentId) ||
      agentId === "." || agentId.includes("..") || isOwnerForbiddenKey(agentId) || /[\/\\\s]/.test(agentId) ||
      !token || token !== token.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(token)) return null;
    const parsed = new URL(base);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname.toLowerCase().replace(/\.$/, ""));
    if (blockedServerHost(parsed) || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port === "0") return null;
    const origin = parsed.href.replace(/\/+$/, "");
    const options: RequestInit = {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    };
    const [statusSettled, entitlementSettled] = await Promise.allSettled([
      request(`${origin}/api/account/onboarding`, options),
      request(`${origin}/api/me/entitlements`, options),
    ]);
    const statusResponse = statusSettled.status === "fulfilled" ? statusSettled.value : null;
    const entitlementResponse = entitlementSettled.status === "fulfilled" ? entitlementSettled.value : null;
    if (!statusResponse?.ok || !entitlementResponse?.ok) {
      await Promise.allSettled([
        statusResponse?.body?.cancel(),
        entitlementResponse?.body?.cancel(),
      ]);
      return null;
    }
    const [statusValue, entitlementValue] = await Promise.all([
      ownerJson(statusResponse),
      ownerJson(entitlementResponse),
    ]);
    const status = statusValue as Record<string, unknown> | null;
    const entitlement = entitlementValue as Record<string, unknown> | null;
    if (!status || typeof status !== "object" || Array.isArray(status) || Object.hasOwn(status, "__proto__") || status.agent_id !== agentId || status.claimed !== true) return null;
    if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement) || Object.hasOwn(entitlement, "__proto__")) return null;
    const owner = entitlement.owner_account_id;
    return typeof owner === "string" && owner.trim().length > 0 && owner === owner.trim() &&
      !/[\/\\\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(owner) && !/%(?:2e%2e|2f|5c|00)/i.test(owner) && owner !== agentId &&
      owner !== "." && !owner.includes("..") && !isOwnerForbiddenKey(owner) ? owner : null;
  } catch {
    // Missing endpoints, failed authentication and unavailable ownership all fail closed.
    // Never retain a previous owner or expose response bodies / credentials in diagnostics.
    return null;
  }
}
