import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDshCordisPatchFile,
  buildMcpAgentsChatArgs,
  mergeDshCordisPatch,
  resolveDshPatchPath,
} from "../src/patch.ts";
import { loadDshConfig, main, registerOnly, runDshHeadlessResponder, safeDshConfig } from "../src/cli.ts";
import { MuseBridge } from "../../muse/src/bridge.ts";
import { MuseAgentChatClient } from "../../muse/src/client.ts";
import {
  apply as applyInboundBridge,
  isAllowedLocalOrigin,
  MAX_HTTP_BODY_BYTES,
  verifySignature,
} from "../inbound-bridge/index.js";

const ROOT = resolve(import.meta.dir, "../..");

test("DSH rejects embedded URL credentials in configuration and patch arguments", () => {
  const env = { AGENTCHAT_AGENT_ID: "bot", AGENTCHAT_TOKEN: "test-token" };
  for (const auth of ["user:secret@", "user@", ":secret@"]) {
    expect(() => buildMcpAgentsChatArgs({ apiUrl: `https://${auth}test.invalid` })).toThrow(/Invalid/);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_REST_URL: `https://${auth}test.invalid` })).toThrow(/Invalid/);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: `wss://${auth}test.invalid/ws` })).toThrow(/Invalid/);
  }
});

test("patch and registration reject symlinked parents and ancestors without changing victims", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-parent-"));
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ agentId: "bot", token: "test-token" })) as unknown as typeof fetch);
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "link"));
    for (const home of [join(dir, "link"), join(dir, "link", "missing")]) {
      expect(() => applyDshCordisPatchFile({ dshHome: home })).toThrow(/parent/);
      await expect(registerOnly("bot", "https://test.invalid", join(home, "dsh.json"))).rejects.toThrow(/parent/);
    }
    expect(request).not.toHaveBeenCalled();
    expect(readdirSync(real)).toEqual([]);
    applyDshCordisPatchFile({ dshHome: real });
    await registerOnly("bot", "https://test.invalid", join(real, "dsh.json"));
    expect(readdirSync(real).sort()).toEqual(["cordis.patch.yml", "dsh.json"]);
    expect(JSON.parse(readFileSync(join(real, "dsh.json"), "utf8"))).toEqual({ agentId: "bot", token: "test-token" });
  } finally { request.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("CLI missing values reject a following flag without network IO", async () => {
  const request = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    await expect(main(["--register-only", "--name", "--send", "channel"])).rejects.toThrow(/requires --name/);
    expect(request).not.toHaveBeenCalled();
  } finally { request.mockRestore(); }
});

