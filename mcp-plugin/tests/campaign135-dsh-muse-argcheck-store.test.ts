import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply as applyInboundBridge,
  atomicReplaceRegular,
  checkParentDirectory as checkInboundParentDir,
  isBlockedInboundHost,
} from "../dsh/inbound-bridge/index.js";
import { isSafeAgentId as isSafeMuseAgentId, isUnsafeEndpointHost, validateEndpointUrl } from "../muse/src/config.ts";
import { appendWakeQueue, redactSecrets as redactMuseSecrets, sanitizeMuseText } from "../muse/src/wake.ts";
import { MuseAgentChatClient } from "../muse/src/client.ts";
import {
  validateCreateLoopInput,
  validateOkrAddKrInput,
  validateOkrTaskTitleInput,
  validateSaveSkillInput,
  validateTaskEvidenceInput,
  validateUpsertChannelDocInput,
} from "../src/argcheck.ts";
import { findDefaultProfileCollision, safeWriteProfile } from "../src/profile-store.ts";
import { loadCursor, persistCursor } from "../src/read-cursor.ts";
import { agentschatConfigDir, resolveSessionForAgent } from "../src/session-route.ts";
import { MessageDedup, messageDedupKey } from "../src/dedup.ts";
import { matchesMention } from "../src/mentions.ts";
import { normalizeTimestampForCursor } from "../src/timestamps.ts";

const FAKE_HF = `${"hf"}_${"A".repeat(24)}`;
const FAKE_NPM = `${"npm"}_${"B".repeat(24)}`;
const FAKE_MR = `${"mr"}_${"C".repeat(20)}`;
const FAKE_GLPAT = `${"glpat"}-${"D".repeat(20)}`;
const FAKE_XOXB = `${"xoxb"}-${"E".repeat(16)}`;
const FAKE_ASIA = `${"ASIA"}${"0123456789ABCDEF"}`;

