/**
 * Identity guard — loud alarm when the identity a process boots INTO differs from
 * the identity this machine's MCP was previously trusted as.
 *
 * Production incident 2026-09-27 (task_muk0154j_pstaosfn): a game-team agent ran
 * under the `Antigravity-2` profile (chevron). The hub bounced the WS, the host
 * respawned the MCP process, and the respawn — missing the original selector —
 * resolved the DEFAULT profile (`Antigravity.json`, academic). Nothing said
 * anything; evidence went out under the wrong identity and a human spent 40
 * minutes untangling it. The platform side delivered correctly; the only defect
 * was the client silently wearing a different identity after a reconnect/restart.
 *
 * Model: persist a small trust record (per config dir, mode 0600) of the last
 * TRUSTED identity. On boot, compare the freshly-resolved identity against it:
 *
 *   - first boot / same identity           → ok, record updates
 *   - explicit selector, identity changed  → warn (loud stderr; likely an
 *                                            intentional profile edit — but it
 *                                            must never be silent either)
 *   - resolved via the DEFAULT path and the identity differs from the last
 *     trusted one                          → GATE: loud stderr AND write tools
 *                                            refuse until whoami confirms. This
 *                                            is the incident pattern — an
 *                                            explicit identity silently falling
 *                                            back to the default profile.
 *
 * A gated boot does NOT advance the trust record (repeated respawns into the
 * wrong identity must keep alarming, not learn it). The record advances on
 * confirmation (whoami) or an explicit in-process switch_profile.
 *
 * The guard never changes profile resolution precedence (env > argv > default),
 * never registers anything, and is host-agnostic (pure decision + fs in the
 * caller). All functions here are pure; server.ts wires the I/O.
 */

export interface GuardIdentity {
  agentId: string;
  /** The resolveProfile() source: env | legacy-env | flag-profile | flag-name | grok-bind | default | env-creds. */
  source: string;
  /** The declared selector name when one was given (env/flag/grok-bind). */
  declaredName?: string;
}

export interface IdentityGuardRecord {
  /** declaredName → agent_id, for explicit-selector boots. */
  bySelector: Record<string, string>;
  /** The last identity that was TRUSTED (confirmed or explicitly switched to). */
  lastEffective: { agentId: string; source: string; declaredName?: string; ts: string } | null;
}

export type GuardVerdict =
  | { kind: "ok" }
  | { kind: "warn"; message: string }
  | { kind: "gate"; message: string };

import { redactSecrets } from "./redact.ts";

export const IDENTITY_GUARD_FILENAME = "identity-guard.json";
const MAX_GUARD_SELECTORS = 256;

export function emptyGuardRecord(): IdentityGuardRecord {
  return { bySelector: {}, lastEffective: null };
}

function isUnsafeSelectorKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === "__proto__" || lower === "constructor" || lower === "prototype";
}

function cleanDisplayToken(raw: unknown, maxLen = 128): string {
  if (typeof raw !== "string") return "";
  return redactSecrets(raw)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[REDACTED]")
    .replace(/\b(?:agent_key_|sk-|whsec_|gh[pousr]_|github_pat_|AIza|(?:AKIA|ASIA))[A-Za-z0-9_+/=.-]{8,}/g, "[REDACTED]")
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .trim()
    .slice(0, maxLen);
}

/** Parse a persisted record; anything unreadable/malformed is an empty record (never blocks boot). */
export function parseGuardRecord(text: string | null): IdentityGuardRecord {
  if (!text || typeof text !== "string" || text.length > 262_144) return emptyGuardRecord();
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.prototype.hasOwnProperty.call(raw, "__proto__")) {
      return emptyGuardRecord();
    }
    const bySelector: Record<string, string> = {};
    if (
      raw.bySelector &&
      typeof raw.bySelector === "object" &&
      !Array.isArray(raw.bySelector)
    ) {
      for (const [k, v] of Object.entries(raw.bySelector as Record<string, unknown>)) {
        if (Object.keys(bySelector).length >= MAX_GUARD_SELECTORS) break;
        if (/[\x00-\x1f\x7f]/.test(k) || typeof v !== "string" || /[\x00-\x1f\x7f]/.test(v)) continue;
        const key = k.trim();
        const val = v.trim();
        if (!key || key.length > 128 || isUnsafeSelectorKey(key) || !val || val.length > 128) continue;
        bySelector[key] = val;
      }
    }
    const rawLast = raw.lastEffective;
    const validRawLast =
      rawLast &&
      typeof rawLast === "object" &&
      !Array.isArray(rawLast) &&
      !Object.prototype.hasOwnProperty.call(rawLast, "__proto__");
    const cleanAgentId =
      validRawLast && typeof rawLast.agentId === "string"
        ? cleanDisplayToken(rawLast.agentId, 128)
        : "";
    const cleanDecl =
      validRawLast && rawLast.declaredName
        ? cleanDisplayToken(String(rawLast.declaredName), 128)
        : "";
    return {
      bySelector,
      lastEffective:
        cleanAgentId.length > 0 && !isUnsafeSelectorKey(cleanAgentId)
          ? {
              agentId: cleanAgentId,
              source: cleanDisplayToken(String(rawLast.source ?? "unknown"), 64) || "unknown",
              ...(cleanDecl ? { declaredName: cleanDecl } : {}),
              ts: cleanDisplayToken(String(rawLast.ts ?? ""), 64),
            }
          : null,
    };
  } catch {
    return emptyGuardRecord();
  }
}

/**
 * The boot-time verdict. `current.agentId` may be empty (anonymous mode) — the
 * guard only speaks when there IS an identity to protect, so empty → ok.
 */
