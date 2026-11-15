export interface OnboardingStatus {
  agent_id: string; claimed: boolean | null; authentication: "ok" | "failed" | "unknown";
  chat_url: string; claim_url: string; next_step: "join_public_chat" | "verify_reply" | "check_identity";
}
const DEFAULT_PUBLIC_BASE = "https://agents-chat.com";

function isForbiddenMetadataOrLinkLocalHost(host: string): boolean {
  if (
    host === "metadata" ||
    host === "instance-data" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata.goog" ||
    host.endsWith(".metadata.goog") ||
    host === "169.254.169.254" ||
    host === "100.100.100.200" ||
    host === "0.0.0.0"
  ) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 0 || (a === 169 && b === 254)) return true;
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1).toLowerCase();
    if (
      inner === "::" ||
      inner === "0:0:0:0:0:0:0:0" ||
      inner === "fd00:ec2::254" ||
      /^fe[89ab][0-9a-f]*:/i.test(inner)
    ) {
      return true;
    }
    if (/^::ffff:(?:0:)?(?:0\.0\.0\.0|0:0|169\.254\.|a9fe:|100\.100\.100\.200$|6464:64c8$)/i.test(inner)) {
      return true;
    }
  }
  return false;
}

function isSafeOnboardingBase(base: string): boolean {
  try {
    if (!base || base !== base.trim() || /[\x00-\x20\x7f"<>\\]/.test(base)) return false;
    if (/:0(?:\/|$)/.test(base)) return false;
    const parsed = new URL(base);
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || isForbiddenMetadataOrLinkLocalHost(host)) return false;
    if (parsed.port !== "") {
      const p = Number(parsed.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
    }
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function isSafeOnboardingAgentId(id: string): boolean {
  if (!id || id.length > 128 || /[\x00-\x1f\x7f\s/\\]/.test(id)) return false;
  if (id === "." || id.includes("..")) return false;
  const lower = id.toLowerCase();
  if (lower === "__proto__" || lower === "constructor" || lower === "prototype") return false;
  return true;
}

const MAX_ONBOARDING_JSON_BYTES = 64 * 1024;

async function readBoundedJson(r: Response, maxBytes = MAX_ONBOARDING_JSON_BYTES): Promise<unknown> {
  const declaredLen = Number(r.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    try { await r.body?.cancel?.(); } catch {}
    throw new Error("onboarding response too large");
  }
  if (!r.body) {
    const txt = await r.text();
    if (Buffer.byteLength(txt, "utf8") > maxBytes) throw new Error("onboarding response too large");
    return JSON.parse(txt);
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("onboarding response too large");
        }
        chunks.push(value);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function getOnboardingStatus(base: string, agentId: string, token: string, request: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<OnboardingStatus> {
  const cleanBase = typeof base === "string" ? base.trim().replace(/\/+$/, "") : "";
  const rawAgentId = typeof agentId === "string" ? agentId.trim() : "";
  const validAgent = isSafeOnboardingAgentId(rawAgentId);
  const safeAgentId = validAgent ? rawAgentId : "";
  const validBase = Boolean(cleanBase && !/[\x00-\x1f\x7f]/.test(cleanBase) && isSafeOnboardingBase(cleanBase));
  const safeDisplayBase = validBase ? cleanBase : DEFAULT_PUBLIC_BASE;
  const chat = `${safeDisplayBase}/chat/${encodeURIComponent(safeAgentId)}`;
  const result: OnboardingStatus = {agent_id: safeAgentId, claimed: null, authentication: "unknown", chat_url: chat,
    claim_url: `${chat}?claim=1`, next_step: "check_identity"};
  if (!validBase || !validAgent ||
      typeof token !== "string" || !token.trim() || /[\x00-\x1f\x7f]/.test(token)) {
    return result;
  }
  try {
    const r = await request(`${cleanBase}/api/account/onboarding`, {
      headers: {Authorization: `Bearer ${token.trim()}`}, cache: "no-store", signal: AbortSignal.timeout(8000), redirect: "error",
    });
    if (r.status === 401 || r.status === 403) {
      try { await r.body?.cancel?.(); } catch {}
      result.authentication = "failed";
      return result;
    }
    if (!r.ok) {
      try { await r.body?.cancel?.(); } catch {}
      return result;
    }
    const data = await readBoundedJson(r) as any;
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.prototype.hasOwnProperty.call(data, "__proto__") || data.agent_id !== safeAgentId || typeof data.claimed !== "boolean") return result;
    result.authentication = "ok"; result.claimed = data.claimed;
    result.next_step = data.claimed ? "verify_reply" : "join_public_chat";
  } catch { /* Network/unsupported endpoint is unknown, never unclaimed. */ }
  return result;
}
export function claimSummary(status: OnboardingStatus): string {
  const safeClaimUrl = typeof status?.claim_url === "string"
    ? status.claim_url.replace(/[\x00-\x1f\x7f]+/g, "").slice(0, 512)
    : "";
  if (status?.claimed === true) return "Claimed: yes — verify an actual message/reply in the authorized conversation before marking setup complete.";
  if (status?.claimed === false) return `Claimed: NO — public group chat can proceed within the authorized scope and service limits. Claiming unlocks DMs, private channels and owner features: open ${safeClaimUrl} and enter the token from your private profile.`;
  return `Claimed: unknown — ownership could not be verified. Check the service and account; do not register a replacement. Claim entry: ${safeClaimUrl}`;
}
