import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAgentLock,
  detectDshCallerSession,
  loadSessionBinds,
  parseSessionBinds,
  resolveLockDir,
  saveSessionBind,
} from "../src/session-bind.ts";

describe("Campaign #128 KR3: session-bind hardening", () => {
  test("blocks lexical symlink/.. ancestor escapes in configDir, lockDir, and AGENTSCHAT_LOCK_DIR while keeping clean paths working", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c128-sb-"));
    try {
      const realDir = join(root, "real-cfg");
      const outsideDir = join(root, "outside");
      const siblingDir = join(root, "sibling-target");
      mkdirSync(realDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });

      const escapeLink = join(root, "escape-link");
      symlinkSync(outsideDir, escapeLink);

      // Lexical `escape-link/../sibling-target` resolves to `sibling-target`,
      // but traverses through symlink `escape-link` before `..` collapse.
      const dotDotThroughSymlink = `${escapeLink}/../sibling-target`;
      saveSessionBind(dotDotThroughSymlink, "sess-escape", "Alpha");
      expect(loadSessionBinds(siblingDir)).toEqual({});
      expect(loadSessionBinds(dotDotThroughSymlink)).toEqual({});

      expect(
        acquireAgentLock({
          lockDir: dotDotThroughSymlink,
          agentId: "bot-escape",
          currentPid: process.pid,
        }),
      ).toBeNull();

      // AGENTSCHAT_LOCK_DIR with symlink/.. or direct symlink falls back to hashed safe default
      const directSymlinkLock = join(root, "direct-lock-link");
      symlinkSync(outsideDir, directSymlinkLock);
      expect(resolveLockDir("/tmp/home-c128", { AGENTSCHAT_LOCK_DIR: dotDotThroughSymlink })).toContain(
        "agentschat-locks-",
      );
      expect(resolveLockDir("/tmp/home-c128", { AGENTSCHAT_LOCK_DIR: directSymlinkLock })).toContain(
        "agentschat-locks-",
      );

      // Clean explicit lock directory continues to work
      expect(resolveLockDir("/tmp/home-c128", { AGENTSCHAT_LOCK_DIR: realDir })).toBe(realDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects extended reserved sidecar names and own-__proto__ profile JSONs while keeping 'profile' bindable", () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c128-sidecar-"));
    try {
      const cfgDir = join(root, "cfg");
      mkdirSync(join(cfgDir, "profiles"), { recursive: true });

      // Default `profile` (`profile.json`) MUST remain bindable
      writeFileSync(
        join(cfgDir, "profile.json"),
        JSON.stringify({ agent_id: "default-boot-agent", token: "ac_boot" }),
      );
      saveSessionBind(cfgDir, "cid-default", "profile");
      expect(loadSessionBinds(cfgDir)).toEqual({ "cid-default": "profile" });

      // Reserved non-identity sidecars must never be bindable
      const reservedNames = [
        "session-binds",
        "session-binds.meta",
        "session-binds_meta",
        "agy-binds",
        "agy-binds.meta",
        "agy-binds_meta",
        "grok-binds",
        "grok-binds.meta",
        "grok-binds_meta",
        "agy-session-binds",
        "identity-guard",
        "cursor",
        "read-cursors",
        "mention-timestamps",
        "wake-pids",
        "config",
        "codex-bots",
        "dsh",
        "muse",
        "DSH.json",
        "MUSE.JSON",
      ];
      for (const bad of reservedNames) {
        saveSessionBind(cfgDir, `sid-${bad}`, bad);
        expect(parseSessionBinds({ [`sid-${bad}`]: bad })).toEqual({});
      }
      expect(loadSessionBinds(cfgDir)).toEqual({ "cid-default": "profile" });

      // Own-`__proto__` profile JSON cannot be used to alias-evict a legitimate session bind
      writeFileSync(
        join(cfgDir, "profiles", "Poisoned.json"),
        '{"__proto__":{"polluted":true},"agent_id":"default-boot-agent"}',
        "utf8",
      );
      saveSessionBind(cfgDir, "cid-poison", "Poisoned");
      // Both `cid-default` and `cid-poison` remain distinct because Poisoned.json's own-__proto__ payload was rejected
      expect(loadSessionBinds(cfgDir)).toEqual({
        "cid-default": "profile",
        "cid-poison": "Poisoned",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detectDshCallerSession blocks ?query/:0 health URLs, enforces byte cap without stream reader, and rejects own-__proto__ JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "ac-c128-dsh-"));
    try {
      const dshHome = join(root, "dsh-home");
      mkdirSync(dshHome, { recursive: true });

      let fetchCalls = 0;
      for (const badUrl of [
        "http://127.0.0.1:8799/health?foo=bar",
        "http://127.0.0.1:0/health",
        "http://127.0.0.1:000/health",
        "http://127.0.0.1:8799/health#frag",
        "http://user:pass@127.0.0.1:8799/health",
      ]) {
        const res = await detectDshCallerSession({
          dshHome,
          healthUrl: badUrl,
          fetchImpl: (async () => {
            fetchCalls += 1;
            return new Response(JSON.stringify({ roots: [{ id: "session-should-not-run", status: "running" }] }));
          }) as unknown as typeof fetch,
        });
        expect(res).toBeNull();
      }
      expect(fetchCalls).toBe(0);

      // Non-stream Response-like object exceeding 256 KiB is rejected
      const oversizedBody = JSON.stringify({
        roots: [{ id: "session-oversized", status: "running" }],
        pad: "x".repeat(300 * 1024),
      });
      const fromOversizedNonStream = await detectDshCallerSession({
        dshHome,
        healthUrl: "http://127.0.0.1:8799/health",
        fetchImpl: (async () => ({
          ok: true,
          body: null,
          text: async () => oversizedBody,
        })) as unknown as typeof fetch,
      });
      expect(fromOversizedNonStream).toBeNull();

      // Own-__proto__ JSON payload from /health is rejected
      const fromProtoJson = await detectDshCallerSession({
        dshHome,
        healthUrl: "http://127.0.0.1:8799/health",
        fetchImpl: (async () =>
          new Response('{"__proto__":{"polluted":1},"roots":[{"id":"session-proto","status":"running"}]}')) as unknown as typeof fetch,
      });
      expect(fromProtoJson).toBeNull();

      // Valid non-stream Response-like object within byte cap succeeds
      const fromValidNonStream = await detectDshCallerSession({
        dshHome,
        healthUrl: "http://127.0.0.1:8799/health",
        fetchImpl: (async () => ({
          ok: true,
          body: null,
          text: async () => JSON.stringify({ roots: [{ id: "session-valid-128", status: "running" }] }),
        })) as unknown as typeof fetch,
      });
      expect(fromValidNonStream).toBe("session-valid-128");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
