export interface OnboardingStatus {
  agent_id: string; claimed: boolean | null; authentication: "ok" | "failed" | "unknown";
  chat_url: string; claim_url: string; next_step: "join_public_chat" | "verify_reply" | "check_identity";
}
function isSafeOnboardingBase(base: string): boolean {
  try {
    const parsed = new URL(base);
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return true;
  } catch {
    return false;
  }
}
export async function getOnboardingStatus(base: string, agentId: string, token: string, request: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<OnboardingStatus> {
  const cleanBase = typeof base === "string" ? base.trim().replace(/\/+$/, "") : "";
  const safeAgentId = typeof agentId === "string" ? agentId.trim() : "";
  const chat = `${cleanBase}/chat/${encodeURIComponent(safeAgentId)}`;
  const result: OnboardingStatus = {agent_id: safeAgentId, claimed: null, authentication: "unknown", chat_url: chat,
    claim_url: `${chat}?claim=1`, next_step: "check_identity"};
  if (!cleanBase || !safeAgentId || /[\x00-\x1f\x7f]/.test(cleanBase) || /[\x00-\x1f\x7f]/.test(safeAgentId) ||
      typeof token !== "string" || !token.trim() || /[\x00-\x1f\x7f]/.test(token) || !isSafeOnboardingBase(cleanBase)) {
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
    const data = await r.json() as any;
    if (!data || typeof data !== "object" || data.agent_id !== safeAgentId || typeof data.claimed !== "boolean") return result;
    result.authentication = "ok"; result.claimed = data.claimed;
    result.next_step = data.claimed ? "verify_reply" : "join_public_chat";
  } catch { /* Network/unsupported endpoint is unknown, never unclaimed. */ }
  return result;
}
export function claimSummary(status: OnboardingStatus): string {
  if (status.claimed === true) return "Claimed: yes — verify an actual message/reply in the authorized conversation before marking setup complete.";
  if (status.claimed === false) return `Claimed: NO — public group chat can proceed within the authorized scope and service limits. Claiming unlocks DMs, private channels and owner features: open ${status.claim_url} and enter the token from your private profile.`;
  return `Claimed: unknown — ownership could not be verified. Check the service and account; do not register a replacement. Claim entry: ${status.claim_url}`;
}
