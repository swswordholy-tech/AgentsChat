import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProfileSelector } from "../src/profile-selection.ts";
import { claimSummary, getOnboardingStatus } from "../src/onboarding-status.ts";
import { decideIdentity, validateIdentityProfile } from "../src/identity.ts";
import { parseGuardRecord, expectedAgentIdViolation } from "../src/identity-guard.ts";
import {
  checkAgentLock,
  detectDshCallerSession,
  isPidAlive,
  lockFilePath,
  parseAntigravityLsofOutput,
  parseWindowsAntigravityProbeJson,
  parseWindowsNetstatOutput,
  releaseAgentLock,
} from "../src/session-bind.ts";
import { gateSwitchProfile, nonGrokWakeReason, parseGrokBinds } from "../src/grok-bind.ts";
import { HeartbeatMonitor, WS_CONNECTING, WS_OPEN } from "../src/heartbeat.ts";
import { computeReconnectDelay } from "../src/reconnect.ts";
import { isHumanPiiHandle, redactParticipantPii, redactSecrets } from "../src/redact.ts";

const FAKE_HF = `${"hf"}_abcdefghijklmnopqrstuvwxyz012345`;
const FAKE_NPM = `${"npm"}_abcdefghijklmnopqrstuvwxyz012345`;

describe("Campaign #134 KR3: profile-selection, onboarding-status, identity & identity-guard hardening", () => {
  test("projectProfileSelector blocks raw symlink_dir/.. traversal before resolve() and enforces full SSRF/C1 parity", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ac-c134-proj-"));
    try {
      const realWork = join(tmp, "real-work");
      const outside = join(tmp, "outside");
      mkdirSync(join(realWork, ".agentschat"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(realWork, "sym"));

      writeFileSync(
        join(realWork, ".agentschat", "config.json"),
        JSON.stringify({ profile: "BotA" }),
      );
      // Clean cwd works
      expect(projectProfileSelector(realWork)?.selector).toBe("BotA");
      // Raw symlink_dir/.. collapses to realWork if resolve() ran before raw segment walk — must refuse!
      const viaSymlinkDotDot = `${realWork}/sym/..`;
      expect(() => projectProfileSelector(viaSymlinkDotDot)).toThrow("Refusing symlinked");

      // Relative profile traversing through symlink_dir/.. inside project must also throw
      writeFileSync(
        join(realWork, ".agentschat", "config.json"),
        JSON.stringify({ profile: "sym/../profiles/BotA.json" }),
      );
      expect(() => projectProfileSelector(realWork)).toThrow("Invalid project profile");

      // Cloud metadata / Alibaba / AWS IPv6 / unspecified / mapped IPv6 / port :0 SSRF in api_url & ws_url
      for (const badApi of [
        "https://sub.metadata.google.internal",
        "https://100.100.100.200",
        "https://0.0.0.0",
        "https://[::]",
        "https://[fd00:ec2::254]",
        "https://[::ffff:100.100.100.200]",
        "https://[::ffff:0.0.0.0]",
        "https://agents-chat.com:0",
      ]) {
        writeFileSync(
          join(realWork, ".agentschat", "config.json"),
          JSON.stringify({ profile: "BotA", api_url: badApi }),
        );
        expect(() => projectProfileSelector(realWork)).toThrow("Invalid project api_url");
      }

      // C1 control char or pre-encoded traversal in agent_id
      for (const badId of ["bot\u0085x", "bot%2fx", "bot..x"]) {
        writeFileSync(
          join(realWork, ".agentschat", "config.json"),
          JSON.stringify({ profile: "BotA", agent_id: badId }),
        );
        expect(() => projectProfileSelector(realWork)).toThrow(/Invalid project agent_id/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("onboarding-status enforces strict decimal Content-Length, C1/U+2028 guards & hex-mapped 0.x.y.z SSRF", async () => {
    // Malformed negative/comma Content-Length fails closed to unknown
    for (const badLen of ["-10", "10, 999999", "0x20"]) {
      const res = await getOnboardingStatus(
        "https://agents-chat.com",
        "bot-1",
        "tok-valid",
        async () =>
          new Response(JSON.stringify({ agent_id: "bot-1", claimed: true }), {
            status: 200,
            headers: { "content-length": badLen },
          }),
      );
      expect(res.authentication).toBe("unknown");
      expect(res.claimed).toBeNull();
    }

    // Hex-mapped unspecified IPv6 [::ffff:0:1] & C1 base/token are rejected without calling network
    let fetched = 0;
    const badBase = await getOnboardingStatus("https://[::ffff:0:1]", "bot-1", "tok", async () => {
      fetched++;
      return new Response("{}");
    });
    expect(badBase.chat_url).toBe("https://agents-chat.com/chat/bot-1");
    expect(fetched).toBe(0);

    const badToken = await getOnboardingStatus("https://agents-chat.com", "bot-1", "tok\u0085bad", async () => {
      fetched++;
      return new Response("{}");
    });
    expect(badToken.authentication).toBe("unknown");
    expect(fetched).toBe(0);

    expect(
      claimSummary({
        agent_id: "bot-1",
        claimed: false,
        authentication: "ok",
        chat_url: "https://agents-chat.com/chat/bot-1",
        claim_url: "https://agents-chat.com/chat/bot-1?claim=1\u0085\u2028",
        next_step: "join_public_chat",
      }),
    ).not.toMatch(/[\u0085\u2028]/);
  });

  test("identity & identity-guard reject C1/U+2028/encoded-traversal IDs and own-__proto__ bySelector", () => {
    const badDecide = decideIdentity({
      profileExists: false,
      source: "flag-name",
      profileFile: "/tmp/p.json",
      cliName: "Bad\u0085Name",
      hasToken: false,
      fallbackName: "Bot",
    });
    expect(badDecide.mode).toBe("error");

    expect(() =>
      validateIdentityProfile({ agent_id: "bot%2fbad", token: "valid-token-123" }, "/tmp/p.json"),
    ).toThrow();
    expect(() =>
      validateIdentityProfile({ agent_id: "bot-ok", token: "tok\u2028bad" }, "/tmp/p.json"),
    ).toThrow();

    const parsedProto = parseGuardRecord(
      '{"bySelector":{"__proto__":"polluted","Jack":"agent-jack"},"lastEffective":null}',
    );
    expect(Object.hasOwn(parsedProto.bySelector, "__proto__")).toBe(false);
    expect(parsedProto.bySelector).toEqual({ Jack: "agent-jack" });

    const parsedC1 = parseGuardRecord(
      JSON.stringify({
        bySelector: { "Jack\u0085": "agent-jack", Clean: "agent-clean" },
        lastEffective: { agentId: "agent\u0085clean", source: "env\u2028src", ts: "2026-11-15" },
      }),
    );
    expect(parsedC1.bySelector).toEqual({ Clean: "agent-clean" });
    expect(parsedC1.lastEffective?.agentId).toBe("agentclean");
    expect(expectedAgentIdViolation("pin\u0085id", "live\u2028id")).not.toMatch(/[\u0085\u2028]/);
  });
});

describe("Campaign #134 KR4: session-bind, grok-bind, heartbeat, reconnect & redact hardening", () => {
  test("session-bind enforces isSafeInteger PID, <=65535 ports, backward-NTP corrupt-lock cleanup & strict DSH Content-Length", async () => {
    expect(isPidAlive(1e21)).toBe(false);
    expect(isPidAlive(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);

    const lsofParsed = parseAntigravityLsofOutput(
      [
        "language_ 123 user 10u IPv4 0x1 0t0 TCP 127.0.0.1:51234 (LISTEN)",
        "language_ 123 user 11u IPv4 0x2 0t0 TCP 127.0.0.1:99999 (LISTEN)",
      ].join("\n"),
    );
    expect(lsofParsed.ports).toEqual([51234]);

    expect(
      parseWindowsNetstatOutput(
        [
          "  TCP    127.0.0.1:61000        0.0.0.0:0              LISTENING       4242",
          "  TCP    127.0.0.1:70000        0.0.0.0:0              LISTENING       4242",
        ].join("\n"),
        4242,
      ),
    ).toEqual([61000]);

    const winProbe = parseWindowsAntigravityProbeJson(
      JSON.stringify({
        lsPid: 4242,
        lsCmd: "language_server.exe --csrf_token tok123",
        ports: [50100, 70000, -1],
        lockedPresence: [],
        lockedDbs: [],
      }),
    );
    expect(winProbe?.ports).toEqual([50100]);
    expect(
      parseWindowsAntigravityProbeJson('{"lsPid":4242,"lsCmd":"language_server --csrf_token t","__proto__":{}}'),
    ).toBeNull();

    // Corrupt lock file with future mtime (simulating backward NTP jump) is still unlinked!
    const lockTmp = mkdtempSync(join(tmpdir(), "ac-c134-locks-"));
    try {
      const f = lockFilePath(lockTmp, "agent-ntp");
      writeFileSync(f, "{corrupt-json");
      const futureSec = Math.floor((Date.now() + 60_000) / 1000);
      utimesSync(f, futureSec, futureSec);
      expect(checkAgentLock({ lockDir: lockTmp, agentId: "agent-ntp" }).locked).toBe(false);
      expect(existsSync(f)).toBe(false);

      writeFileSync(f, "{corrupt-json-2");
      utimesSync(f, futureSec, futureSec);
      expect(releaseAgentLock({ lockDir: lockTmp, agentId: "agent-ntp" })).toBe(true);
      expect(existsSync(f)).toBe(false);

      // DSH /health with malformed Content-Length fails closed and falls back cleanly
      const dshSid = await detectDshCallerSession({
        dshHome: lockTmp,
        healthUrl: "http://127.0.0.1:8799/health",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ roots: [{ id: "session-abc123", status: "running" }] }), {
            status: 200,
            headers: { "content-length": "-5" },
          })) as any,
      });
      expect(dshSid).toBeNull();
    } finally {
      rmSync(lockTmp, { recursive: true, force: true });
    }
  });

  test("HeartbeatMonitor clamps lastPong & connectingSince when system clock steps backward", () => {
    let fakeNow = 1_700_000_100_000;
    const origNow = Date.now;
    Date.now = () => fakeNow;
    try {
      let state = WS_OPEN;
      let reconnects = 0;
      const hb = new HeartbeatMonitor(
        {
          sendPing: () => {},
          reconnect: () => {
            reconnects++;
          },
          getReadyState: () => state,
        },
        1_000,
        5_000,
        3_000,
      );
      hb.receivedPong();
      // Step clock backward by 1 hour!
      fakeNow -= 3_600_000;
      hb.tick(); // Clamps lastPong to fakeNow instead of staying 1h in the future
      fakeNow += 5_001;
      hb.tick(); // Immediately detects pong timeout after 5s instead of waiting 1h+5s!
      expect(reconnects).toBe(1);

      hb.resetReconnecting();
      state = WS_CONNECTING;
      hb.tick(); // Sets connectingSince = fakeNow
      fakeNow -= 3_600_000;
      hb.tick(); // Clamps connectingSince to fakeNow
      fakeNow += 3_001;
      hb.tick(); // Detects connect timeout after 3s!
      expect(reconnects).toBe(2);
    } finally {
      Date.now = origNow;
    }
  });

  test("grok-bind, reconnect & redact handle C1/own-__proto__, +Infinity attempts, and hf_/npm_ tokens", () => {
    const grokProto = parseGrokBinds(JSON.parse('{"__proto__":"Jack","u1":"Jack"}'));
    expect(Object.hasOwn(grokProto, "__proto__")).toBe(false);
    expect(grokProto).toEqual({ u1: "Jack" });
    expect(parseGrokBinds({ u1: "Jack\u0085", u2: "CleanBot" })).toEqual({ u2: "CleanBot" });
    const locked = gateSwitchProfile({
      conversationId: "u2",
      binds: { u2: "CleanBot" },
      requestedProfileName: "Other\u0085\u2028Bot",
    });
    expect(locked.kind).toBe("locked");
    if (locked.kind === "locked") {
      expect(locked.requestedProfileName).toBe("OtherBot");
    }
    expect(nonGrokWakeReason({ AGENTCHAT_WAKE_KIND: "zcode\u0085" })).toBe("AGENTCHAT_WAKE_KIND=zcode");

    expect(computeReconnectDelay(Number.POSITIVE_INFINITY, () => 0.5)).toBe(31_500);
    expect(computeReconnectDelay(Number.NEGATIVE_INFINITY, () => 0.5)).toBe(1_500);

    const scrubbed = redactSecrets(`tokens: ${FAKE_HF} and ${FAKE_NPM}`, { preserveAcKeys: true });
    expect(scrubbed).toContain("hf_***REDACTED***");
    expect(scrubbed).toContain("npm_***REDACTED***");
    expect(scrubbed).not.toContain(FAKE_HF);
    expect(scrubbed).not.toContain(FAKE_NPM);

    expect(isHumanPiiHandle("alice\u0085@example.com")).toBe(true);
    expect(redactParticipantPii("alice\u0085@example.com")).toBe("alice@example.com");
  });
});
