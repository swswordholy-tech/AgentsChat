import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProfileSelector } from "../src/profile-selection.ts";
import { resolveSessionForAgent } from "../src/session-route.ts";
import {
  acquireAgentLock,
  detectRuntimeSession,
  loadSessionBinds,
  parseSessionBinds,
  readAgentLock,
  removeSessionBind,
  resolveLockDir,
  saveSessionBind,
} from "../src/session-bind.ts";
import { HeartbeatMonitor, WS_OPEN } from "../src/heartbeat.ts";
import { matchesMention } from "../src/mentions.ts";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

describe("Campaign #123 KR3: MCP profile-selection, session-route, session-bind, heartbeat, mentions & timestamps hardening", () => {
  test("projectProfileSelector blocks ancestor symlinks, cloud-metadata/link-local SSRF, expanded credential keys, reserved sidecar stems, and unsafe agent_id", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c123-sel-"));
    try {
      const realProject = join(root, "real-proj");
      mkdirSync(join(realProject, ".agentschat"), { recursive: true });
      const configPath = join(realProject, ".agentschat", "config.json");

      for (const ssrfUrl of [
        "https://169.254.169.254/api",
        "https://metadata.google.internal/api",
        "https://sub.metadata.goog/api",
        "https://[fe80::1]/api",
        "https://[::ffff:169.254.169.254]/api",
      ]) {
        writeFileSync(configPath, JSON.stringify({ profile: "Bot", api_url: ssrfUrl }));
        expect(() => projectProfileSelector(realProject)).toThrow(/Invalid project api_url/);
      }

      for (const credField of ["id_token", "oauth_token", "api_token", "webhook_secret", "cookie"]) {
        writeFileSync(configPath, JSON.stringify({ profile: "Bot", [credField]: "secret-val" }));
        expect(() => projectProfileSelector(realProject)).toThrow(/Credentials must not be stored/);
      }

      writeFileSync(configPath, '{"__proto__":{"polluted":true},"profile":"Bot"}');
      expect(() => projectProfileSelector(realProject)).toThrow(/Credentials must not be stored/);

      for (const sidecar of ["session-binds", "session-binds.json", "grok-binds", "cursor", "codex-bots.JSON"]) {
        writeFileSync(configPath, JSON.stringify({ profile: sidecar }));
        expect(() => projectProfileSelector(realProject)).toThrow(/Invalid project profile/);
      }

      for (const badId of [".", "..", "a/b", "a\\b", "has space", "__proto__", "constructor"]) {
        writeFileSync(configPath, JSON.stringify({ profile: "Bot", agent_id: badId }));
        expect(() => projectProfileSelector(realProject)).toThrow(/Invalid project agent_id/);
      }

      // Ancestor symlink on cwd parent is refused while macOS /var/folders tmpdir works cleanly
      writeFileSync(configPath, JSON.stringify({ profile: "Bot" }));
      expect(projectProfileSelector(realProject)).toEqual({ selector: "Bot", source: "project-config" });

      const symParent = join(root, "sym-parent");
      symlinkSync(realProject, symParent);
      expect(() => projectProfileSelector(symParent)).toThrow(/Refusing symlinked/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolveSessionForAgent blocks ancestor symlinks on configDir and skips reserved sidecar profile names", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c123-route-"));
    try {
      const realCfg = join(root, "real-cfg");
      mkdirSync(join(realCfg, "profiles"), { recursive: true });
      writeFileSync(join(realCfg, "profiles", "Alpha.json"), JSON.stringify({ agent_id: "agent-alpha" }));
      // Even if a sidecar file accidentally contains an agent_id field, routing never resolves a sidecar stem
      writeFileSync(join(realCfg, "cursor.json"), JSON.stringify({ agent_id: "agent-cursor" }));
      writeFileSync(
        join(realCfg, "session-binds.json"),
        JSON.stringify({ "s-alpha": "Alpha", "s-sidecar": "cursor" }),
      );

      expect(resolveSessionForAgent("agent-alpha", { configDir: realCfg })).toEqual({
        sessionId: "s-alpha",
        profileName: "Alpha",
        agentId: "agent-alpha",
      });
      expect(resolveSessionForAgent("agent-cursor", { configDir: realCfg })).toBeUndefined();

      // Ancestor symlink `sym-root/sub` -> `realCfg` is refused
      const symLink = join(root, "sym-cfg");
      symlinkSync(realCfg, symLink);
      expect(resolveSessionForAgent("agent-alpha", { configDir: symLink })).toBeUndefined();

      const wrapperTarget = join(root, "wrap-target");
      mkdirSync(join(wrapperTarget, "inner", "profiles"), { recursive: true });
      writeFileSync(join(wrapperTarget, "inner", "profiles", "Beta.json"), JSON.stringify({ agent_id: "agent-beta" }));
      writeFileSync(join(wrapperTarget, "inner", "session-binds.json"), JSON.stringify({ "s-beta": "Beta" }));
      const symWrap = join(root, "sym-wrap");
      symlinkSync(wrapperTarget, symWrap);
      expect(resolveSessionForAgent("agent-beta", { configDir: join(symWrap, "inner") })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session-bind guards ancestor symlinks, reserved sidecars, own-__proto__ locks, relative AGENTSCHAT_LOCK_DIR, and unsafe detected session IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c123-bind-"));
    try {
      // 1. Relative or dash-prefixed AGENTSCHAT_LOCK_DIR is ignored
      expect(resolveLockDir("/tmp/home-a", { AGENTSCHAT_LOCK_DIR: "rel/locks" })).toContain("agentschat-locks-");
      expect(resolveLockDir("/tmp/home-a", { AGENTSCHAT_LOCK_DIR: "-bad" })).toContain("agentschat-locks-");

      // 2. Ancestor symlink on configDir / lockDir is refused across load, save, remove, acquire, and read
      const targetRoot = join(root, "real-target");
      mkdirSync(join(targetRoot, "cfg"), { recursive: true });
      mkdirSync(join(targetRoot, "locks"), { recursive: true });
      writeFileSync(join(targetRoot, "cfg", "session-binds.json"), JSON.stringify({ "s-1": "SafeBot" }));

      const symParent = join(root, "sym-parent");
      symlinkSync(targetRoot, symParent);
      const viaSymCfg = join(symParent, "cfg");
      const viaSymLocks = join(symParent, "locks");

      expect(loadSessionBinds(viaSymCfg)).toEqual({});
      saveSessionBind(viaSymCfg, "s-2", "InjectedBot");
      expect(removeSessionBind(viaSymCfg, "s-1")).toBe(false);
      expect(JSON.parse(readFileSync(join(targetRoot, "cfg", "session-binds.json"), "utf8"))).toEqual({
        "s-1": "SafeBot",
      });
      expect(acquireAgentLock({ lockDir: viaSymLocks, agentId: "agent-x", currentPid: process.pid })).toBeNull();

      // 3. Own __proto__ lock file is rejected
      const cleanLocks = join(root, "clean-locks");
      mkdirSync(cleanLocks, { recursive: true });
      writeFileSync(
        join(cleanLocks, "agent-proto.lock"),
        '{"__proto__":{"polluted":true},"pid":12345,"agentId":"agent-proto","updatedAt":"2026-11-15T00:00:00Z"}',
      );
      expect(readAgentLock(cleanLocks, "agent-proto")).toBeNull();

      // 4. Sidecar profile names and path traversal profile names are rejected in parseSessionBinds & saveSessionBind
      expect(
        parseSessionBinds({
          s1: "session-binds",
          s2: "cursor.json",
          s3: "../outside",
          s4: ".",
          "..": "ValidBot",
          s5: "LegitBot",
        }),
      ).toEqual({ s5: "LegitBot" });

      const cleanCfg = join(root, "clean-cfg");
      mkdirSync(cleanCfg, { recursive: true });
      saveSessionBind(cleanCfg, "s-side", "grok-binds");
      saveSessionBind(cleanCfg, "..", "LegitBot");
      expect(loadSessionBinds(cleanCfg)).toEqual({});

      // 5. detectRuntimeSession ignores poisoned env / _meta session IDs & control-char workspace paths
      expect(detectRuntimeSession({ ZCODE_SESSION_ID: "bad\nsid", CLAUDE_CODE_SESSION_ID: "claude-clean", CLAUDE_PROJECT_DIR: "/ok\x00bad" })).toEqual({
        runtime: "claude-code",
        sessionId: "claude-clean",
      });
      expect(detectRuntimeSession({ ANTIGRAVITY_CONVERSATION_ID: "__proto__" })).toBeNull();
      expect(detectRuntimeSession({ AGENTSCHAT_SESSION_ID: "../evil" })).toBeNull();
      expect(
        detectRuntimeSession(
          { ZCODE_SESSION_ID: "z-valid" },
          { session_id: "constructor", workspace_path: "-bad-flag" },
        ),
      ).toEqual({
        runtime: "zcode",
        sessionId: "z-valid",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("HeartbeatMonitor.tick catches throwing getReadyState(), matchesMention rejects dot/slash/proto IDs, and normalizeTimestampForCursor guards C0/DEL & year rollover", () => {
    let reconnects = 0;
    const hb = new HeartbeatMonitor({
      sendPing: () => {},
      reconnect: () => {
        reconnects += 1;
      },
      getReadyState: () => {
        if (reconnects === 0) throw new Error("socket wrapper disposed");
        return WS_OPEN;
      },
    });
    expect(() => hb.tick()).not.toThrow();
    expect(reconnects).toBe(1);

    for (const unsafeMentionId of [".", "..", "a/b", "a\\b", "a b", "__proto__", "constructor", "prototype"]) {
      expect(matchesMention(`hello @${unsafeMentionId} and @Name(${unsafeMentionId})`, unsafeMentionId)).toBe(false);
    }
    expect(matchesMention("hello @Name(a.b+c(d))", "a.b+c(d)")).toBe(true);

    // Control chars rejected, invalid mode passed through safely, and year <0 / >9999 offset rollover never corrupts slice(0, 19)
    expect(normalizeTimestampForCursor("2026-04-15T10:00:00Z\x00", "after")).toBeUndefined();
    expect(normalizeTimestampForCursor("2026-04-15T10:00:00Z", "invalid" as any)).toBe("2026-04-15T10:00:00Z");
    expect(normalizeTimestampForCursor("0000-01-01T02:00:00+08:00", "after")).toBe("0000-01-01T02:00:00+08:00");
    expect(normalizeTimestampForCursor("9999-12-31T23:00:00-05:00", "after")).toBe("9999-12-31T23:00:00-05:00");
    expect(normalizeTimestampForCursor(" 2026-04-15T10:00:00Z ", "after")).toBe("2026-04-15T10:00:00.000000000Z");
  });
});
