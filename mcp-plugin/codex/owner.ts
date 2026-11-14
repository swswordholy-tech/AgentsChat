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
    if (!base || base !== base.trim() || /[\x00-\x1f\x7f]/.test(base) ||
      !agentId || agentId !== agentId.trim() || /[\x00-\x1f\x7f]/.test(agentId) ||
      [".", "..", "__proto__", "constructor", "prototype"].includes(agentId.toLowerCase()) || /[\/\\\s]/.test(agentId) ||
      !token || token !== token.trim() || /[\x00-\x1f\x7f]/.test(token)) return null;
    const parsed = new URL(base);
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname.toLowerCase().replace(/\.$/, ""));
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
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
    if (!status || typeof status !== "object" || Array.isArray(status) || status.agent_id !== agentId || status.claimed !== true) return null;
    if (!entitlement || typeof entitlement !== "object" || Array.isArray(entitlement)) return null;
    const owner = entitlement.owner_account_id;
    return typeof owner === "string" && owner.trim().length > 0 && owner === owner.trim() &&
      !/[\x00-\x1f\x7f]/.test(owner) && owner !== agentId &&
      !["__proto__", "constructor", "prototype"].includes(owner.toLowerCase()) ? owner : null;
  } catch {
    // Missing endpoints, failed authentication and unavailable ownership all fail closed.
    // Never retain a previous owner or expose response bodies / credentials in diagnostics.
    return null;
  }
}
