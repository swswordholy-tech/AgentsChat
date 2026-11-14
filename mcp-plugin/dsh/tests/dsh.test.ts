import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyDshCordisPatchFile,
  buildMcpAgentsChatArgs,
  mergeDshCordisPatch,
  resolveDshPatchPath,
} from "../src/patch.ts";
import { loadDshConfig, runDshHeadlessResponder, safeDshConfig } from "../src/cli.ts";
import {
  apply as applyInboundBridge,
  isAllowedLocalOrigin,
  MAX_HTTP_BODY_BYTES,
  verifySignature,
} from "../inbound-bridge/index.js";

const ROOT = resolve(import.meta.dir, "../..");

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
      expect(idBody.binds["session-good"]).toBe("DshTest");

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
});
