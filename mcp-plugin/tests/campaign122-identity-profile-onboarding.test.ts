import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDefaultProfileCollision, safeWriteProfile } from "../src/profile-store.ts";
import { decideIdentity, validateIdentityProfile } from "../src/identity.ts";
import { advanceGuardRecord, decideIdentityGuard, emptyGuardRecord, expectedAgentIdViolation, parseGuardRecord } from "../src/identity-guard.ts";
import { claimSummary, getOnboardingStatus } from "../src/onboarding-status.ts";

describe("Campaign #122 KR3: profile-store, identity, identity-guard & onboarding-status hardening", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "c122-kr3-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("profile-store blocks ancestor symlink directories, scrubs credentials in warnings, and ignores own-__proto__ / sidecar JSONs", () => {
    const outsideRoot = join(dir, "outside");
    mkdirSync(join(outsideRoot, "profiles"), { recursive: true });
    const symConfig = join(dir, "sym-agentschat");
    symlinkSync(outsideRoot, symConfig);

    // Immediate parent (`.../profiles`) is a real directory inside `outside`, but ancestor `sym-agentschat` is a symlink!
    expect(() => safeWriteProfile(join(symConfig, "profiles", "Bot.json"), { token: "ac_secret" })).toThrow(
      /invalid or symlinked parent directory/i,
    );

    // Secret in path/error is redacted before hitting warn callback
    const secretPath = join(dir, "ac_supersecrettoken123456.json");
    mkdirSync(secretPath + ".tmp");
    const warnings: string[] = [];
    expect(() => safeWriteProfile(secretPath, { token: "ac_x" }, (m) => warnings.push(m))).toThrow();
    expect(warnings.join("")).not.toContain("ac_supersecrettoken123456");

    // findDefaultProfileCollision skips sidecars & own-__proto__ payloads and rejects ancestor symlinks
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    const defPath = join(cfg, "profile.json");
    writeFileSync(defPath, JSON.stringify({ agent_id: "bot_1", display_name: "Bot 1", token: "ac_1" }));
    writeFileSync(
      join(cfg, "wake-pids.json"),
      JSON.stringify({ agent_id: "bot_1", display_name: "Bot 1", token: "ac_2" }),
    );
    writeFileSync(
      join(cfg, "ProtoShadow.json"),
      '{"__proto__":{"polluted":1},"agent_id":"bot_1","display_name":"Bot 1","token":"ac_3"}',
    );
    expect(findDefaultProfileCollision(cfg, defPath)).toBeNull();
    expect(findDefaultProfileCollision(join(symConfig, "profiles"), defPath)).toBeNull();
  });

  test("identity & identity-guard scrub secrets in diagnostic messages, reject own-__proto__, and bound selector map", () => {
    const dec = decideIdentity({
      profileExists: false,
      source: "flag-profile",
      profileFile: "/tmp/ac_leakedtoken1234567890.json",
      declaredName: "Bearer my_secret_token_value_1234",
      hasToken: false,
      fallbackName: "Bot",
    });
    expect(dec.mode).toBe("error");
    if (dec.mode === "error") {
      expect(dec.message).not.toContain("ac_leakedtoken1234567890");
      expect(dec.message).not.toContain("my_secret_token_value_1234");
    }

    const protoProfile = JSON.parse('{"__proto__":{"x":1},"agent_id":"bot_1","token":"ac_valid_token"}');
    expect(() => validateIdentityProfile(protoProfile, "/tmp/p.json")).toThrow(/Invalid identity profile/);

    expect(parseGuardRecord('{"__proto__":{"x":1},"bySelector":{"a":"b"},"lastEffective":null}')).toEqual(
      emptyGuardRecord(),
    );

    let rec = emptyGuardRecord();
    for (let i = 0; i < 300; i++) {
      rec = advanceGuardRecord(rec, { agentId: `bot_${i}`, source: "flag-profile", declaredName: `sel_${i}` }, "2026-11-15T00:00:00Z", true);
    }
    expect(Object.keys(rec.bySelector).length).toBeLessThanOrEqual(256);

    const guardMsg = decideIdentityGuard(
      {
        bySelector: {},
        lastEffective: { agentId: "ac_secret_prev_1234567890", source: "flag-profile", ts: "2026-11-15T00:00:00Z" },
      },
      { agentId: "bot_now", source: "default" },
    );
    expect(guardMsg.kind).toBe("gate");
    if (guardMsg.kind === "gate") {
      expect(guardMsg.message).not.toContain("ac_secret_prev_1234567890");
    }

    const pinErr = expectedAgentIdViolation("agent_key_secret1234567890", "bot_live");
    expect(pinErr).not.toContain("agent_key_secret1234567890");
  });

  test("onboarding-status blocks cloud metadata/link-local SSRF, falls back claim_url safely when base is unsafe, and rejects own-__proto__", async () => {
    for (const badBase of [
      "javascript:alert(1)",
      "https://169.254.169.254",
      "https://metadata.google.internal",
      "https://metadata.goog",
      "https://sub.metadata.goog",
      "https://[fe80::1]",
      "https://[::ffff:169.254.169.254]",
      "https://user:secret@example.com",
    ]) {
      let called = false;
      const st = await getOnboardingStatus(badBase, "safe-bot", "ac_private", async () => {
        called = true;
        return Response.json({ agent_id: "safe-bot", claimed: true });
      });
      expect(called).toBe(false);
      expect(st.claimed).toBeNull();
      expect(st.chat_url).toBe("https://agents-chat.com/chat/safe-bot");
      expect(st.claim_url).toBe("https://agents-chat.com/chat/safe-bot?claim=1");
      expect(claimSummary(st)).not.toContain("javascript:");
      expect(claimSummary(st)).not.toContain("169.254");
      expect(claimSummary(st)).not.toContain("user:secret");
    }

    const protoResStatus = await getOnboardingStatus("https://example.com", "safe-bot", "ac_private", async () => {
      return new Response('{"__proto__":{"polluted":1},"agent_id":"safe-bot","claimed":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(protoResStatus.claimed).toBeNull();
    expect(protoResStatus.authentication).toBe("unknown");
  });
});