test("exclusive temporary writes preserve colliding symlinks and their targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-exclusive-"));
  const random = spyOn(crypto, "randomBytes").mockImplementation((() => Buffer.from("12345678", "hex")) as typeof crypto.randomBytes);
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ agentId: "bot", token: "test-token" })) as unknown as typeof fetch);
  try {
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    for (const name of ["cordis.patch.yml", "dsh.json"]) {
      const target = join(dir, name);
      const temp = `${target}.${process.pid}.12345678.tmp`;
      symlinkSync(victim, temp);
      if (name === "dsh.json") {
        await expect(registerOnly("bot", "https://test.invalid", target)).rejects.toThrow(/EEXIST/);
      } else {
        expect(() => applyDshCordisPatchFile({ dshHome: dir })).toThrow(/EEXIST/);
      }
      expect(readFileSync(victim, "utf8")).toBe("untouched");
      expect(existsSync(temp)).toBe(true);
      expect(existsSync(target)).toBe(false);
    }
  } finally { random.mockRestore(); request.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("headless responder defaults invalid timeouts and clamps overflow without killing a valid child", async () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "dsh-timeout-"));
  try {
    const bin = join(dir, "responder");
    writeFileSync(bin, "#!/bin/sh\nsleep 0.03\nprintf 'reply'\n", { mode: 0o700 });
    for (const timeoutMs of [NaN, Infinity, -Infinity, 0, -1, 2 ** 31, Number.MAX_VALUE]) {
      expect(await runDshHeadlessResponder("hello", { dshBin: bin, timeoutMs })).toBe("reply");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("listen classifies uppercase legacy DMs as direct channels", async () => {
  const priorId = process.env.AGENTCHAT_AGENT_ID;
  const priorToken = process.env.AGENTCHAT_TOKEN;
  process.env.AGENTCHAT_AGENT_ID = "dsh-test-bot";
  process.env.AGENTCHAT_TOKEN = "test-token";
  let kinds: unknown;
  const start = spyOn(MuseBridge.prototype, "start").mockImplementation(async function (this: MuseBridge) {
    kinds = (this as unknown as { opts: { channelKinds: unknown } }).opts.channelKinds;
  });
  const closed = spyOn(MuseAgentChatClient.prototype, "waitUntilClosed").mockResolvedValue();
  try {
    await main(["--listen", "--channel", "DM-legacy", "--channel", "dm-lower", "--channel", "group"]);
    expect(kinds).toEqual({ "DM-legacy": "direct", "dm-lower": "direct", group: "group" });
    await expect(main(["--send", "--text", "hi"])).rejects.toThrow(/requires a channel id/);
  } finally {
    start.mockRestore(); closed.mockRestore();
    if (priorId === undefined) delete process.env.AGENTCHAT_AGENT_ID; else process.env.AGENTCHAT_AGENT_ID = priorId;
    if (priorToken === undefined) delete process.env.AGENTCHAT_TOKEN; else process.env.AGENTCHAT_TOKEN = priorToken;
  }
});

describe("DeepSeek Harness (dsh) integration", () => {
  test("package.json declares full dsh bundle (host + client + cordis.patch.yml) and ships all entrypoints", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    expect(pkg.dsh?.client?.platform).toBe("web");
    expect(pkg.dsh?.client?.immediately).toBe(true);
    expect(pkg.dsh?.client?.inject).toContain("@deepseek-ai/dsh-client-ui-conversation");
    expect(pkg.exports?.["."]).toBe("./dsh/plugin.js");
    expect(pkg.exports?.["./client"]).toBe("./dsh/client.js");
    expect(pkg.exports?.["./cordis.patch.yml"]).toBe("./cordis.patch.yml");
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(pkg.files).toContain("cordis.patch.yml");
    expect(pkg.files).toContain("dsh/");
    expect(pkg.files).toContain("dist/dsh.js");

    const bundlePatch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
    expect(bundlePatch).toContain("id: mcp-agentschat");
    expect(bundlePatch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(bundlePatch).toContain("serverName: agentschat");
    expect(bundlePatch).toContain("id: agentschat-dsh-bundle");
    expect(bundlePatch).toContain("name: 'agentschat-mcp'");

    const hostEntry = readFileSync(join(ROOT, "dsh/plugin.js"), "utf8");
    expect(hostEntry).toContain("export const name = 'agentschat-mcp'");
    expect(hostEntry).toContain("applyInboundBridge");

    const clientEntry = readFileSync(join(ROOT, "dsh/client.js"), "utf8");
    expect(clientEntry).toContain("window.__ModuleLoader__.load");
    expect(clientEntry).toContain("id: 'agentschat-mcp'");
    expect(clientEntry).toContain("'/create'");
  });

  test("mergeDshCordisPatch handles empty and [] patch files", () => {
    const emptyRes = mergeDshCordisPatch("");
    expect(emptyRes.changed).toBe(true);
    expect(emptyRes.content).toContain("- insert:");
    expect(emptyRes.content).toContain("- id: mcp-agentschat");
    expect(emptyRes.content).toContain("name: '@deepseek-ai/dsh-mcp-client'");

    const arrayRes = mergeDshCordisPatch("# comment\n[]\n", {
      agentsChatProfile: "DSH_Bot",
      apiUrl: "https://agents-chat.com",
    });
    expect(arrayRes.changed).toBe(true);
    expect(arrayRes.content).toContain("# comment");
    expect(arrayRes.content).not.toContain("[]");
    expect(arrayRes.content).toContain("- '--profile'");
    expect(arrayRes.content).toContain("- 'DSH_Bot'");
    expect(arrayRes.content).toContain("- '--url'");
    expect(arrayRes.content).toContain("- 'https://agents-chat.com'");
  });

  test("mergeDshCordisPatch preserves existing - insert: rows and is idempotent", () => {
    const existing = [
      "# Machine-local DSH patch layer",
      "- insert:",
      "    - id: openai-fetch-proxy",
      "      name: 'file:///Users/test/.dsh/plugins/openai-proxy/index.js'",
      "",
    ].join("\n");

    const first = mergeDshCordisPatch(existing, { agentsChatProfile: "Jack" });
    expect(first.changed).toBe(true);
    expect(first.content).toContain("id: openai-fetch-proxy");
    expect(first.content).toContain("id: mcp-agentschat");
    expect(first.content).toContain("- 'Jack'");

    const second = mergeDshCordisPatch(first.content, { agentsChatProfile: "Jack" });
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  test("applyDshCordisPatchFile writes to profile or home path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-patch-test-"));
    try {
      const homePatch = resolveDshPatchPath({ dshHome: dir });
      expect(homePatch).toBe(join(dir, "cordis.patch.yml"));

      const res1 = applyDshCordisPatchFile({ dshHome: dir, dshProfile: "desktop", agentsChatProfile: "DshDesktop" });
      expect(res1.changed).toBe(true);
      expect(res1.patchPath).toBe(join(dir, "profiles", "desktop", "cordis.patch.yml"));
      expect(readFileSync(res1.patchPath, "utf8")).toContain("DshDesktop");

      const res2 = applyDshCordisPatchFile({ dshHome: dir, dshProfile: "desktop", agentsChatProfile: "DshDesktop" });
      expect(res2.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadDshConfig reads profile file and redacts token in safeDshConfig", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-cfg-test-"));
    try {
      const profilePath = join(dir, "dsh.json");
      writeFileSync(
        profilePath,
        JSON.stringify({ agentId: "dsh-agent-1", token: "ac_secret_token_123456" }),
        "utf8",
      );
      const cfg = loadDshConfig({}, profilePath);
      expect(cfg.agentId).toBe("dsh-agent-1");
      expect(cfg.token).toBe("ac_secret_token_123456");
      const safe = safeDshConfig(cfg);
      expect(safe.agentId).toBe("dsh-agent-1");
      expect(String(safe.token)).not.toContain("secret_token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildMcpAgentsChatArgs constructs expected CLI flags", () => {
    expect(buildMcpAgentsChatArgs()).toEqual(["-y", "agentschat-mcp@latest"]);
    expect(
      buildMcpAgentsChatArgs({ agentsChatProfile: "MyDsh", apiUrl: "https://agents-chat.com" }),
    ).toEqual(["-y", "agentschat-mcp@latest", "--profile", "MyDsh", "--url", "https://agents-chat.com"]);
  });

  test("Campaign #93: mergeDshCordisPatch splices inside - insert: before later - replace: blocks and matches 2-space indent", () => {
    const multiBlock = [
      "# Multi-block patch file",
      "- insert:",
      "  - id: local-proxy",
      "    name: 'file:///tmp/proxy.js'",
      "",
      "- replace:",
      "  - id: ui-settings",
      "    config:",
      "      theme: 'dark'",
      "",
    ].join("\n");

    const res = mergeDshCordisPatch(multiBlock, { agentsChatProfile: "MultiBot" });
    expect(res.changed).toBe(true);
    const insertIdx = res.content.indexOf("- insert:");
    const mcpIdx = res.content.indexOf("  - id: mcp-agentschat");
    const replaceIdx = res.content.indexOf("- replace:");
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(mcpIdx).toBeGreaterThan(insertIdx);
    // Must appear BEFORE `- replace:`, not appended to EOF inside `- replace:`!
    expect(mcpIdx).toBeLessThan(replaceIdx);
    expect(res.content).toContain("  - id: mcp-agentschat\n    name: '@deepseek-ai/dsh-mcp-client'");
    expect(mergeDshCordisPatch(res.content).changed).toBe(false);
  });

  test("Campaign #93: resolveDshPatchPath rejects traversal profiles and applyDshCordisPatchFile leaves no .tmp residue", () => {
    expect(() => resolveDshPatchPath({ dshProfile: "../escape" })).toThrow("Invalid DSH profile name");
    expect(() => resolveDshPatchPath({ dshProfile: "a/b" })).toThrow("Invalid DSH profile name");
    expect(() => resolveDshPatchPath({ dshProfile: "   " })).toThrow("Invalid DSH profile name");
  });

  test("Campaign #96: patch & CLI helpers block prototype keys, flag injection, symlinks, and invalid URLs", async () => {
    expect(() => resolveDshPatchPath({ dshProfile: "foo..bar" })).toThrow("Invalid DSH profile name");
    expect(() => resolveDshPatchPath({ dshProfile: "__proto__" })).toThrow("Invalid DSH profile name");
    expect(() => resolveDshPatchPath({ dshProfile: "constructor" })).toThrow("Invalid DSH profile name");

    expect(() => buildMcpAgentsChatArgs({ packageSpec: "--eval=evil" })).toThrow("Invalid packageSpec");
    expect(() => buildMcpAgentsChatArgs({ agentsChatProfile: "--url=https://evil.example" })).toThrow(
      "Invalid AgentsChat profile name",
    );
    expect(() => buildMcpAgentsChatArgs({ agentsChatProfile: "__proto__" })).toThrow(
      "Invalid AgentsChat profile name",
    );
    expect(() => buildMcpAgentsChatArgs({ apiUrl: "javascript:alert(1)" })).toThrow("Invalid AgentsChat API URL");
    expect(() => buildMcpAgentsChatArgs({ apiUrl: "--flag" })).toThrow("Invalid AgentsChat API URL");

    const dir = mkdtempSync(join(tmpdir(), "dsh-c96-patch-"));
    try {
      const target = join(dir, "victim.yml");
      writeFileSync(target, "keep: true\n", "utf8");
      const linkPatch = join(dir, "cordis.patch.yml");
      symlinkSync(target, linkPatch);
      expect(() => applyDshCordisPatchFile({ dshHome: dir })).toThrow(/non-regular or symlinked/);
      expect(readFileSync(target, "utf8")).toBe("keep: true\n");

      const cfgLink = join(dir, "dsh-link.json");
      const realCfg = join(dir, "real-dsh.json");
      writeFileSync(realCfg, JSON.stringify({ agentId: "bot-1", token: "ac_1234567890" }), "utf8");
      symlinkSync(realCfg, cfgLink);
      expect(() => loadDshConfig({}, cfgLink)).toThrow(/Missing AgentsChat identity/);
      expect(() => loadDshConfig({ AGENTCHAT_AGENT_ID: "   ", AGENTCHAT_TOKEN: "ac_1234567890" }, join(dir, "none.json"))).toThrow(
        /Missing AgentsChat identity/,
      );
      expect(() =>
        loadDshConfig(
          { AGENTCHAT_AGENT_ID: "bot-1", AGENTCHAT_TOKEN: "ac_1234567890", AGENTCHAT_WS_URL: "https://not-ws.example" },
          join(dir, "none.json"),
        ),
      ).toThrow(/Unsupported AgentChat WebSocket protocol/);

      expect(await runDshHeadlessResponder("hi", { dshProfile: "--evil-flag" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Campaign #96: verifySignature enforces exact 64-hex HMAC and isAllowedLocalOrigin rejects external/null origins", () => {
    const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const body = '{"message_id":"m1","content":"hello"}';
    const validSig = createHmac("sha256", secret).update(body, "utf8").digest("hex");

    expect(verifySignature(body, validSig, secret)).toBe(true);
    expect(verifySignature(body, `sha256=${validSig}`, secret)).toBe(true);
    // Reject trailing non-hex garbage that Buffer.from(..., 'hex') would otherwise silently truncate!
    expect(verifySignature(body, `${validSig}zzzz`, secret)).toBe(false);
    expect(verifySignature(body, validSig.slice(0, 62), secret)).toBe(false);
    expect(verifySignature(body, "g".repeat(64), secret)).toBe(false);

    expect(isAllowedLocalOrigin("http://127.0.0.1:8799")).toBe(true);
    expect(isAllowedLocalOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedLocalOrigin("http://[::1]:5173")).toBe(true);
    expect(isAllowedLocalOrigin("tauri://localhost")).toBe(true);
    expect(isAllowedLocalOrigin("app://dsh.local")).toBe(true);
    expect(isAllowedLocalOrigin("file://")).toBe(true);

    expect(isAllowedLocalOrigin("https://evil.example")).toBe(false);
    expect(isAllowedLocalOrigin("http://127.0.0.1.evil.example")).toBe(false);
    expect(isAllowedLocalOrigin("http://127.0.0.1:99999")).toBe(false);
    expect(isAllowedLocalOrigin("null")).toBe(false);
    expect(isAllowedLocalOrigin("")).toBe(false);
  });

  test("Campaign #96: inbound bridge loopback server blocks cross-origin CSRF, prototype binds, and >64KiB bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-c96-bridge-"));
    let cleanup: (() => void) | undefined;
    try {
      const profilesDir = join(dir, "profiles");
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(
        join(profilesDir, "DshTest.json"),
        JSON.stringify({ agent_id: "dsh-bot-96", token: "ac_secret_96969696", display_name: "DSH 96" }),
        "utf8",
      );
      writeFileSync(
        join(dir, "session-binds.json"),
        '{"__proto__":"DshTest","session-good":"DshTest"}',
        "utf8",
      );

      const delivered: unknown[] = [];
      let listenPort = 0;
      await new Promise<void>((resolveReady) => {
        const fakeCtx = {
          get(service: string) {
            if (service === "agents") {
              return {
                roots: () => [
                  {
                    id: "session-good",
                    status: "idle",
                    session: "s1",
                    followup(msg: unknown) {
                      delivered.push(msg);
                    },
                  },
                ],
              };
            }
            return undefined;
          },
          effect(fn: () => () => void) {
            cleanup = fn();
          },
        };
        applyInboundBridge(fakeCtx, {
          port: 0,
          mcpBin: "",
          agentschatDir: dir,
          logPath: join(dir, "bridge.log"),
          onListening({ port }: { port: number }) {
            listenPort = port;
            resolveReady();
          },
        });
      });

      const base = `http://127.0.0.1:${listenPort}`;

      // 1. Cross-origin browser request (evil website & sandboxed `Origin: null`) -> 403 without ACAO
      const evilGet = await fetch(`${base}/identity`, {
        headers: { Origin: "https://attacker.example" },
      });
      expect(evilGet.status).toBe(403);
      expect(evilGet.headers.get("access-control-allow-origin")).toBeNull();

      const nullOriginPreflight = await fetch(`${base}/identity/bind`, {
        method: "OPTIONS",
        headers: { Origin: "null" },
      });
      expect(nullOriginPreflight.status).toBe(403);
      expect(nullOriginPreflight.headers.get("access-control-allow-origin")).toBeNull();

      // 2. Allowed local DSH UI origin -> echoed specifically with Vary: Origin (never '*') + __proto__ stripped
      const localGet = await fetch(`${base}/identity`, {
        headers: { Origin: "http://127.0.0.1:3000" },
      });
      expect(localGet.status).toBe(200);
      expect(localGet.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
      expect(localGet.headers.get("vary")).toContain("Origin");
      const idBody = (await localGet.json()) as { binds: Record<string, string> };
      expect(Object.prototype.hasOwnProperty.call(idBody.binds, "__proto__")).toBe(false);
      expect(idBody.binds).toEqual({});

      // 3. Prototype-key bind attempt rejected with 400
      const protoBind = await fetch(`${base}/identity/bind`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ sessionId: "__proto__", profileName: "DshTest" }),
      });
      expect(protoBind.status).toBe(400);

      // 4. Oversized (> 64 KiB) wake body rejected with 413
      const secret = readFileSync(join(dir, "dsh-inbound.secret"), "utf8").trim();
      const hugeBody = JSON.stringify({ message_id: "huge", content: "x".repeat(MAX_HTTP_BODY_BYTES + 1024) });
      const hugeSig = createHmac("sha256", secret).update(hugeBody, "utf8").digest("hex");
      try {
        const hugeWake = await fetch(`${base}/agentschat/wake`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-agentschat-signature": hugeSig },
          body: hugeBody,
        });
        expect(hugeWake.status).toBe(413);
      } catch {
        // Socket reset on req.destroy() after 413 write is also acceptable on fast loopback drains
      }
      expect(delivered.length).toBe(0);

      // 5. Valid signed wake within bounds delivers cleanly into bound idle session
      const okPayload = JSON.stringify({
        message_id: "msg-96-ok",
        channel_id: "dm-96",
        sender_id: "peer-1",
        content: "ping 96",
        target_session_id: "session-good",
      });
      const okSig = createHmac("sha256", secret).update(okPayload, "utf8").digest("hex");
      const okWake = await fetch(`${base}/agentschat/wake`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentschat-signature": okSig },
        body: okPayload,
      });
      expect(okWake.status).toBe(200);
      expect(delivered.length).toBe(1);
    } finally {
      cleanup?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Campaign #109 KR3: enforces TLS on remote ws/http URLs while allowing loopback, classifies dm: as direct, validates --name, and rejects >1MiB patch files", async () => {
    const env = { AGENTCHAT_AGENT_ID: "bot-109", AGENTCHAT_TOKEN: "ac_token_109" };
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: "ws://remote.example/ws" })).toThrow(/TLS/);
    expect(() => loadDshConfig({ ...env, AGENTCHAT_REST_URL: "http://remote.example" })).toThrow(/TLS/);
    expect(() => buildMcpAgentsChatArgs({ apiUrl: "http://remote.example" })).toThrow(/Invalid AgentsChat API URL/);

    expect(loadDshConfig({ ...env, AGENTCHAT_WS_URL: "ws://127.0.0.1:8787/ws", AGENTCHAT_REST_URL: "http://localhost:8787" }).wsUrl).toBe(
      "ws://127.0.0.1:8787/ws",
    );
    expect(buildMcpAgentsChatArgs({ apiUrl: "http://127.0.0.1:8787" })).toContain("http://127.0.0.1:8787");

    await expect(registerOnly("   ", "https://agents-chat.com")).rejects.toThrow(/Invalid --name/);
    await expect(registerOnly("bad\nname", "https://agents-chat.com")).rejects.toThrow(/Invalid --name/);
    await expect(registerOnly("good-bot", "http://remote.example")).rejects.toThrow(/TLS/);

    const priorId = process.env.AGENTCHAT_AGENT_ID;
    const priorToken = process.env.AGENTCHAT_TOKEN;
    process.env.AGENTCHAT_AGENT_ID = "dsh-test-bot";
    process.env.AGENTCHAT_TOKEN = "test-token";
    let kinds: unknown;
    const start = spyOn(MuseBridge.prototype, "start").mockImplementation(async function (this: MuseBridge) {
      kinds = (this as unknown as { opts: { channelKinds: unknown } }).opts.channelKinds;
    });
    const closed = spyOn(MuseAgentChatClient.prototype, "waitUntilClosed").mockResolvedValue();
    try {
      await main(["--listen", "--channel", "dm:colon-direct", "--channel", "DM:upper-colon"]);
      expect(kinds).toEqual({ "dm:colon-direct": "direct", "DM:upper-colon": "direct" });
    } finally {
      start.mockRestore();
      closed.mockRestore();
      if (priorId === undefined) delete process.env.AGENTCHAT_AGENT_ID; else process.env.AGENTCHAT_AGENT_ID = priorId;
      if (priorToken === undefined) delete process.env.AGENTCHAT_TOKEN; else process.env.AGENTCHAT_TOKEN = priorToken;
    }

    const dir = mkdtempSync(join(tmpdir(), "dsh-c109-oversize-"));
    try {
      const patchFile = join(dir, "cordis.patch.yml");
      writeFileSync(patchFile, "# comment\n" + "x".repeat(1_050_000), "utf8");
      expect(() => applyDshCordisPatchFile({ dshHome: dir })).toThrow(/oversized/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function startTestInbound(
  dir: string,
  options: Record<string, unknown> = {},
  delivered: unknown[] = [],
): Promise<{ base: string; stop: () => void }> {
  let stop = () => {};
  const base = await new Promise<string>((ready) => {
    applyInboundBridge({
      get(service: string) {
        if (service === "agents") return { roots: () => [{
          id: "session-test", status: "idle", session: "test",
          followup(message: unknown) { delivered.push(message); },
        }] };
        return undefined;
      },
      effect(fn: () => () => void) { stop = fn(); },
    }, {
      port: 0, mcpBin: "", agentschatDir: dir, logPath: join(dir, "bridge.log"),
      ...options,
      onListening({ port }: { port: number }) { ready(`http://127.0.0.1:${port}`); },
    });
  });
  return { base, stop };
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("DSH REST URL, profile and home guards reject ambiguous inputs and keep loopback working", () => {
  const env = { AGENTCHAT_AGENT_ID: "bot", AGENTCHAT_TOKEN: "test-token" };
  for (const url of ["https://example.com:0", "http://localhost:0", "https://example.com?x=1", "https://example.com#x", 'https://example.com/"', "https://example.com/<x>", "https://example.com/\\x", "https://example.com/a b", " https://example.com", "https://example.com\n"]) {
    expect(() => loadDshConfig({ ...env, AGENTCHAT_REST_URL: url })).toThrow();
  }
  for (const url of ["https://example.com:0", "http://localhost:0", "https://example.com?x=1", "https://example.com#x"]) {
    expect(() => buildMcpAgentsChatArgs({ apiUrl: url })).toThrow();
  }
  for (const url of ["wss://example.com:0/ws", "ws://127.0.0.1:0/ws", 'wss://example.com/"', "wss://example.com/\\x"]) {
    expect(() => loadDshConfig({ ...env, AGENTCHAT_WS_URL: url })).toThrow();
  }
  for (const profile of ["CONSTRUCTOR", "Prototype", "__PrOtO__"]) {
    expect(() => resolveDshPatchPath({ dshProfile: profile })).toThrow();
    expect(() => buildMcpAgentsChatArgs({ agentsChatProfile: profile })).toThrow();
    expect(() => loadDshConfig({ ...env, AGENTCHAT_AGENT_ID: profile })).toThrow();
  }
  for (const home of ["relative", "./relative", "../relative", "-option", "/tmp/bad\npath", "/" + "x".repeat(4096)]) {
    expect(() => resolveDshPatchPath({ dshHome: home })).toThrow(/Invalid DSH home/);
  }
  expect(resolveDshPatchPath({ dshHome: "/" + "x".repeat(4095) }).length).toBeGreaterThan(4096);
  expect(loadDshConfig({ ...env, AGENTCHAT_WS_URL: "ws://127.0.0.1:8787/ws", AGENTCHAT_REST_URL: "http://localhost:8787" }).restUrl).toBe("http://localhost:8787");
});

test("DSH rejects own __proto__ in config JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-config-"));
  try {
    const path = join(dir, "dsh.json");
    writeFileSync(path, '{"__proto__":{},"agentId":"bot","token":"test-token"}');
    expect(() => loadDshConfig({}, path)).toThrow(/Missing/);
    writeFileSync(path, '{"agentId":"bot","token":"test-token"}');
    expect(loadDshConfig({}, path).agentId).toBe("bot");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registration rejects unsafe returned IDs before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-ids-"));
  let agentId = "";
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ agentId, token: "test-token" })) as unknown as typeof fetch);
  try {
    for (agentId of [".", "..", "CONSTRUCTOR", "Prototype", "__PrOtO__", "bad/id", "bad\\id", "bad id", "bad\nid", " bad", "bad\u007f"]) {
      await expect(registerOnly("bot", "https://example.com", join(dir, "dsh.json"))).rejects.toThrow(/valid agent/);
      expect(existsSync(join(dir, "dsh.json"))).toBe(false);
    }
    agentId = "valid-bot.1";
    await registerOnly("bot", "https://example.com", join(dir, "dsh.json"));
    expect(JSON.parse(readFileSync(join(dir, "dsh.json"), "utf8")).agentId).toBe(agentId);
  } finally { request.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("registration bounds actual streamed bytes at 1MiB and cancels oversized responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-size-"));
  const valid = JSON.stringify({ agentId: "bot", token: "test-token" });
  let cancelled = false;
  let oversized = true;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => {
    if (!oversized) return new Response(valid + " ".repeat(1024 * 1024 - valid.length));
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(++index <= 16 ? 65536 : 1).fill(32)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "1" } });
  }) as unknown as typeof fetch);
  try {
    await expect(registerOnly("bot", "https://example.com", join(dir, "dsh.json"))).rejects.toThrow(/exceeds 1MiB/);
    expect(cancelled).toBe(true);
    expect(existsSync(join(dir, "dsh.json"))).toBe(false);
    oversized = false;
    await registerOnly("bot", "https://example.com", join(dir, "dsh.json"));
    expect(JSON.parse(readFileSync(join(dir, "dsh.json"), "utf8")).agentId).toBe("bot");
  } finally { request.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("registration rechecks a target swapped to a symlink after temp creation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-race-"));
  const target = join(dir, "dsh.json"), victim = join(dir, "victim");
  writeFileSync(victim, "untouched");
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ agentId: "bot", token: "test-token" })) as unknown as typeof fetch);
  const originalWrite = fs.writeFileSync;
  const write = spyOn(fs, "writeFileSync").mockImplementation(((path: any, ...args: any[]) => {
    (originalWrite as any)(path, ...args);
    if (String(path).startsWith(`${target}.`) && String(path).endsWith(".tmp")) symlinkSync(victim, target);
  }) as typeof fs.writeFileSync);
  try {
    await expect(registerOnly("bot", "https://example.com", target)).rejects.toThrow(/non-regular/);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally { write.mockRestore(); request.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test("inbound prompts classify dm: and DM- and bound sanitized header fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-prompt-"));
  const delivered: any[] = [];
  const bridge = await startTestInbound(dir, {}, delivered);
  try {
    const secret = readFileSync(join(dir, "dsh-inbound.secret"), "utf8").trim();
    for (const channel of ["dm:legacy", "DM-legacy", "group"]) {
      const payload = JSON.stringify({ channel_id: channel + "\n" + "x".repeat(200), message_id: "msg-" + channel + "\r\n" + "m".repeat(200), sender_id: "peer\u0000\u007f\n" + "s".repeat(200), content: "hello\nworld", target_session_id: "session-test" });
      const response = await fetch(`${bridge.base}/agentschat/wake`, { method: "POST", headers: { "x-agentschat-signature": createHmac("sha256", secret).update(payload).digest("hex") }, body: payload });
      expect(response.status).toBe(200);
      const rendered = JSON.stringify(delivered.at(-1));
      const message = delivered.at(-1);
      const text = typeof message.content === "string" ? message.content : message.content[0].text;
      expect(text).toContain(`kind: ${channel === "group" ? "channel message" : "direct message"}`);
      expect(text).toContain("hello\nworld");
      const lines = text.split("\n");
      for (const label of ["channel_id: ", "message_id: ", "from: "]) {
        const line = lines.find((line: string) => line.startsWith(label))!;
        expect(line.slice(label.length)).toHaveLength(128);
        expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
      }
      expect(rendered).not.toContain("\\u0000");
    }
    expect(delivered).toHaveLength(3);
  } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("inbound identity filters case-insensitive keys, own proto documents, and reads .JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-profiles-"));
  mkdirSync(join(dir, "profiles"));
  for (const name of ["Good.JSON", "CONSTRUCTOR.json", "Prototype.JSON"]) writeFileSync(join(dir, "profiles", name), JSON.stringify({ agent_id: "bot" }));
  writeFileSync(join(dir, "profiles", "Dirty.json"), '{"__proto__":{},"agent_id":"dirty"}');
  writeFileSync(join(dir, "session-binds.json"), '{"__proto__":{},"session-ok":"Good"}');
  const bridge = await startTestInbound(dir);
  try {
    let data = await (await fetch(`${bridge.base}/identity`)).json() as any;
    expect(data.profiles.map((p: any) => p.name)).toEqual(["Good"]);
    expect(data.binds).toEqual({});
    for (const sessionId of [".", "..", "CONSTRUCTOR", "Prototype", "a/b", "a\\b"]) {
      expect((await postJson(bridge.base, "/identity/bind", { sessionId, profileName: "Good" })).status).toBe(400);
    }
    expect((await postJson(bridge.base, "/identity/bind", { sessionId: "session-test", profileName: "Good" })).status).toBe(200);
    data = await (await fetch(`${bridge.base}/identity`)).json();
    expect(data.binds).toEqual({ "session-test": "Good" });
  } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("identity/create rejects remote HTTP, credentials, port zero, queries and fragments before fetch", async () => {
  const realFetch = globalThis.fetch;
  let registrations = 0;
  const request = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => {
    if (String(input).endsWith("/api/account/register")) { registrations++; return Promise.resolve(Response.json({ agentId: "bot", token: "test-token" })); }
    return realFetch(input, init);
  }) as typeof fetch);
  try {
    for (const apiUrl of ["http://remote.example", "https://example.com:0", "http://localhost:0", "https://user:pass@example.com", "https://example.com?x=1", "https://example.com#x"]) {
      const dir = mkdtempSync(join(tmpdir(), "dsh118-url-"));
      const bridge = await startTestInbound(dir, { apiUrl });
      try {
        expect((await postJson(bridge.base, "/identity/create", { name: "test" })).status).toBe(400);
        expect(readdirSync(join(dir, "profiles"))).toEqual([]);
      } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
    }
    expect(registrations).toBe(0);
    for (const apiUrl of ["https://example.com", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      const dir = mkdtempSync(join(tmpdir(), "dsh118-local-"));
      const bridge = await startTestInbound(dir, { apiUrl });
      try { expect((await postJson(bridge.base, "/identity/create", { name: "test" })).status).toBe(200); }
      finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
    }
    expect(registrations).toBe(4);
  } finally { request.mockRestore(); }
});