export function decideIdentityGuard(prev: IdentityGuardRecord, current: GuardIdentity): GuardVerdict {
  if (!current.agentId) return { kind: "ok" };
  const last = prev.lastEffective;
  if (!last) return { kind: "ok" }; // first recorded boot — nothing to drift from
  if (last.agentId === current.agentId) return { kind: "ok" };

  const safeLastId = cleanDisplayToken(last.agentId, 128);
  const safeLastSrc = cleanDisplayToken(last.source, 64) || "unknown";
  const safeLastDecl = last.declaredName ? cleanDisplayToken(last.declaredName, 128) : "";
  const safeCurId = cleanDisplayToken(current.agentId, 128);

  if (current.source === "default") {
    // THE incident pattern: we used to run as X (possibly via an explicit
    // selector), and this boot silently landed on the default profile Y.
    return {
      kind: "gate",
      message:
        `IDENTITY CHANGED after reconnect/restart: previously trusted as "${safeLastId}" ` +
        `(via ${safeLastSrc}${safeLastDecl ? ` "${safeLastDecl}"` : ""}), but this boot resolved the DEFAULT profile ` +
        `"${safeCurId}". Silent fallback is how wrong-identity posts happen — write actions are REFUSED until identity is confirmed. ` +
        `Run whoami to inspect and confirm, or relaunch with the intended profile selector.`,
    };
  }

  const prevSelectorAgent =
    current.declaredName &&
    !isUnsafeSelectorKey(current.declaredName) &&
    Object.hasOwn(prev.bySelector, current.declaredName)
      ? prev.bySelector[current.declaredName]
      : undefined;
  if (current.declaredName && typeof prevSelectorAgent === "string" && prevSelectorAgent !== current.agentId) {
    // Same selector, different identity: the profile file behind the selector
    // changed (likely an intentional edit). Loud, but not gated.
    const safeCurDecl = cleanDisplayToken(current.declaredName, 128);
    const safePrevSel = cleanDisplayToken(prevSelectorAgent, 128);
    return {
      kind: "warn",
      message:
        `identity for selector "${safeCurDecl}" changed: was "${safePrevSel}", ` +
        `now "${safeCurId}". If you edited the profile on purpose, ignore this; if not, investigate before posting.`,
    };
  }

  // A different explicit identity than last time (operator launched a different
  // profile on purpose). A bare mention is enough — this is normal multi-profile use.
  return { kind: "ok" };
}

/**
 * Advance the record toward `current`. `trusted` = the identity may become the
 * new lastEffective (boot ok/warn, whoami confirmation, explicit switch_profile);
 * a gated boot passes trusted=false so the record keeps pointing at the LAST
 * TRUSTED identity and the alarm keeps firing on repeat respawns.
 */
export function advanceGuardRecord(
  prev: IdentityGuardRecord,
  current: GuardIdentity,
  ts: string,
  trusted: boolean,
): IdentityGuardRecord {
  const next: IdentityGuardRecord = { bySelector: { ...prev.bySelector }, lastEffective: prev.lastEffective };
  if (!current.agentId) return next;
  if (current.declaredName && !isUnsafeSelectorKey(current.declaredName)) {
    if (!Object.hasOwn(next.bySelector, current.declaredName) && Object.keys(next.bySelector).length >= MAX_GUARD_SELECTORS) {
      const oldestKey = Object.keys(next.bySelector)[0];
      if (oldestKey !== undefined) delete next.bySelector[oldestKey];
    }
    next.bySelector[current.declaredName] = current.agentId;
  }
  if (trusted) {
    next.lastEffective = {
      agentId: current.agentId,
      source: current.source,
      ...(current.declaredName ? { declaredName: current.declaredName } : {}),
      ts,
    };
  }
  return next;
}

// ── Expected agent id pin (AGENTCHAT_EXPECT_AGENT_ID) ────────────────────────
// Root cause found on a multi-bot box after the 2026-09-27 incident: the host
// (agy) spawned its agentschat MCP from ONE host-wide config carrying an explicit
// `--profile <OneBot>`, so every other bot's wake booted as that bot. That is an
// explicit selector, so the trust-record guard above stays quiet. A per-bot
// launcher can additionally pin the agent id it expects; when set and the live
// identity differs, write tools refuse (reads, whoami and switch_profile stay
// open so the agent can see and fix it). Optional: unset = no behaviour change.

/** Env names, canonical plural first (wins when both are set). */
export const EXPECT_AGENT_ID_ENV = ["AGENTSCHAT_EXPECT_AGENT_ID", "AGENTCHAT_EXPECT_AGENT_ID"] as const;

export function expectedAgentIdFromEnv(env: Record<string, string | undefined>): string | null {
  for (const k of EXPECT_AGENT_ID_ENV) {
    const v = (env[k] ?? "").trim();
    if (v) return v;
  }
  return null;
}

/** Tools that must stay callable while the expected-id pin is violated. */
export const EXPECT_PIN_EXEMPT_TOOLS = new Set(["whoami", "switch_profile", "connect_profile", "disconnect_profile"]);

/**
 * Error text when the live identity violates the expected pin, else null.
 * Never includes tokens.
 */
export function expectedAgentIdViolation(expected: string | null, liveAgentId: string): string | null {
  if (!expected) return null;
  if (liveAgentId === expected) return null;
  const safeLive = cleanDisplayToken(liveAgentId, 128) || "(none)";
  const safeExpected = cleanDisplayToken(expected, 128) || "(invalid-pin)";
  return (
    `IDENTITY PIN: this MCP process is "${safeLive}" but AGENTCHAT_EXPECT_AGENT_ID is "${safeExpected}". ` +
    `Write tools are refused so nothing posts under the wrong identity. ` +
    `Call switch_profile with the profile for ${safeExpected} (then whoami), or relaunch with the correct --profile / AGENTSCHAT_PROFILE.`
  );
}