describe("Campaign #135 KR3: DSH Inbound Bridge & Muse Bridge Hardening", () => {
  test("DSH inbound-bridge checkParentDirectory blocks raw symlink_dir/.. traversal and C1/U+2028/U+2029", () => {
    const dir = mkdtempSync(join(tmpdir(), "c135-dsh-parent-"));
    try {
      const realDir = join(dir, "real");
      const siblingDir = join(dir, "sibling");
      const outsideDir = join(dir, "outside");
      mkdirSync(realDir, { recursive: true });
      mkdirSync(siblingDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const linkInSibling = join(siblingDir, "escape-link");
      symlinkSync(outsideDir, linkInSibling);

      expect(() => checkInboundParentDir(`${linkInSibling}/../real/session-binds.json`)).toThrow(/unsafe parent/);
      expect(() => checkInboundParentDir(join(realDir, "bad\u0085file.json"))).toThrow(/unsafe parent/);
      expect(() => checkInboundParentDir(join(realDir, "bad\u2028file.json"))).toThrow(/unsafe parent/);
      expect(() => checkInboundParentDir(join(realDir, "good.json"))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DSH inbound-bridge atomicReplaceRegular falls back on EPERM/EACCES and blocks symlink swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "c135-dsh-atomic-"));
    try {
      const target = join(dir, "binds.json");
      const tmp = join(dir, "binds.json.tmp");
      writeFileSync(target, '{"old":true}\n', "utf8");
      writeFileSync(tmp, '{"new":true}\n', "utf8");

      let copied = 0;
      let unlinked = 0;
      atomicReplaceRegular(tmp, target, {
        renameSync() {
          const err: any = new Error("EPERM");
          err.code = "EPERM";
          throw err;
        },
        copyFileSync(src: string, dest: string) {
          copied++;
          writeFileSync(dest, readFileSync(src));
        },
        unlinkSync() {
          unlinked++;
        },
      });
      expect(copied).toBe(1);
      expect(unlinked).toBe(1);
      expect(readFileSync(target, "utf8")).toBe('{"new":true}\n');

      // Symlink swap during EACCES fallback must be refused before copyFileSync
      const victim = join(dir, "victim.json");
      const swapTarget = join(dir, "swap.json");
      const swapTmp = join(dir, "swap.json.tmp");
      writeFileSync(victim, "untouched", "utf8");
      writeFileSync(swapTmp, "evil", "utf8");
      expect(() =>
        atomicReplaceRegular(swapTmp, swapTarget, {
          renameSync() {
            symlinkSync(victim, swapTarget);
            const err: any = new Error("EACCES");
            err.code = "EACCES";
            throw err;
          },
        }),
      ).toThrow(/non-regular/);
      expect(readFileSync(victim, "utf8")).toBe("untouched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DSH inbound-bridge /identity/create blocks SSRF metadata/0.0.0.0/link-local hosts, skips sidecars in /identity, and scrubs modern secrets", async () => {
    for (const host of [
      "0.0.0.0",
      "0.1.2.3",
      "169.254.169.254",
      "100.100.100.200",
      "metadata.google.internal",
      "sub.metadata.google.internal",
      "metadata.goog",
      "foo.metadata.goog",
      "metadata",
      "instance-data",
      "[::]",
      "[fe80::1]",
      "[fd00:ec2::254]",
      "[::ffff:169.254.169.254]",
      "[::ffff:0:100.100.100.200]",
    ]) {
      expect(isBlockedInboundHost(host)).toBe(true);
    }
    for (const okHost of ["agents-chat.com", "localhost", "127.0.0.1", "[::1]", "staging-api.agentschat.internal"]) {
      expect(isBlockedInboundHost(okHost)).toBe(false);
    }

    const dir = mkdtempSync(join(tmpdir(), "c135-dsh-http-"));
    mkdirSync(join(dir, "profiles"), { recursive: true });
    // Populate sidecar files that must NOT be exposed as profiles in /identity
    for (const sidecar of ["profile.json", "codex-bots.json", "dsh.json", "muse.json", "identity-guard.json"]) {
      writeFileSync(join(dir, sidecar), JSON.stringify({ agent_id: `sc-${sidecar}`, token: "tok" }), "utf8");
    }
    writeFileSync(join(dir, "profiles", "RealBot.json"), JSON.stringify({ agent_id: "real-bot", token: "tok" }), "utf8");

    let stop = () => {};
    const base = await new Promise<string>((ready) => {
      applyInboundBridge(
        {
          get() {
            return undefined;
          },
          effect(fn: () => () => void) {
            stop = fn();
          },
        },
        {
          port: 0,
          mcpBin: "",
          agentschatDir: dir,
          logPath: join(dir, "bridge.log"),
          apiUrl: "https://metadata.google.internal",
          retryMs: NaN,
          flushTimeoutMs: -50,
          onListening({ port }: { port: number }) {
            ready(`http://127.0.0.1:${port}`);
          },
        },
      );
    });

    const realFetch = globalThis.fetch;
    let regCalls = 0;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => {
      if (String(input).endsWith("/api/account/register")) {
        regCalls++;
        return Promise.resolve(
          new Response(`leak ${FAKE_HF} ${FAKE_NPM} ${FAKE_MR} https://u:p@evil.example/x`, { status: 500 }),
        );
      }
      return realFetch(input, init);
    }) as typeof fetch);

    try {
      const idRes = await (await realFetch(`${base}/identity`)).json() as any;
      expect(idRes.profiles.map((p: any) => p.name)).toEqual(["RealBot"]);

      // SSRF metadata host rejected with 400 before fetch
      const ssrfCreate = await realFetch(`${base}/identity/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "TestBot" }),
      });
      expect(ssrfCreate.status).toBe(400);
      expect(regCalls).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Muse config, wake & client block *.metadata.google.internal, 0.* IPv4, C1/U+2028/U+2029, oversized binary WS frames, and NTFS EPERM wake rotation", () => {
    expect(isUnsafeEndpointHost("sub.metadata.google.internal")).toBe(true);
    expect(isUnsafeEndpointHost("0.1.2.3")).toBe(true);
    expect(isUnsafeEndpointHost("[::ffff:0.1.2.3]")).toBe(true);
    expect(() => validateEndpointUrl("https://sub.metadata.google.internal", "rest")).toThrow(/Unsafe/);
    expect(() => validateEndpointUrl("https://agents-chat.com/\u0085", "rest")).toThrow(/Invalid/);
    expect(isSafeMuseAgentId("bot\u0085")).toBe(false);
    expect(isSafeMuseAgentId("bot\u2028")).toBe(false);

    const scrubbed = sanitizeMuseText(`tok=${FAKE_MR} url=https://alice:secret@example.com/path\u0085\u2028`);
    expect(scrubbed).not.toContain(FAKE_MR);
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).not.toMatch(/[\u0080-\u009f\u2028\u2029]/);
    expect(redactMuseSecrets("https://user:pass@example.com/hook")).toBe("https://[redacted]@example.com/hook");

    // Muse wake queue NTFS EPERM fallback + symlink-swap rejection
    const dir = mkdtempSync(join(tmpdir(), "c135-muse-wake-"));
    try {
      const qFile = join(dir, "queue.jsonl");
      appendWakeQueue(qFile, { type: "message", message_id: "m1", content: "first" }, 2);
      appendWakeQueue(qFile, { type: "message", message_id: "m2", content: "second" }, 2);

      let copied = 0;
      const appended = appendWakeQueue(
        qFile,
        { type: "message", message_id: "m3", content: "third" },
        2,
        {
          renameSync() {
            const err: any = new Error("EPERM");
            err.code = "EPERM";
            throw err;
          },
          copyFileSync(src, dest) {
            copied++;
            writeFileSync(dest, readFileSync(src));
          },
        },
      );
      expect(appended).toBe(true);
      expect(copied).toBe(1);
      const lines = readFileSync(qFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!).message_id).toBe("m3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Muse client pre-checks raw binary ArrayBuffer/Uint8Array frame size > 1 MiB without allocating string
    const client = new MuseAgentChatClient({ agentId: "bot", token: "tok", url: "ws://localhost:9000" });
    let handled = 0;
    (client as any).handleMessage = () => {
      handled++;
    };
    const fakeWs: any = {};
    (client as any).ws = fakeWs;
    // Simulate openSocket's onmessage logic via a real socket mock
    const origWS = globalThis.WebSocket;
    let capturedSocket: any;
    (globalThis as any).WebSocket = class {
      readyState = 1;
      onopen: any;
      onmessage: any;
      onerror: any;
      onclose: any;
      constructor() {
        capturedSocket = this;
      }
      send() {}
      close() {}
    };
    try {
      void client.connect().catch(() => {});
      capturedSocket.onmessage({ data: new Uint8Array(1_048_577) });
      capturedSocket.onmessage({ data: new ArrayBuffer(1_048_577) });
      expect(handled).toBe(0);
      capturedSocket.onmessage({ data: JSON.stringify({ type: "pong" }) });
      expect(handled).toBe(1);
    } finally {
      client.disconnect();
      globalThis.WebSocket = origWS;
    }
  });
});

describe("Campaign #135 KR4: Core Argcheck, Profile-Store, Cursor, Session-Route & Dedup Hardening", () => {
  test("argcheck rejects C1/U+2028/U+2029 controls and hf_/npm_/mr_/glpat-/xoxb-/ASIA secrets across OKR, loop, doc & skill validators", () => {
    for (const secret of [FAKE_HF, FAKE_NPM, FAKE_MR, FAKE_GLPAT, FAKE_XOXB, FAKE_ASIA]) {
      expect(validateTaskEvidenceInput([{ kind: "doc", ref: "ref-1", note: `leaked ${secret}` }]).ok).toBe(false);
      expect(validateOkrTaskTitleInput(`Task ${secret}`).ok).toBe(false);
      expect(validateOkrAddKrInput({ objective_id: "obj_valid_1", title: `KR ${secret}`, target: 1 }).ok).toBe(false);
      expect(
        validateCreateLoopInput({ channel_id: "room_1", mode: "prompt", prompt: `Run with ${secret}` }).ok,
      ).toBe(false);
      expect(
        validateUpsertChannelDocInput({
          chat_id: "room_1",
          doc_id: "doc_1",
          expected_version: 0,
          title: "Doc",
          kind: "context",
          body_markdown: `Secret: ${secret}`,
        }).ok,
      ).toBe(false);
      expect(
        validateSaveSkillInput({
          name: "my-skill",
          description: "Safe desc",
          body: `Body with ${secret}`,
        }).ok,
      ).toBe(false);
    }

    for (const ctrl of ["\u0085", "\u009b", "\u2028", "\u2029"]) {
      expect(validateOkrTaskTitleInput(`Bad${ctrl}Title`).ok).toBe(false);
      expect(validateTaskEvidenceInput([{ kind: "commit", ref: `abc${ctrl}def` }]).ok).toBe(false);
      expect(
        validateCreateLoopInput({ channel_id: "room_1", mode: "prompt", prompt: `Bad${ctrl}Prompt` }).ok,
      ).toBe(false);
    }
  });

  test("profile-store scrubs modern tokens/URL userinfo/C1 in warnings and skips codex-bots/meta sidecars in collision scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "c135-prof-"));
    try {
      const warnings: string[] = [];
      let thrownMsg = "";
      try {
        safeWriteProfile(
          join(dir, `missing-${FAKE_HF}-https://u:pw@evil.example\u0085`, "p.json"),
          { agent_id: "a", token: "t" },
          (m) => warnings.push(m),
        );
      } catch (e: any) {
        thrownMsg = String(e?.message ?? e);
      }
      expect(thrownMsg).toContain("REDACTED");
      expect(thrownMsg).not.toContain(FAKE_HF);
      expect(thrownMsg).not.toContain("pw@");
      expect(thrownMsg).not.toMatch(/[\u0080-\u009f]/);

      const defPath = join(dir, "profile.json");
      writeFileSync(defPath, JSON.stringify({ agent_id: "bot-main", display_name: "Bot Main", token: "tok" }), "utf8");
      // Sidecars with matching agent_id must NOT trigger false-positive profile collision
      for (const sc of ["codex-bots.json", "session-binds-meta.json", "agy-binds-meta.json", "agy-session-binds.meta.json"]) {
        writeFileSync(join(dir, sc), JSON.stringify({ agent_id: "bot-main", token: "tok" }), "utf8");
      }
      expect(findDefaultProfileCollision(dir, defPath)).toBeNull();

      // Real named profile with matching agent_id DOES trigger collision
      writeFileSync(join(dir, "NamedBot.json"), JSON.stringify({ agent_id: "bot-main", token: "tok" }), "utf8");
      expect(findDefaultProfileCollision(dir, defPath)?.collidingName).toBe("NamedBot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read-cursor, session-route, dedup, mentions & timestamps reject C1 and U+2028/U+2029", () => {
    const dir = mkdtempSync(join(tmpdir(), "c135-cursor-"));
    try {
      const cFile = join(dir, "cursor.json");
      const warns: string[] = [];
      const ok = persistCursor(
        cFile,
        new Map([
          ["good-room", "2026-11-15T00:00:00.000000000Z"],
          ["bad\u0085room", "2026-11-15T00:00:00.000000000Z"],
          ["room-2", "2026-11-15T00:00:00\u2028Z"],
        ]),
        (m) => warns.push(m),
      );
      expect(ok).toBe(true);
      const loaded = loadCursor(cFile, (m) => warns.push(m));
      expect([...loaded.keys()]).toEqual(["good-room"]);

      // Corrupt cursor file with C1 key + embedded hf_ token in key warns with redacted output
      const badFile = join(dir, "bad-cursor.json");
      writeFileSync(badFile, JSON.stringify({ [`room-${FAKE_HF}\u0085`]: "2026-11-15T00:00:00Z" }), "utf8");
      warns.length = 0;
      expect(loadCursor(badFile, (m) => warns.push(m)).size).toBe(0);
      expect(warns.join("")).not.toContain(FAKE_HF);
      expect(warns.join("")).not.toMatch(/[\u0080-\u009f]/);

      // session-route rejects C1/U+2028 in AGENTSCHAT_CONFIG_DIR, sessionId, and agentId
      expect(agentschatConfigDir({ AGENTSCHAT_CONFIG_DIR: `/tmp/bad\u0085dir`, HOME: "/tmp/clean" })).toBe(
        "/tmp/clean/.agentschat",
      );
      writeFileSync(join(dir, "session-binds.json"), JSON.stringify({ "sess\u0085bad": "CleanProf", "sess-ok": "CleanProf" }), "utf8");
      writeFileSync(join(dir, "CleanProf.json"), JSON.stringify({ agent_id: "clean-agent", token: "tok" }), "utf8");
      expect(resolveSessionForAgent("clean-agent\u2028", { configDir: dir })).toBeUndefined();
      expect(resolveSessionForAgent("clean-agent", { configDir: dir })?.sessionId).toBe("sess-ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // dedup, mentions, timestamps
    expect(messageDedupKey({ id: "m\u0085", channel_id: "general" })).toBeNull();
    expect(messageDedupKey({ id: "m1", channel_id: "gen\u2028eral" })).toBeNull();
    const dedup = new MessageDedup(10, 2);
    expect(dedup.recordOrSkip("room:m\u009b")).toBe(false);
    expect(dedup.size).toBe(0);

    expect(matchesMention("@bot\u0085 hello", "bot\u0085")).toBe(false);
    expect(matchesMention("@bot\u2029 hello", "bot\u2029")).toBe(false);
    expect(matchesMention("@bot hello", "bot")).toBe(true);

    expect(normalizeTimestampForCursor("2026-11-15T00:00:00Z\u0085", "after")).toBeUndefined();
    expect(normalizeTimestampForCursor("2026-11-15T00:00:00Z\u2028", "before")).toBeUndefined();
    expect(normalizeTimestampForCursor("2026-11-15T00:00:00Z", "after")).toBe("2026-11-15T00:00:00.000000000Z");
  });
});
