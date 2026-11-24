/**
 * Wake-webhook — fire an outbound HTTP POST when an @mention/DM arrives, so hosts
 * WITHOUT an MCP channel-notification surface (Grok Bot, generic MCP clients) can
 * be woken by "a POST hit my URL" instead of needing to recognize a host-specific
 * notification method.
 *
 * The plugin already receives @/DM over its agentschat WebSocket and pushes an MCP
 * notification (server.ts). Claude Code acts on that notification; other hosts drop
 * it. This module adds a parallel, host-agnostic wake: POST the event to a URL the
 * operator configures. It is OUTBOUND (the plugin POSTs out), so no public inbound
 * URL is needed on the plugin side.
 *
 * Security: the agentschat token is NEVER put in the callback body. Auth to the
 * receiver is an HMAC-SHA256 signature over the raw body, keyed by
 * AGENTCHAT_WAKE_SECRET (header `x-agentschat-signature`), so the receiver can tell
 * a real wake from a forged POST. The channel-owning agent's ac_ key stays local.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ANTIGRAVITY_SIDECAR_STATE_FILENAME,
  buildGrokPrompt,
  buildWakePayload,
  buildWakePrompt,
  clampWakeTimerMs,
  ensureAntigravityWakeSidecarInstalled,
  fireAntigravitySidecarWake,
  fireAntigravityWake,
  fireGrokWake,
  fireWake,
  fireZcodeWake,
  formatWakeAttachments,
  grokPortFromGatewayConfig,
  normalizeLoopbackLsAddress,
  readAntigravitySidecarConfig,
  resolveEnvWakeId,
  resolveWindowsCliSpawn,
  sanitizeWakeLogUrl,
  signWakeBody,
  verifyWakeSignature,
  WAKE_ID_HEADER,
  WAKE_SIG_HEADER,
} from "../src/wake.ts";

const MSG = {
  type: "message",
  id: "m-123",
  channel_id: "welcome",
  sender_id: "human-9",
  content: "@grok-bot 看下这个",
  mentioned_ids: ["grok-bot"],
  timestamp: "2026-08-28T10:00:00.000Z",
};

describe("buildWakePayload — what the receiver needs, nothing more", () => {
  test("carries chat_id + message_id + a content excerpt so the receiver can skip a fetch round", () => {
    const p = buildWakePayload(MSG);
    expect(p.channel_id).toBe("welcome");
    expect(p.message_id).toBe("m-123");
    expect(p.sender_id).toBe("human-9");
    expect(p.content).toContain("@grok-bot");
    expect(p.mentioned_ids).toEqual(["grok-bot"]);
    expect(p.type).toBe("message");
    expect(p.timestamp).toBe("2026-08-28T10:00:00.000Z");
  });

  test("NEVER carries the agentschat token (the ac_ key stays local)", () => {
    const p = buildWakePayload({ ...MSG, token: "ac_secret", agent_key: "ac_secret" });
    const body = JSON.stringify(p);
    expect(body).not.toContain("ac_secret");
    expect(body).not.toContain("token");
    expect(body).not.toContain("agent_key");
  });

  test("a long message is excerpted, not sent whole", () => {
    const long = { ...MSG, content: "x".repeat(5000) };
    const p = buildWakePayload(long);
    expect(p.content).toBeDefined();
    expect(p.content!.length).toBeLessThanOrEqual(500);
  });

  test("missing fields degrade to undefined, not a crash", () => {
    const p = buildWakePayload({ type: "message" });
    expect(p.type).toBe("message");
    expect(p.channel_id).toBeUndefined();
  });

  test("a credential pasted INTO the message body is redacted, not relayed", () => {
    // Same rule as every other outbound path (reply/edit/caption/status all call
    // redactSecrets): if someone pastes an ac_ key or JWT into a message, the wake
    // body must not carry it to the receiver.
    const p = buildWakePayload({ ...MSG, content: "key: ac_abcdefghijklmnopqrstuvwxyz and jwt eyJabcdefghijklmnopqrstuv.abc.def" });
    expect(p.content).toContain("ac_***REDACTED***");
    expect(p.content).toContain("***JWT_REDACTED***");
    expect(p.content).not.toContain("ac_abcdefghij");
    expect(p.content).not.toContain("eyJabcdefghij");
  });
});

describe("signWakeBody / verifyWakeSignature — HMAC over the raw body", () => {
  test("sign produces a hex HMAC-SHA256 of the body", () => {
    const sig = signWakeBody('{"a":1}', "secret-1");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test("verify accepts a valid signature, rejects a wrong secret", () => {
    const body = '{"type":"message","channel_id":"welcome"}';
    const sig = signWakeBody(body, "secret-1");
    expect(verifyWakeSignature(body, sig, ["secret-1"])).toBe(true);
    expect(verifyWakeSignature(body, sig, ["wrong"])).toBe(false);
  });

  test("rotation window: any secret in the list authenticates", () => {
    const body = "x";
    const sig = signWakeBody(body, "old");
    expect(verifyWakeSignature(body, sig, ["new", "old"])).toBe(true);
  });

  test("empty secret list never authenticates (control)", () => {
    const body = "x";
    const sig = signWakeBody(body, "s");
    expect(verifyWakeSignature(body, sig, [])).toBe(false);
  });

  test("tampered body fails (signature is over the exact bytes)", () => {
    const sig = signWakeBody('{"a":1}', "s");
    expect(verifyWakeSignature('{"a":2}', sig, ["s"])).toBe(false);
  });

  test("rejects malleable non-hex suffixes, prefixes, and wrong-length signatures", () => {
    const body = '{"a":1}';
    const sig = signWakeBody(body, "s");
    expect(verifyWakeSignature(body, `${sig}_extra`, ["s"])).toBe(false);
    expect(verifyWakeSignature(body, `sha256=${sig}`, ["s"])).toBe(false);
    expect(verifyWakeSignature(body, sig.slice(0, 62), ["s"])).toBe(false);
    expect(verifyWakeSignature(body, "", ["s"])).toBe(false);
  });

  test("grokPortFromGatewayConfig, sanitizeWakeLogUrl, fireWake body drain & fireZcodeWake stderr redaction", async () => {
    expect(grokPortFromGatewayConfig({ port: 1340 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: Infinity })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: NaN })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 0 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 70000 })).toBe(1340);
    expect(grokPortFromGatewayConfig({ port: 1340.5 })).toBe(1340);

    expect(sanitizeWakeLogUrl("https://user:pass@hook.example.com/wake?token=secret123#frag")).toBe(
      "https://hook.example.com/wake?[REDACTED]",
    );

    let canceled = 0;
    const wakeLogs: string[] = [];
    await fireWake(MSG, {
      url: "https://user:pass@hook.example.com/wake?secret=my_hook_token",
      fetchImpl: (async () => ({
        ok: false,
        status: 502,
        body: { cancel: async () => { canceled++; } },
      })) as any,
      logger: (m) => wakeLogs.push(m),
    });
    expect(canceled).toBe(1);
    expect(wakeLogs.join("\n")).not.toContain("my_hook_token");
    expect(wakeLogs.join("\n")).not.toContain("pass");

    const zLogs: string[] = [];
    await fireZcodeWake(MSG, {
      sessionId: "sess_redact_stderr",
      runCommandImpl: async () => ({ code: 1, stderr: "fatal auth error with ac_supersecrettoken123456" }),
      logger: (m) => zLogs.push(m),
    });
    expect(zLogs.join("\n")).not.toContain("ac_supersecrettoken123456");
    expect(zLogs.join("\n")).toContain("ac_***REDACTED***");
  });

  test("the signature header name is the contract", () => {
    expect(WAKE_SIG_HEADER).toBe("x-agentschat-signature");
  });
});

describe("buildWakePayload — session routing", () => {
  test("carries target_session_id when the bridge knows the bound session", () => {
    const payload = buildWakePayload(
      { id: "m1", channel_id: "dm-x", sender_id: "user" },
      { targetSessionId: "session-1" },
    );
    expect(payload.target_session_id).toBe("session-1");
  });

  test("omits target_session_id entirely when unbound (receivers keep their fallback)", () => {
    const payload = buildWakePayload({ id: "m1", channel_id: "dm-x", sender_id: "user" });
    expect("target_session_id" in payload).toBe(false);
  });

  test("an empty target is treated as unbound, not as an empty session id", () => {
    const payload = buildWakePayload({ id: "m1", channel_id: "dm-x" }, { targetSessionId: "" });
    expect("target_session_id" in payload).toBe(false);
  });
});

describe("resolveEnvWakeId — explicit stdio REST wake attribution", () => {
  test("forwards safe bounded AGENTSCHAT_WAKE_ID and preserves header name contract", () => {
    expect(WAKE_ID_HEADER).toBe("X-AgentsChat-Wake-Id");
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "wake_msg_9f81-ab02" })).toBe("wake_msg_9f81-ab02");
  });

  test("rejects missing, malformed, overlong, or credential-shaped values fail-closed", () => {
    expect(resolveEnvWakeId({})).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "bad header\r\ninject" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "a".repeat(129) })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "ac_live_secret_token_value" })).toBeUndefined();
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "sk-proj-secret" })).toBeUndefined();
  });

  test("fireZcodeWake escalates SIGTERM to SIGKILL when a child process ignores SIGTERM so session queue never deadlocks", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "zcode-sigkill-"));
    const script = join(dir, "stubborn-zcode.cjs");
    writeFileSync(
      script,
      `process.on("SIGTERM", () => {}); setInterval(() => {}, 60000);\n`,
      "utf8",
    );
    try {
      const t0 = Date.now();
      const ok = await fireZcodeWake(MSG, {
        sessionId: "sess_sigkill_test",
        zcodeBin: script,
        timeoutMs: 30,
        killGraceMs: 30,
        logger: () => {},
      });
      expect(ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveWindowsCliSpawn — safe shell:false Windows .exe/.cmd resolution", () => {
  test("passes commands unchanged on non-win32 except explicit .js/.cjs/.mjs entrypoints", () => {
    expect(resolveWindowsCliSpawn("codex", ["app-server"], { platform: "darwin" })).toEqual({
      cmd: "codex",
      args: ["app-server"],
    });
    expect(
      resolveWindowsCliSpawn("/opt/zcode/zcode.cjs", ["-p", "hi"], {
        platform: "linux",
        execPath: "/usr/bin/node",
      }),
    ).toEqual({
      cmd: "/usr/bin/node",
      args: ["/opt/zcode/zcode.cjs", "-p", "hi"],
    });
  });

  test("unwraps npm .cmd shim to node.exe + resolved JS script with zero cmd.exe metacharacter exposure, and prefers .exe when present", () => {
    const npmDir = "C:\\Users\\Boss\\AppData\\Roaming\\npm";
    const codexCmd = `${npmDir}\\codex.cmd`;
    const codexJs = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`;
    const zcodeExe = "C:\\Program Files\\ZCode\\zcode.exe";
    const files = new Map<string, string>([
      [
        codexCmd,
        `@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`,
      ],
      [codexJs, "// codex cli"],
      [zcodeExe, "MZ"],
    ]);
    const promptWithMetachars = `100% safe & calc.exe | "%APPDATA%" ^ !PATH!`;

    const resolvedCmd = resolveWindowsCliSpawn("codex", ["app-server", "--listen", "stdio://"], {
      platform: "win32",
      env: { Path: `C:\\Windows\\System32;${npmDir}` },
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsImpl: (p) => files.has(p),
      readTextImpl: (p) => files.get(p) || "",
    });
    expect(resolvedCmd).toEqual({
      cmd: "C:\\Program Files\\nodejs\\node.exe",
      args: [codexJs, "app-server", "--listen", "stdio://"],
    });

    const resolvedExe = resolveWindowsCliSpawn("zcode", ["-p", promptWithMetachars, "--resume", "sess_1"], {
      platform: "win32",
      env: { PATH: `C:\\Program Files\\ZCode;${npmDir}` },
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      existsImpl: (p) => files.has(p),
      readTextImpl: (p) => files.get(p) || "",
    });
    expect(resolvedExe).toEqual({
      cmd: zcodeExe,
      args: ["-p", promptWithMetachars, "--resume", "sess_1"],
    });
  });

  test("fireWake injects fresh ISO timestamp when msg.timestamp is absent before HMAC signing", async () => {
    let seenBody = "";
    let seenSig = "";
    await fireWake(
      {
        type: "message",
        id: "m-notime",
        channel_id: "room",
        sender_id: "u1",
        content: "hello",
      },
      {
        url: "http://127.0.0.1:9999/wake",
        secret: "s3cr3t",
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          seenBody = String(init?.body ?? "");
          const h = (init?.headers ?? {}) as Record<string, string>;
          seenSig = h[WAKE_SIG_HEADER] ?? "";
          return new Response("ok", { status: 202 });
        }) as unknown as typeof fetch,
      },
    );
    const parsed = JSON.parse(seenBody);
    expect(typeof parsed.timestamp).toBe("string");
    expect(Number.isFinite(Date.parse(parsed.timestamp))).toBe(true);
    expect(verifyWakeSignature(seenBody, seenSig, ["s3cr3t"])).toBe(true);
  });
});

describe("Campaign #108 KR3 — wake SSRF, symlink, 32-bit timer, CLI flag & DM parity hardening", () => {
  test("normalizeLoopbackLsAddress & fireAntigravityWake enforce strict loopback host:port to prevent CSRF token SSRF", async () => {
    expect(normalizeLoopbackLsAddress("127.0.0.1:42100")).toBe("127.0.0.1:42100");
    expect(normalizeLoopbackLsAddress("LOCALHOST:8080")).toBe("localhost:8080");
    expect(normalizeLoopbackLsAddress("[::1]:9090")).toBe("[::1]:9090");
    expect(normalizeLoopbackLsAddress("169.254.169.254:80")).toBeNull();
    expect(normalizeLoopbackLsAddress("attacker.example.com:443")).toBeNull();
    expect(normalizeLoopbackLsAddress("127.0.0.1:0")).toBeNull();
    expect(normalizeLoopbackLsAddress("127.0.0.1:70000")).toBeNull();
    expect(normalizeLoopbackLsAddress("127.0.0.1:8080/evil")).toBeNull();

    const hitUrls: string[] = [];
    const logs: string[] = [];
    const ok = await fireAntigravityWake(MSG, {
      conversationId: "conv-123",
      csrfToken: "csrf_super_secret",
      lsAddress: "169.254.169.254:80",
      ports: [51234],
      timeoutMs: 9_999_999_999,
      fetchImpl: (async (url: RequestInfo | URL) => {
        hitUrls.push(String(url));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      logger: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(hitUrls).toEqual(["http://127.0.0.1:51234/exa.language_server_pb.LanguageServerService/SendAgentMessage"]);
    expect(logs.join("\n")).toContain("rejected non-loopback or invalid lsAddress");
  });

  test("fireGrokWake rejects symlinked or >1MiB gatewayConfigPath fail-closed without network calls", async () => {
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "grok-wake-sec-"));
    try {
      const target = join(dir, "real-gw.json");
      const link = join(dir, "link-gw.json");
      const huge = join(dir, "huge-gw.json");
      writeFileSync(target, JSON.stringify({ token: "gw-secret", port: 1340 }), "utf8");
      symlinkSync(target, link);
      writeFileSync(huge, JSON.stringify({ token: "gw-secret", pad: "x".repeat(1_050_000) }), "utf8");

      let fetched = 0;
      await fireGrokWake(MSG, {
        gatewayConfigPath: link,
        agentId: "agent-1",
        fetchImpl: (async () => {
          fetched++;
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      });
      await fireGrokWake(MSG, {
        gatewayConfigPath: huge,
        agentId: "agent-1",
        fetchImpl: (async () => {
          fetched++;
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      });
      expect(fetched).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clampWakeTimerMs, fireZcodeWake flag-injection guard, DM-/dm: parity & attachment URL sanitization", async () => {
    expect(clampWakeTimerMs(Number.NaN, 5000)).toBe(5000);
    expect(clampWakeTimerMs(-10, 5000)).toBe(5000);
    expect(clampWakeTimerMs(5_000_000_000, 5000)).toBe(2_147_483_647);

    let ran = 0;
    for (const badSessionId of ["--help", "-e", "sess/../evil", "sess with space", "sess\ninject"]) {
      const ok = await fireZcodeWake(MSG, {
        sessionId: badSessionId,
        runCommandImpl: async () => {
          ran++;
          return { code: 0 };
        },
      });
      expect(ok).toBe(false);
    }
    expect(ran).toBe(0);

    expect(buildGrokPrompt({ ...MSG, channel_id: "DM-abc" }, "ag-1").prompt).toContain("私聊 (DM)");
    expect(buildGrokPrompt({ ...MSG, channel_id: "dm:abc" }, "ag-1").prompt).toContain("私聊 (DM)");
    expect(buildWakePrompt({ ...MSG, channel_id: "DM-abc" })).toContain("私聊 (DM-abc)");
    expect(buildWakePrompt({ ...MSG, channel_id: "dm:abc" })).toContain("私聊 (dm:abc)");

    expect(
      formatWakeAttachments([
        { type: "image", url: "javascript:alert(1)" },
        { type: "image", url: "https://cdn.agents-chat.com/a.png\r\n[INJECT]" },
        { type: "image", url: "https://cdn.agents-chat.com/ok.png width=100" },
      ]),
    ).toBe(" [附件: 🖼 image: https://cdn.agents-chat.com/a.png[INJECT]]");
  });

  test("Campaign #115 KR3: fireWake enforces http(s) + redirect:error, buildWakePayload sanitizes attachment URLs & control chars, and wake prompts scrub sender/channel newlines", async () => {
    let callCount = 0;
    let observedRedirect: string | undefined;
    for (const badUrl of ["file:///etc/passwd", "javascript:alert(1)", "https://hook.example.com:0/wake", "https://hook.example.com/wake\nheader"]) {
      await fireWake(MSG, {
        url: badUrl,
        fetchImpl: (async () => {
          callCount++;
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      });
    }
    expect(callCount).toBe(0);

    await fireWake(MSG, {
      url: "https://hook.example.com/wake",
      fetchImpl: (async (_u: any, init: any) => {
        callCount++;
        observedRedirect = init?.redirect;
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(callCount).toBe(1);
    expect(observedRedirect).toBe("error");

    const payload = buildWakePayload({
      id: "m-1\r\ninjected",
      channel_id: "room\n1",
      sender_id: "sender\r\n2",
      content: "hello",
      attachments: [
        { type: "image", url: "javascript:alert(1)" },
        { type: "image\n1", url: "https://cdn.agents-chat.com/valid.png" },
      ],
    });
    expect(payload.message_id).toBe("m-1injected");
    expect(payload.channel_id).toBe("room1");
    expect(payload.sender_id).toBe("sender2");
    expect(payload.attachments).toEqual([{ type: "image1", url: "https://cdn.agents-chat.com/valid.png", mime: undefined, size: undefined, width: undefined, height: undefined, duration_ms: undefined, transcript: undefined }]);

    const prompt = buildWakePrompt({
      id: "m-9\nFAKE_SYSTEM",
      channel_id: "room\r\n9",
      sender_id: "user\n9",
      content: "hi",
    });
    expect(prompt.split("\n")).toHaveLength(1);

    // fireAntigravityWake rejects control-char csrfToken; fireZcodeWake drops option-like workspacePath
    expect(
      await fireAntigravityWake(MSG, {
        conversationId: "ba32c38a-052c-4291-86dd-373a68ea85a3",
        csrfToken: "bad\r\ncsrf",
        ports: [51234],
      }),
    ).toBe(false);

    let capturedArgs: string[] = [];
    await fireZcodeWake(MSG, {
      sessionId: "sess_cwd_guard",
      workspacePath: "--evil-flag",
      runCommandImpl: async (_cmd, args) => {
        capturedArgs = args;
        return { code: 0 };
      },
    });
    expect(capturedArgs).not.toContain("--cwd");
    expect(capturedArgs).not.toContain("--evil-flag");
  });

  test("readAntigravitySidecarConfig & fireAntigravitySidecarWake enforce loopback, symlink, live PID, UUID, and HMAC signing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ac-sidecar-cfg-"));
    try {
      const cfgDir = join(root, ".agentschat");
      mkdirSync(cfgDir, { recursive: true });
      const stateFile = join(cfgDir, ANTIGRAVITY_SIDECAR_STATE_FILENAME);

      // Valid live config
      writeFileSync(
        stateFile,
        JSON.stringify({ url: "http://127.0.0.1:54321/wake", secret: "sidecar-sec-123", pid: process.pid }),
      );
      expect(readAntigravitySidecarConfig(cfgDir)).toEqual({
        url: "http://127.0.0.1:54321/wake",
        secret: "sidecar-sec-123",
        pid: process.pid,
      });

      // Dead PID rejected
      expect(readAntigravitySidecarConfig(cfgDir, { isPidAliveFn: () => false })).toBeNull();

      // Non-loopback URL rejected (SSRF guard)
      writeFileSync(
        stateFile,
        JSON.stringify({ url: "http://169.254.169.254:80/wake", secret: "sidecar-sec-123", pid: process.pid }),
      );
      expect(readAntigravitySidecarConfig(cfgDir)).toBeNull();

      // __proto__ pollution rejected
      writeFileSync(
        stateFile,
        `{"url":"http://127.0.0.1:54321/wake","secret":"sec","pid":${process.pid},"__proto__":{}}`,
      );
      expect(readAntigravitySidecarConfig(cfgDir)).toBeNull();

      // Symlinked state file rejected
      const outside = join(root, "outside.json");
      writeFileSync(
        outside,
        JSON.stringify({ url: "http://127.0.0.1:54321/wake", secret: "sidecar-sec-123", pid: process.pid }),
      );
      const symDir = join(root, "symcfg");
      mkdirSync(symDir, { recursive: true });
      symlinkSync(outside, join(symDir, ANTIGRAVITY_SIDECAR_STATE_FILENAME));
      expect(readAntigravitySidecarConfig(symDir)).toBeNull();

      // fireAntigravitySidecarWake rejects invalid UUID or off-loopback URL before any fetch
      let fetched = 0;
      const stubFetch = (async () => {
        fetched++;
        return new Response("ok", { status: 200 });
      }) as unknown as typeof fetch;
      expect(
        await fireAntigravitySidecarWake(MSG, {
          conversationId: "not-a-uuid",
          sidecarUrl: "http://127.0.0.1:54321/wake",
          secret: "sec",
          fetchImpl: stubFetch,
        }),
      ).toBe(false);
      expect(
        await fireAntigravitySidecarWake(MSG, {
          conversationId: "ba32c38a-052c-4291-86dd-373a68ea85a3",
          sidecarUrl: "http://example.com:54321/wake",
          secret: "sec",
          fetchImpl: stubFetch,
        }),
      ).toBe(false);
      expect(fetched).toBe(0);

      // Valid sidecar POST signs raw body with WAKE_SIG_HEADER
      let sentSig = "";
      let sentBody = "";
      const ok = await fireAntigravitySidecarWake(
        { id: "m-sidecar-1", channel_id: "dm-boss", sender_id: "boss", content: "ping" },
        {
          conversationId: "ba32c38a-052c-4291-86dd-373a68ea85a3",
          sidecarUrl: "http://127.0.0.1:54321/wake",
          secret: "sec-abc",
          fetchImpl: (async (_u: any, init: any) => {
            sentSig = init?.headers?.[WAKE_SIG_HEADER] || "";
            sentBody = String(init?.body || "");
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
      expect(ok).toBe(true);
      expect(verifyWakeSignature(sentBody, sentSig, ["sec-abc"])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("antigravity-wake-sidecar.mjs verifies HMAC signatures, invokes agentapi send-message cleanly, and cleans up state on SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "ac-sidecar-e2e-"));
    const stateFile = join(root, "state", "antigravity-sidecar.json");
    const mockLogFile = join(root, "agentapi-calls.jsonl");
    const mockAgentApi = join(root, "mock-agentapi.js");
    writeFileSync(
      mockAgentApi,
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(mockLogFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`,
      { mode: 0o755 },
    );
    chmodSync(mockAgentApi, 0o755);

    const sidecarScript = resolve(import.meta.dir, "../scripts/antigravity-wake-sidecar.mjs");
    const child = spawn("node", [sidecarScript], {
      env: {
        ...process.env,
        AGENTSCHAT_AGY_SIDECAR_STATE: stateFile,
        AGENTSCHAT_AGENTAPI_BIN: mockAgentApi,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      for (let i = 0; i < 60 && !existsSync(stateFile); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(stateFile)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(stateFile).mode & 0o777).toBe(0o600);
      }

      const state = JSON.parse(readFileSync(stateFile, "utf8")) as { url: string; secret: string; pid: number };
      expect(state.pid).toBe(child.pid!);
      expect(state.url.startsWith("http://127.0.0.1:")).toBe(true);

      const healthUrl = state.url.replace(/\/wake$/, "/health");
      const healthRes = await fetch(healthUrl);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toEqual({ ok: true, pid: child.pid! });

      // Unsigned request -> 401
      const cid = "567abecb-afce-4fb8-8e1f-de6c231f6d61";
      const unsignedRes = await fetch(state.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: cid, display_title: "AgentsChat #dm-boss", prompt: "ping" }),
      });
      expect(unsignedRes.status).toBe(401);

      // Wrong signature -> 401
      const badSigBody = JSON.stringify({ recipient: cid, display_title: "AgentsChat #dm-boss", prompt: "ping" });
      const badSigRes = await fetch(state.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [WAKE_SIG_HEADER]: signWakeBody(badSigBody, "wrong-secret") },
        body: badSigBody,
      });
      expect(badSigRes.status).toBe(401);

      // Signed non-UUID recipient -> 400
      const badUuidBody = JSON.stringify({ recipient: "not-a-uuid", display_title: "AgentsChat", prompt: "ping" });
      const badUuidRes = await fetch(state.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", [WAKE_SIG_HEADER]: signWakeBody(badUuidBody, state.secret) },
        body: badUuidBody,
      });
      expect(badUuidRes.status).toBe(400);

      // Valid wake via fireAntigravitySidecarWake -> 200 and mock agentapi receives exact send-message args
      const sent = await fireAntigravitySidecarWake(
        { id: "msg-e2e-1", channel_id: "dm-nkdfuq", sender_id: "swswordholy", content: "ping" },
        { conversationId: cid, sidecarUrl: state.url, secret: state.secret },
      );
      expect(sent).toBe(true);

      const lines = readFileSync(mockLogFile, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const invokedArgs = JSON.parse(lines[0]!) as string[];
      expect(invokedArgs[0]).toBe("send-message");
      expect(invokedArgs[1]).toBe("--title=AgentsChat #dm-nkdfuq");
      expect(invokedArgs[2]).toBe(cid);
      expect(invokedArgs[3]).toContain("[AgentsChat] swswordholy 在私聊 (dm-nkdfuq)给你发了消息");
      expect(invokedArgs[3]).toContain("ping");

      // SIGTERM cleanly removes state file
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
        setTimeout(() => resolveExit(), 3000);
      });
      expect(existsSync(stateFile)).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("antigravity-wake-sidecar.mjs resolves Windows .bat shims to language_server.exe (shell:false) and handles Windows EPERM atomic state replace", async () => {
    const sidecarMod = await import("../scripts/antigravity-wake-sidecar.mjs");
    const { parseBatchExecTarget, resolveAgentApiCommand, writeStateFileAtomically } = sidecarMod;

    // 1. Windows agentapi.bat delegating to quoted D:\Apps\Antigravity\resources\bin\language_server.exe
    const winBat = "C:\\Users\\Administrator\\.gemini\\antigravity\\bin\\agentapi.bat";
    const winLsExe = "D:\\Apps\\Antigravity\\resources\\bin\\language_server.exe";
    const parsedAbsolute = parseBatchExecTarget(
      winBat,
      `@echo off\r\n"${winLsExe}" agentapi %*\r\n`,
      { existsSyncFn: (p: string) => p.toLowerCase() === winLsExe.toLowerCase() },
    );
    expect(parsedAbsolute).toEqual({
      command: winLsExe,
      prefixArgs: ["agentapi"],
    });

    // 2. Windows %~dp0 relative batch shim
    const dp0Bat = "D:\\Apps\\Antigravity\\resources\\bin\\agentapi.cmd";
    const parsedDp0 = parseBatchExecTarget(
      dp0Bat,
      `@"%~dp0language_server.exe" agentapi %*\r\n`,
      { existsSyncFn: (p: string) => p.toLowerCase() === winLsExe.toLowerCase() },
    );
    expect(parsedDp0).toEqual({
      command: winLsExe,
      prefixArgs: ["agentapi"],
    });

    // 3. resolveAgentApiCommand on Windows finds agentapi.bat in ~/.gemini/antigravity/bin and unwraps to .exe
    const resolvedFromHome = resolveAgentApiCommand({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\Administrator", PATH: "C:\\Windows\\System32" },
      existsSyncFn: (p: string) => {
        const lower = p.toLowerCase();
        return lower === winBat.toLowerCase() || lower === winLsExe.toLowerCase();
      },
      readFileSyncFn: () => `@"${winLsExe}" agentapi %*\r\n`,
    });
    expect(resolvedFromHome).toEqual({
      command: winLsExe,
      prefixArgs: ["agentapi"],
    });

    // 4. Explicit AGENTSCHAT_AGENTAPI_BIN pointing straight to language_server.exe adds "agentapi" subcommand
    const resolvedDirectLs = resolveAgentApiCommand({
      platform: "win32",
      env: { AGENTSCHAT_AGENTAPI_BIN: winLsExe },
      existsSyncFn: () => true,
    });
    expect(resolvedDirectLs).toEqual({
      command: winLsExe,
      prefixArgs: ["agentapi"],
    });

    // 5. Fallback to %LOCALAPPDATA%\Programs\Antigravity\resources\bin\language_server.exe when no shim on PATH
    const defaultInstallExe = "C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe";
    const resolvedFallback = resolveAgentApiCommand({
      platform: "win32",
      env: {
        USERPROFILE: "C:\\Users\\Alice",
        LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
      },
      existsSyncFn: (p: string) => p.toLowerCase() === defaultInstallExe.toLowerCase(),
      readFileSyncFn: () => "",
    });
    expect(resolvedFallback).toEqual({
      command: defaultInstallExe,
      prefixArgs: ["agentapi"],
    });

    // 6. Unresolved .bat fails closed with unresolvedBatch instead of invoking cmd.exe
    const unresolved = resolveAgentApiCommand({
      platform: "win32",
      env: { AGENTSCHAT_AGENTAPI_BIN: "C:\\Custom\\agentapi.bat", PATH: "" },
      existsSyncFn: (p: string) => p.toLowerCase() === "c:\\custom\\agentapi.bat",
      readFileSyncFn: () => "@echo broken shim\r\n",
    });
    expect((unresolved as { unresolvedBatch?: string }).unresolvedBatch).toBe("C:\\Custom\\agentapi.bat");

    // 7. writeStateFileAtomically handles Windows EPERM on rename over existing file without leaving .tmp files
    const root = mkdtempSync(join(tmpdir(), "ac-win-atomic-"));
    try {
      const target = join(root, "antigravity-sidecar.json");
      writeFileSync(target, JSON.stringify({ url: "http://127.0.0.1:1/wake", secret: "old", pid: 1 }));
      const realFs = await import("node:fs");
      let renameAttempts = 0;
      const winMockFs = {
        ...realFs,
        renameSync(from: string, to: string) {
          renameAttempts++;
          if (renameAttempts === 1) {
            const err: any = new Error("EPERM: operation not permitted");
            err.code = "EPERM";
            throw err;
          }
          return realFs.renameSync(from, to);
        },
      };
      writeStateFileAtomically(
        target,
        { url: "http://127.0.0.1:54321/wake", secret: "fresh-secret", pid: process.pid },
        { fs: winMockFs, platform: "win32" },
      );
      expect(renameAttempts).toBe(2);
      const written = JSON.parse(readFileSync(target, "utf8"));
      expect(written.secret).toBe("fresh-secret");
      expect(written.pid).toBe(process.pid);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensureAntigravityWakeSidecarInstalled installs, upgrades wake-sidecar.mjs while preserving sidecar.json, rejects symlinks, and works via --install-agy-sidecar CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "ac-sidecar-install-"));
    try {
      const geminiCfg = join(root, ".gemini", "config");
      const first = ensureAntigravityWakeSidecarInstalled({ geminiConfigDir: geminiCfg });
      expect(first.status).toBe("installed");
      expect(existsSync(first.scriptPath)).toBe(true);
      expect(existsSync(first.manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8"));
      expect(manifest.display_name).toBe("AgentsChat Wake Bridge");
      expect(manifest.command).toBe("node");
      expect(manifest.args).toEqual(["wake-sidecar.mjs"]);

      // Second run is idempotent
      const second = ensureAntigravityWakeSidecarInstalled({ geminiConfigDir: geminiCfg });
      expect(second.status).toBe("up_to_date");

      // Customize sidecar.json and simulate outdated script -> upgrades script while preserving manifest
      writeFileSync(
        first.manifestPath,
        JSON.stringify({ ...manifest, env: { AGENTSCHAT_AGENTAPI_BIN: "D:\\Custom\\language_server.exe" } }, null, 2),
      );
      writeFileSync(first.scriptPath, "// stale sidecar v1\n");
      const upgraded = ensureAntigravityWakeSidecarInstalled({ geminiConfigDir: geminiCfg });
      expect(upgraded.status).toBe("updated");
      expect(readFileSync(first.scriptPath, "utf8")).toContain("parseBatchExecTarget");
      expect(JSON.parse(readFileSync(first.manifestPath, "utf8")).env.AGENTSCHAT_AGENTAPI_BIN).toBe(
        "D:\\Custom\\language_server.exe",
      );

      // Symlinked sidecar script is refused safely
      const symGemini = join(root, "sym-gemini");
      const symDir = join(symGemini, "sidecars", "agentschat-wake");
      mkdirSync(symDir, { recursive: true });
      const victim = join(root, "victim.txt");
      writeFileSync(victim, "untouched");
      symlinkSync(victim, join(symDir, "wake-sidecar.mjs"));
      const blocked = ensureAntigravityWakeSidecarInstalled({ geminiConfigDir: symGemini });
      expect(blocked.status).toBe("error");
      expect(readFileSync(victim, "utf8")).toBe("untouched");

      // One-shot CLI `--install-agy-sidecar`
      const cliGemini = join(root, "cli-gemini");
      const cliPath = resolve(import.meta.dir, "../src/cli.mjs");
      const proc = spawn("bun", [cliPath, "--install-agy-sidecar"], {
        env: { ...process.env, AGENTSCHAT_GEMINI_CONFIG_DIR: cliGemini },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      proc.stdout.on("data", (c) => { stdout += c.toString(); });
      const exitCode = await new Promise<number>((res) => proc.on("exit", (c) => res(c ?? 1)));
      expect(exitCode).toBe(0);
      const outJson = JSON.parse(stdout);
      expect(outJson.ok).toBe(true);
      expect(outJson.status).toBe("installed");
      expect(existsSync(outJson.script)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
