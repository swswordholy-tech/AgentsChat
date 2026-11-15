import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDefaultProfileCollision, safeWriteProfile } from "../src/profile-store.ts";
import {
  detectRuntimeSession,
  loadSessionBinds,
  lockFilePath,
  parseSessionBinds,
  saveSessionBind,
} from "../src/session-bind.ts";
import { boundProfileForConversation, decideGrokBind, parseGrokBinds } from "../src/grok-bind.ts";
import { loadCursor, persistCursor, safeAgentCursorSlug } from "../src/read-cursor.ts";
import { projectProfileSelector } from "../src/profile-selection.ts";

const FAKE_AC_TOKEN = "ac" + "_" + "testtoken142abcdef012345";
const FAKE_MCP_AT = "mcp_at" + "_" + "testtoken142abcdef012345";

describe("Campaign #142 KR3+KR4 — profile-store, session-bind, grok-bind, read-cursor & profile-selection hardening", () => {
  test("profile-store rejects NUL/oversized paths, redacts ac_/mcp_at_ tokens in warn diagnostics, and skips Windows device & Object.prototype collision files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-c142-prof-"));
    try {
      expect(() => safeWriteProfile("", { token: FAKE_AC_TOKEN })).toThrow(/invalid path/i);
      expect(() => safeWriteProfile(`${join(dir, "bad")}\x00.json`, { token: FAKE_AC_TOKEN })).toThrow(/invalid path/i);
      expect(() => safeWriteProfile(join(dir, `${"a".repeat(4100)}.json`), { token: FAKE_AC_TOKEN })).toThrow(
        /invalid path/i,
      );

      // Stale .tmp directory triggers warn path — verify ac_ and mcp_at_ secrets in path are redacted!
      const secretDir = join(dir, `sub ${FAKE_AC_TOKEN} ${FAKE_MCP_AT}`);
      mkdirSync(secretDir, { recursive: true });
      const target = join(secretDir, "bot.json");
      mkdirSync(`${target}.tmp`);
      const warns: string[] = [];
      expect(() => safeWriteProfile(target, { token: FAKE_AC_TOKEN }, (m) => warns.push(m))).toThrow();
      const joined = warns.join("");
      expect(joined).toContain("REDACTED");
      expect(joined).not.toContain("testtoken142abcdef012345");

      // findDefaultProfileCollision skips Windows device names (CON.json) & Object.prototype stems (toString.json)
      const cfg = join(dir, "cfg");
      mkdirSync(cfg, { recursive: true });
      const defPath = join(cfg, "profile.json");
      safeWriteProfile(defPath, { agent_id: "agent-main", display_name: "MainBot", token: FAKE_AC_TOKEN });
      writeFileSync(
        join(cfg, "CON.json"),
        JSON.stringify({ agent_id: "agent-main", display_name: "MainBot", token: FAKE_AC_TOKEN }),
      );
      writeFileSync(
        join(cfg, "toString.json"),
        JSON.stringify({ agent_id: "agent-main", display_name: "MainBot", token: FAKE_AC_TOKEN }),
      );
      writeFileSync(
        join(cfg, "EvilCtrl.json"),
        JSON.stringify({ agent_id: "agent-main\u0085", display_name: "Other", token: FAKE_AC_TOKEN }),
      );
      expect(findDefaultProfileCollision(cfg, defPath)).toBeNull();

      // Genuine named profile collision still triggers
      writeFileSync(
        join(cfg, "LegitBot.json"),
        JSON.stringify({ agent_id: "agent-main", display_name: "MainBot", token: FAKE_AC_TOKEN }),
      );
      expect(findDefaultProfileCollision(cfg, defPath)?.collidingName).toBe("LegitBot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session-bind blocks Object.prototype shadowing, Windows device stems, and .. substring in bound profiles & detected sessions", () => {
    const cfg = mkdtempSync(join(tmpdir(), "ac-c142-sb-"));
    try {
      const parsed = parseSessionBinds({
        toString: "Alpha",
        valueOf: "Alpha",
        hasOwnProperty: "Alpha",
        "sid-proto": "toString",
        "sid-win-1": "CON",
        "sid-win-2": "nul.json",
        "sid-win-3": "COM1.txt.json",
        "sid-dotdot": "Bot..Evil",
        "sid-good": "ValidBot",
      });
      expect(parsed).toEqual({ "sid-good": "ValidBot" });
      expect(typeof (parsed as any).toString).toBe("function");
      expect(typeof (parsed as any).hasOwnProperty).toBe("function");

      saveSessionBind(cfg, "toString", "ValidBot");
      saveSessionBind(cfg, "sid-win", "PRN.json");
      saveSessionBind(cfg, "sid-dot", "Foo..Bar");
      saveSessionBind(cfg, "sid-clean", "CleanBot");
      expect(loadSessionBinds(cfg)).toEqual({ "sid-clean": "CleanBot" });

      expect(detectRuntimeSession({ CLAUDE_CODE_SESSION_ID: "toString" })).toBeNull();
      expect(detectRuntimeSession({ CLAUDE_CODE_SESSION_ID: "sess..bad" })).toBeNull();
      expect(detectRuntimeSession({ CLAUDE_CODE_SESSION_ID: "sess-good-142" })?.sessionId).toBe("sess-good-142");

      // lockFilePath prefixes Object.prototype keys with `_`
      expect(lockFilePath("/tmp/locks", "toString")).toBe("/tmp/locks/_toString.lock");
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  test("grok-bind rejects Object.prototype keys, Windows device basenames, and extended sidecar stems", () => {
    const binds = parseGrokBinds({
      toString: "Jack",
      hasOwnProperty: "Jack",
      "u-proto-val": "valueOf",
      "u-win-con": "CON.json",
      "u-win-lpt": "lpt1",
      "u-codex": "codex-bots.json",
      "u-sb-meta": "session-binds_meta",
      "u-valid": "Grok_Valid",
    });
    expect(binds).toEqual({ "u-valid": "Grok_Valid" });
    expect(typeof (binds as any).toString).toBe("function");

    expect(
      decideGrokBind({
        explicitIdentity: false,
        hasToken: false,
        conversationId: "toString",
        binds: { "u-valid": "Grok_Valid" },
      }),
    ).toEqual({ kind: "miss", conversationId: "toString" });
    expect(boundProfileForConversation("hasOwnProperty", binds)).toBeNull();
  });

  test("read-cursor blocks Object.prototype keys, Windows device slugs, .. substrings, and control-char paths", () => {
    expect(safeAgentCursorSlug("toString")).toBe("_");
    expect(safeAgentCursorSlug("hasOwnProperty")).toBe("_");
    expect(safeAgentCursorSlug("CON")).toBe("_");
    expect(safeAgentCursorSlug("nul.1")).toBe("_");
    expect(safeAgentCursorSlug("COM9")).toBe("_");
    expect(safeAgentCursorSlug("bot..evil")).toBe("_");
    expect(safeAgentCursorSlug("bot-clean-1.2")).toBe("bot-clean-1.2");

    const dir = mkdtempSync(join(tmpdir(), "ac-c142-cur-"));
    try {
      const file = join(dir, "cursor.json");
      writeFileSync(
        file,
        JSON.stringify({
          toString: "2026-11-15T00:00:00Z",
          valueOf: "2026-11-15T00:00:00Z",
          "chan-ok": "2026-11-15T01:00:00Z",
        }),
      );
      const warns: string[] = [];
      const loaded = loadCursor(file, (m) => warns.push(m));
      expect(warns).toEqual([]);
      expect(loaded).toEqual(new Map([["chan-ok", "2026-11-15T01:00:00Z"]]));

      // persistCursor filters Object.prototype keys and rejects control-char/empty file paths
      const badWarns: string[] = [];
      expect(persistCursor("", new Map([["c", "ts"]]), (m) => badWarns.push(m))).toBe(false);
      expect(persistCursor(`${file}\u0085`, new Map([["c", "ts"]]), (m) => badWarns.push(m))).toBe(false);
      expect(badWarns.length).toBe(2);

      const mapWithProto = new Map<string, string>([
        ["toString", "2026-11-15T00:00:00Z"],
        ["room-1", "2026-11-15T02:00:00Z"],
      ]);
      const okWarns: string[] = [];
      expect(persistCursor(file, mapWithProto, (m) => okWarns.push(m))).toBe(true);
      expect(okWarns).toEqual([]);
      expect(loadCursor(file, (m) => okWarns.push(m))).toEqual(new Map([["room-1", "2026-11-15T02:00:00Z"]]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("profile-selection blocks zero-padded SIIT / expanded mapped-IPv6 SSRF, Object.prototype keys, and Windows device profiles", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ac-c142-psel-"));
    try {
      mkdirSync(join(cwd, ".agentschat"), { recursive: true });
      const cfg = join(cwd, ".agentschat", "config.json");

      for (const badPayload of [
        { profile: "toString" },
        { profile: "CON.json" },
        { profile: "LPT1" },
        { profile: "./sub/NUL.json" },
        { profile: "Bot..Bad" },
        { profile: "muse" },
        { profile: "identity-guard" },
        { profile: "BotA", agent_id: "toString" },
        { profile: "BotA", toString: "shadow" },
        { profile: "BotA", api_url: "https://[::ffff:0:1]" },
        { profile: "BotA", api_url: "https://[::ffff:0:169.254.169.254]" },
        { profile: "BotA", api_url: "https://[0:0:0:0:0:ffff:169.254.169.254]" },
        { profile: "BotA", ws_url: "wss://[::ffff:0:100.100.100.200]/ws" },
      ]) {
        writeFileSync(cfg, JSON.stringify(badPayload));
        expect(() => projectProfileSelector(cwd)).toThrow();
      }

      writeFileSync(cfg, JSON.stringify({ profile: "BotA", api_url: "https://agents-chat.com" }));
      expect(projectProfileSelector(cwd)).toEqual({
        selector: "BotA",
        source: "project-config",
        apiUrl: "https://agents-chat.com",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