test("identity/create rejects oversized responses and unsafe agent IDs, scrubs OAuth, webhook and JWT errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-response-"));
  const bridge = await startTestInbound(dir, { apiUrl: "https://example.com" });
  const realFetch = globalThis.fetch;
  let response = () => Response.json({});
  const request = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => String(input).endsWith("/api/account/register") ? Promise.resolve(response()) : realFetch(input, init)) as typeof fetch);
  try {
    response = () => new Response(" ".repeat(1024 * 1024 + 1), { headers: { "content-length": "1" } });
    let result = await postJson(bridge.base, "/identity/create", { name: "test" });
    expect(result.status).toBe(500);
    expect((await result.json() as any).error).toContain("1MiB");
    for (const agentId of ["CONSTRUCTOR", "Prototype", "bad id", "bad/id", "bad\\id", ".", "..", " bad", "bad\n"]) {
      response = () => Response.json({ agentId, token: "test-token" });
      expect((await postJson(bridge.base, "/identity/create", { name: "test" })).status).toBe(502);
    }
    const secrets = ["mcp_at_abcdefgh", "mcp_rt_abcdefgh", "mcp_code_abcdefgh", "whsec_abcdefgh", "eyJabcdefghij.abc.sig"];
    response = () => new Response(secrets.join(" "), { status: 400 });
    result = await postJson(bridge.base, "/identity/create", { name: "test" });
    expect(result.status).toBe(502);
    const text = await result.text();
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text.match(/REDACTED/g)).toHaveLength(5);
    response = () => new Response("x".repeat(190) + " " + secrets[0], { status: 400 });
    result = await postJson(bridge.base, "/identity/create", { name: "test" });
    expect(await result.text()).not.toContain("mcp_at_");
    expect(readdirSync(join(dir, "profiles"))).toEqual([]);
  } finally { request.mockRestore(); bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("inbound secret, bind, profile and log writes refuse symlinked parents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-parents-"));
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  try {
    let effects = 0;
    applyInboundBridge({ get() {}, effect() { effects++; } }, { port: 0, mcpBin: "", agentschatDir: join(dir, "link"), logPath: join(dir, "link", "log") });
    expect(effects).toBe(0);
    expect(readdirSync(join(dir, "real"))).toEqual([]);
    const bridge = await startTestInbound(dir, { logPath: join(dir, "link", "log") });
    try {
      symlinkSync(join(dir, "real"), join(dir, "profiles"));
      expect((await postJson(bridge.base, "/identity/create", { name: "test" })).status).toBe(500);
      expect(readdirSync(join(dir, "real"))).toEqual([]);
    } finally { bridge.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("inbound exclusive temp writes preserve collisions for secrets, binds and profiles", async () => {
  for (const kind of ["secret", "bind", "profile"]) {
    const dir = mkdtempSync(join(tmpdir(), `dsh118-exclusive-${kind}-`));
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    let collided = "";
    let stop = () => {};
    const originalWrite = fs.writeFileSync;
    const writes = spyOn(fs, "writeFileSync").mockImplementation(((path: any, ...args: any[]) => {
      const name = String(path);
      const matches = name.endsWith(".tmp") && (kind === "secret" ? name.includes("dsh-inbound.secret.") : kind === "bind" ? name.includes("session-binds.json.") : name.includes("test.json."));
      if (matches) { collided = name; symlinkSync(victim, name); }
      return (originalWrite as any)(path, ...args);
    }) as typeof fs.writeFileSync);
    const realFetch = globalThis.fetch;
    const request = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => String(input).endsWith("/api/account/register") ? Promise.resolve(Response.json({ agentId: "bot", token: "test-token" })) : realFetch(input, init)) as typeof fetch);
    try {
      if (kind === "secret") {
        let effects = 0;
        applyInboundBridge({ get() {}, effect() { effects++; } }, { port: 0, mcpBin: "", agentschatDir: dir, logPath: join(dir, "log") });
        expect(effects).toBe(0);
      } else {
        const bridge = await startTestInbound(dir, { apiUrl: "https://example.com" });
        stop = bridge.stop;
        const result = await postJson(bridge.base, kind === "bind" ? "/identity/unbind" : "/identity/create", { sessionId: "session-test", name: "test" });
        expect(result.status).toBe(500);
      }
      expect(collided).not.toBe("");
      expect(fs.lstatSync(collided).isSymbolicLink()).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("untouched");
    } finally { request.mockRestore(); writes.mockRestore(); stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("inbound rechecks secret, bind and profile targets immediately before rename", async () => {
  for (const kind of ["secret", "bind", "profile"]) {
    const dir = mkdtempSync(join(tmpdir(), `dsh118-recheck-${kind}-`));
    const victim = join(dir, "victim");
    writeFileSync(victim, "untouched");
    let swapped = "";
    let stop = () => {};
    const originalWrite = fs.writeFileSync;
    const writes = spyOn(fs, "writeFileSync").mockImplementation(((path: any, ...args: any[]) => {
      const result = (originalWrite as any)(path, ...args);
      const name = String(path);
      const matches = name.endsWith(".tmp") && (kind === "secret" ? name.includes("dsh-inbound.secret.") : kind === "bind" ? name.includes("session-binds.json.") : name.includes("test.json."));
      if (matches) {
        swapped = kind === "secret" ? join(dir, "dsh-inbound.secret") : kind === "bind" ? join(dir, "session-binds.json") : join(dir, "profiles", "test.json");
        symlinkSync(victim, swapped);
      }
      return result;
    }) as typeof fs.writeFileSync);
    const realFetch = globalThis.fetch;
    const request = spyOn(globalThis, "fetch").mockImplementation(((input: any, init: any) => String(input).endsWith("/api/account/register") ? Promise.resolve(Response.json({ agentId: "bot", token: "test-token" })) : realFetch(input, init)) as typeof fetch);
    try {
      if (kind === "secret") {
        let effects = 0;
        applyInboundBridge({ get() {}, effect() { effects++; } }, { port: 0, mcpBin: "", agentschatDir: dir, logPath: join(dir, "log") });
        expect(effects).toBe(0);
      } else {
        const bridge = await startTestInbound(dir, { apiUrl: "https://example.com" });
        stop = bridge.stop;
        const result = await postJson(bridge.base, kind === "bind" ? "/identity/unbind" : "/identity/create", { sessionId: "session-test", name: "test" });
        expect(result.status).toBe(500);
      }
      expect(swapped).not.toBe("");
      expect(fs.lstatSync(swapped).isSymbolicLink()).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("untouched");
      expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
      if (existsSync(join(dir, "profiles"))) expect(readdirSync(join(dir, "profiles")).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { request.mockRestore(); writes.mockRestore(); stop(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("bound DSH clients strip .JSON case-insensitively and skip reserved or own-proto profiles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh118-bound-"));
  const envNames = ["AGENTSCHAT_CONFIG_DIR", "AGENTCHAT_AGENT_ID", "AGENTCHAT_TOKEN"] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map((signal) => new Set(process.listeners(signal)));
  process.env.AGENTSCHAT_CONFIG_DIR = dir;
  process.env.AGENTCHAT_AGENT_ID = "primary-test";
  process.env.AGENTCHAT_TOKEN = "test-token";
  mkdirSync(join(dir, "profiles"));
  writeFileSync(join(dir, "session-binds.json"), JSON.stringify({ "session-ok": "Good.JSON", "session-bad": "CONSTRUCTOR.JSON", "session-dirty": "Dirty.JSON" }));
  for (const name of ["Good", "CONSTRUCTOR"]) writeFileSync(join(dir, "profiles", `${name}.json`), JSON.stringify({ agent_id: name, token: "test-token" }));
  writeFileSync(join(dir, "profiles", "Dirty.json"), '{"__proto__":{},"agent_id":"dirty","token":"test-token"}');
  let connections = 0;
  const connect = spyOn(MuseAgentChatClient.prototype, "connect").mockImplementation(async () => { connections++; });
  const joinChannel = spyOn(MuseAgentChatClient.prototype, "joinChannel").mockImplementation(() => {});
  const disconnect = spyOn(MuseAgentChatClient.prototype, "disconnect").mockImplementation(() => {});
  const closed = spyOn(MuseAgentChatClient.prototype, "waitUntilClosed").mockResolvedValue();
  try {
    await main(["--wake"]);
    expect(connections).toBe(2); // Primary + Good; neither reserved nor dirty.
  } finally {
    connect.mockRestore(); joinChannel.mockRestore(); disconnect.mockRestore(); closed.mockRestore();
    signals.forEach((signal, index) => {
      for (const listener of process.listeners(signal)) if (!listeners[index]!.has(listener)) process.removeListener(signal, listener);
    });
    for (const name of envNames) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    rmSync(dir, { recursive: true, force: true });
  }
});
