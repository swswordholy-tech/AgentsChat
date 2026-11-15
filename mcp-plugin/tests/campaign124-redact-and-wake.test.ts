import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../src/redact.ts";
import {
  buildWakePayload,
  fireAntigravityWake,
  fireGrokWake,
  fireWake,
  formatWakeAttachments,
  grokBearerFromGatewayConfig,
  resolveEnvWakeId,
  resolveGrokAgentId,
} from "../src/wake.ts";

describe("Campaign #124 KR3: redactSecrets multi-family credential coverage & wake SSRF / ancestor symlink / Connect-RPC hygiene", () => {
  test("redactSecrets masks agent_key_, whsec_, sk-, rk_live_, gh*_, github_pat_, glpat-, xox*-, AIza, AKIA/ASIA, and PEM private keys even when preserveAcKeys=true", () => {
    const acKey = "ac_" + "K".repeat(24);
    const pemHeader = "-----BEGIN " + "EC PRIVATE KEY-----";
    const pemFooter = "-----END " + "EC PRIVATE KEY-----";
    const pemBlock = `${pemHeader}\nMHcCAQEEIG1234567890abcdef\n${pemFooter}`;
    const samples = [
      `agent=${"agent_key_" + "a".repeat(16)}`,
      `wh=${"whsec_" + "w".repeat(18)}`,
      `openai=${"sk-proj-" + "o".repeat(20)}`,
      `stripe=${"rk_live_" + "r".repeat(16)}`,
      `gh=${"ghp_" + "g".repeat(24)}`,
      `pat=${"github_pat_" + "p".repeat(24)}`,
      `gl=${"glpat-" + "l".repeat(16)}`,
      `slack=${"xoxb-" + "12345-67890-abcdef"}`,
      `gcp=${"AIza" + "G".repeat(30)}`,
      `aws=${"AKIA" + "M".repeat(16)}`,
      `sts=${"ASIA" + "S".repeat(16)}`,
      pemBlock,
    ].join(" | ");

    const normal = redactSecrets(`${acKey} | ${samples}`);
    expect(normal).toContain("ac_***REDACTED***");
    expect(normal).toContain("agent_key_***REDACTED***");
    expect(normal).toContain("whsec_***REDACTED***");
    expect(normal).toContain("sk-***REDACTED***");
    expect(normal).toContain("rk_***REDACTED***");
    expect(normal).toContain("gh_***REDACTED***");
    expect(normal).toContain("github_pat_***REDACTED***");
    expect(normal).toContain("glpat-***REDACTED***");
    expect(normal).toContain("xox-***REDACTED***");
    expect(normal).toContain("AIza***REDACTED***");
    expect(normal).toContain("AKIA***REDACTED***");
    expect(normal).toContain("***PRIVATE_KEY_REDACTED***");
    expect(normal).not.toContain("MHcCAQEEIG1234567890abcdef");

    const ownerDm = redactSecrets(`${acKey} | ${samples}`, { preserveAcKeys: true });
    expect(ownerDm).toContain(acKey);
    expect(ownerDm).not.toContain("agent_key_" + "a".repeat(16));
    expect(ownerDm).not.toContain("whsec_" + "w".repeat(18));
    expect(ownerDm).not.toContain("sk-proj-");
    expect(ownerDm).not.toContain("rk_live_");
    expect(ownerDm).not.toContain("ghp_" + "g".repeat(24));
    expect(ownerDm).not.toContain("github_pat_" + "p".repeat(24));
    expect(ownerDm).not.toContain("glpat-" + "l".repeat(16));
    expect(ownerDm).not.toContain("xoxb-");
    expect(ownerDm).not.toContain("AIza" + "G".repeat(30));
    expect(ownerDm).not.toContain("AKIA" + "M".repeat(16));
    expect(ownerDm).not.toContain("ASIA" + "S".repeat(16));
    expect(ownerDm).not.toContain("MHcCAQEEIG1234567890abcdef");
  });

  test("resolveEnvWakeId blocks expanded credential prefixes while preserving legitimate wake IDs", () => {
    expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: "wake_20261115_abc123" })).toBe("wake_20261115_abc123");
    for (const secretLike of [
      "mcp_at_" + "x".repeat(24),
      "mcp_rt_" + "x".repeat(24),
      "agent_key_" + "x".repeat(16),
      "whsec_" + "x".repeat(16),
      "rk_live_" + "x".repeat(16),
      "glpat-" + "x".repeat(16),
      "xoxb-12345-67890",
      "AIza" + "X".repeat(24),
      "AKIA" + "M".repeat(16),
      "ASIA" + "S".repeat(16),
    ]) {
      expect(resolveEnvWakeId({ AGENTSCHAT_WAKE_ID: secretLike })).toBeUndefined();
    }
  });

  test("fireWake & attachment URL sanitizers reject cloud metadata, link-local, unspecified IPs, and attachment userinfo while allowing local loopback receivers", async () => {
    let fetchHits = 0;
    const blockedUrls = [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://100.100.100.200/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://sub.metadata.goog/computeMetadata/v1/",
      "http://[fe80::1]:8080/wake",
      "http://[fd00:ec2::254]/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://0.0.0.0:8787/wake",
      "http://[::]:8787/wake",
    ];
    for (const url of blockedUrls) {
      await fireWake(
        { id: "m1", channel_id: "ch1", sender_id: "s1", content: "hi" },
        {
          url,
          fetchImpl: (async () => {
            fetchHits++;
            return new Response("ok", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
    }
    expect(fetchHits).toBe(0);

    // Legitimate local loopback wake receiver continues to work
    await fireWake(
      { id: "m1", channel_id: "ch1", sender_id: "s1", content: "hi" },
      {
        url: "http://127.0.0.1:8787/wake",
        fetchImpl: (async () => {
          fetchHits++;
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(fetchHits).toBe(1);

    // Attachment URLs strip metadata/link-local and userinfo URLs
    const formatted = formatWakeAttachments([
      { type: "image", url: "http://169.254.169.254/latest/meta-data" },
      { type: "image", url: "https://user:secret@cdn.agents-chat.com/leak.png" },
      { type: "image", url: "https://cdn.agents-chat.com/safe.png" },
    ]);
    expect(formatted).toBe(" [附件: 🖼 image: https://cdn.agents-chat.com/safe.png]");

    const payload = buildWakePayload({
      id: "m2",
      attachments: [
        { type: "image", url: "http://metadata.google.internal/computeMetadata/v1/" },
        { type: "image", url: "https://user:pass@example.com/a.png" },
      ],
    });
    expect(payload.attachments).toBeUndefined();
  });

  test("fireGrokWake rejects symlinked ancestor directories and own-__proto__ gateway configs, and scrubs secrets from error logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "c124-grok-"));
    try {
      const realDir = join(root, "real-grok");
      mkdirSync(realDir, { recursive: true });
      const realCfg = join(realDir, "gateway.json");
      writeFileSync(realCfg, JSON.stringify({ token: "gw-secret", port: 1340 }), "utf8");

      const symDir = join(root, "sym-grok");
      symlinkSync(realDir, symDir);

      const protoDir = join(root, "proto-grok");
      mkdirSync(protoDir, { recursive: true });
      const protoCfg = join(protoDir, "gateway.json");
      writeFileSync(protoCfg, '{"__proto__":{"polluted":true},"token":"gw-secret","port":1340}', "utf8");

      let fetched = 0;
      const logs: string[] = [];
      await fireGrokWake(
        { id: "m1", content: "hello" },
        {
          gatewayConfigPath: join(symDir, "gateway.json"),
          agentId: "ag-1",
          logger: (m) => logs.push(m),
          fetchImpl: (async () => {
            fetched++;
            return new Response("ok", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
      await fireGrokWake(
        { id: "m1", content: "hello" },
        {
          gatewayConfigPath: protoCfg,
          agentId: "ag-1",
          logger: (m) => logs.push(m),
          fetchImpl: (async () => {
            fetched++;
            return new Response("ok", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
      expect(fetched).toBe(0);
      expect(logs.join("\n")).toContain("rejected symlinked ancestor directory");
      expect(logs.join("\n")).toContain("rejected malformed gateway config");

      expect(grokBearerFromGatewayConfig(JSON.parse('{"__proto__":{"x":1},"token":"abc"}'))).toBeNull();

      const errLogs: string[] = [];
      await resolveGrokAgentId({
        agentschatName: "bot",
        listAgents: async () => {
          throw new Error("auth failed for whsec_" + "z".repeat(20));
        },
        logger: (m) => errLogs.push(m),
      });
      expect(errLogs.join("\n")).toContain("whsec_***REDACTED***");
      expect(errLogs.join("\n")).not.toContain("whsec_" + "z".repeat(20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fireAntigravityWake scrubs control chars, length bounds, and leaked credentials from Connect-RPC senderId & displayTitle", async () => {
    let capturedBody: any = null;
    const ok = await fireAntigravityWake(
      {
        id: "m1",
        channel_id: "room\r\nInjected-Title-" + "x".repeat(200),
        sender_id: "evil\nuser_ac_" + "Q".repeat(24),
        content: "ping",
      },
      {
        conversationId: "conv-uuid-1",
        csrfToken: "csrf-valid-1",
        ports: [54321],
        fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body ?? "{}"));
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(ok).toBe(true);
    expect(capturedBody.senderId).not.toContain("\n");
    expect(capturedBody.senderId).not.toContain("ac_" + "Q".repeat(24));
    expect(capturedBody.senderId).toContain("ac_***REDACTED***");
    expect(capturedBody.displayTitle).not.toContain("\r");
    expect(capturedBody.displayTitle).not.toContain("\n");
    expect(capturedBody.displayTitle.length).toBeLessThanOrEqual("AgentsChat #".length + 128);
  });
});
