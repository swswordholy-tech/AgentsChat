import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOnboardingStatus } from "../src/onboarding-status.ts";
import { nonGrokWakeReason, parseGrokBinds, parseGrokBindsText } from "../src/grok-bind.ts";
import { findDefaultProfileCollision, safeWriteProfile } from "../src/profile-store.ts";

describe("Campaign #126 — Onboarding SSRF Parity, Grok-Bind Reserved Basenames & Profile-Store Symlink/.. Hardening", () => {
  test("getOnboardingStatus blocks Aliyun/AWS IPv6/short-host metadata, unspecified hosts, and port :0 without issuing network calls", async () => {
    for (const badBase of [
      "https://100.100.100.200",
      "https://[fd00:ec2::254]",
      "https://[::ffff:100.100.100.200]",
      "https://[::ffff:0:0]",
      "https://[0:0:0:0:0:0:0:0]",
      "https://0.0.0.0",
      "https://metadata",
      "https://instance-data",
      "https://agents-chat.com:0",
      "http://127.0.0.1:0",
    ]) {
      let called = false;
      const res = await getOnboardingStatus(badBase, "agent-126", "ac_testtoken123456", async () => {
        called = true;
        return new Response("{}", { status: 200 });
      });
      expect(called).toBe(false);
      expect(res.authentication).toBe("unknown");
      expect(res.chat_url).toBe("https://agents-chat.com/chat/agent-126");
    }
  });

  test("grok-bind rejects all state/sidecar JSON basenames, flags own __proto__ in parseGrokBindsText, and redacts leaked secrets in nonGrokWakeReason", () => {
    const parsed = parseGrokBinds({
      u1: "RealBot",
      u2: "agy-binds.json",
      u3: "agy-binds.meta",
      u4: "identity-guard.json",
      u5: "cursor.json",
      u6: "read-cursors",
      u7: "mention-timestamps.json",
      u8: "wake-pids",
      u9: "dsh.json",
      u10: "config.json",
      u11: "muse.json",
      u12: "session-binds.meta.json",
      u13: "grok-binds-meta.json",
    });
    expect(parsed).toEqual({ u1: "RealBot" });

    expect(parseGrokBindsText('{"__proto__":"polluted","u1":"RealBot"}')).toEqual({
      binds: { u1: "RealBot" },
      malformed: false,
    });

    const reason = nonGrokWakeReason({
      AGENTCHAT_WAKE_KIND: "url:ac_secretToken1234567890",
    });
    expect(reason).not.toContain("ac_secretToken");
    expect(reason).toContain("REDACTED");
  });

  test("profile-store rejects symlink_dir/.. raw lexical collapse and ignores muse.json / mention-timestamps.json in collision scan", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-prof-126-"));
    try {
      const realDir = join(root, "real");
      const targetDir = join(root, "outside");
      mkdirSync(realDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });
      const symDir = join(root, "sym");
      symlinkSync(targetDir, symDir);

      // Raw unnormalized path traverses through symlinked `sym/..` into `real/bot.json` — must be rejected!
      const collapsedViaSymlink = `${symDir}/../real/bot.json`;
      expect(() => safeWriteProfile(collapsedViaSymlink, { agent_id: "bot-1", token: "ac_123456789" })).toThrow(
        /Refusing to write profile/,
      );

      // Direct clean write into realDir works and non-profile files (`muse.json`, `mention-timestamps.json`) do not trigger false collisions
      const defaultPath = join(realDir, "profile.json");
      safeWriteProfile(defaultPath, {
        agent_id: "agent-default",
        display_name: "muse",
        token: "ac_default123456",
      });
      writeFileSync(
        join(realDir, "muse.json"),
        JSON.stringify({ agent_id: "agent-default", display_name: "muse", token: "ac_other123456" }),
      );
      writeFileSync(
        join(realDir, "mention-timestamps.json"),
        JSON.stringify({ agent_id: "agent-default", token: "ac_other123456" }),
      );
      expect(findDefaultProfileCollision(realDir, defaultPath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
