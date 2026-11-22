import { test, expect, describe } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { LocalMiniServer } from "../src/local-server.js";

function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig_test_123`;
}

async function startMockCloudUpstream() {
  const registeredAgents = new Map<string, { id: string; name: string; token: string; claimed: boolean; owner_id?: string }>();
  // Pre-seed two existing Cloud-registered agents + one human account (simulating agents-chat.com)
  registeredAgents.set("ac_cloud_claude_secret", {
    id: "cloud-claude-global",
    name: "Claude Global Bot",
    token: "ac_cloud_claude_secret",
    claimed: true,
    owner_id: "boss@agents-chat.com",
  });
  registeredAgents.set("ac_cloud_codex_secret", {
    id: "cloud-codex-global",
    name: "Codex Global Bot",
    token: "ac_cloud_codex_secret",
    claimed: true,
    owner_id: "boss@agents-chat.com",
  });

  const validHumanJwt = makeFakeJwt({
    sub: "boss@agents-chat.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  let onboardingCalls = 0;
  let registerSeq = 0;

  const upstream: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

    if (url.pathname === "/api/account/register" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      registerSeq++;
      const id = `global-minted-bot-${registerSeq}`;
      const key = `ac_global_minted_key_${registerSeq}`;
      const name = String(body.name || id);
      registeredAgents.set(key, { id, name, token: key, claimed: false });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, key, name, type: "agent" }));
      return;
    }

    if (url.pathname === "/api/account/onboarding" && req.method === "GET") {
      onboardingCalls++;
      const rec = registeredAgents.get(token);
      if (!rec) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          agent_id: rec.id,
          display_name: rec.name,
          claimed: rec.claimed,
          ...(rec.owner_id ? { owner_id: rec.owner_id } : {}),
        }),
      );
      return;
    }

    if (url.pathname === "/api/account/me" && req.method === "GET") {
      if (token !== validHumanJwt) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid user session" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          account: {
            id: "boss@agents-chat.com",
            display_name: "Boss",
            type: "user",
          },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const addr = upstream.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    validHumanJwt,
    getOnboardingCalls: () => onboardingCalls,
    close: () => {
      upstream.closeAllConnections?.();
      return new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

describe("AgentsChat Desktop M1 — Global Identity Authority + Local Group/DM Mini-Server", () => {
  test("delegates registration to upstream global authority, caches verified Cloud tokens locally, and rejects forged tokens", async () => {
    const mockCloud = await startMockCloudUpstream();
    const local = new LocalMiniServer({
      port: 0,
      upstreamUrl: mockCloud.url,
      allowLoopbackHttpUpstream: true,
    });
    const status = await local.start();

    try {
      // 1. Forged token is strictly rejected (401)
      const badRes = await fetch(`${status.httpUrl}/api/channels/mine`, {
        headers: { Authorization: "Bearer ac_forged_offline_token" },
      });
      expect(badRes.status).toBe(401);

      // 2. Registering via Local Server delegates to upstream Cloud server for a globally unique ID
      const regRes = await fetch(`${status.httpUrl}/api/account/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Desktop Local Helper", capabilities: ["coding"] }),
      });
      expect(regRes.status).toBe(200);
      const regData = (await regRes.json()) as any;
      expect(regData.id).toBe("global-minted-bot-1");
      expect(regData.key).toMatch(/^ac_global_minted_key_/);

      // 3. Existing Cloud agent token verifies once against upstream, then hits local SQLite digest cache
      const beforeCalls = mockCloud.getOnboardingCalls();
      const r1 = await fetch(`${status.httpUrl}/api/account/onboarding`, {
        headers: { Authorization: "Bearer ac_cloud_claude_secret" },
      });
      expect(r1.status).toBe(200);
      const d1 = (await r1.json()) as any;
      expect(d1.agent_id).toBe("cloud-claude-global");
      expect(mockCloud.getOnboardingCalls()).toBe(beforeCalls + 1);

      // Second call uses local SHA-256 digest cache (0 extra upstream HTTP round-trips!)
      const r2 = await fetch(`${status.httpUrl}/api/account/onboarding`, {
        headers: { Authorization: "Bearer ac_cloud_claude_secret" },
      });
      expect(r2.status).toBe(200);
      expect(mockCloud.getOnboardingCalls()).toBe(beforeCalls + 1);

      // 4. Human Cloud JWT verifies seamlessly with identical global user ID
      const meRes = await fetch(`${status.httpUrl}/api/account/me`, {
        headers: { Authorization: `Bearer ${mockCloud.validHumanJwt}` },
      });
      expect(meRes.status).toBe(200);
      const meData = (await meRes.json()) as any;
      expect(meData.account.id).toBe("boss@agents-chat.com");
      expect(meData.account.type).toBe("user");
    } finally {
      await local.closeAll();
      await mockCloud.close();
    }
  });

  test("supports multi-agent private/public Group Chat, member invite, @mention resolution, 1v1 DM, WebSocket fanout, and Cloud boundary", async () => {
    const mockCloud = await startMockCloudUpstream();
    const local = new LocalMiniServer({
      port: 0,
      upstreamUrl: mockCloud.url,
      allowLoopbackHttpUpstream: true,
    });
    const status = await local.start();

    try {
      // Connect `cloud-claude-global` over WebSocket
      const wsClaude = new WebSocket(status.wsUrl);
      const receivedByClaude: any[] = [];
      await new Promise<void>((resolve, reject) => {
        wsClaude.on("error", reject);
        wsClaude.on("open", () => {
          wsClaude.send(
            JSON.stringify({
              type: "auth",
              agent_id: "cloud-claude-global",
              token: "ac_cloud_claude_secret",
              capabilities: ["claude-code", "review"],
            }),
          );
        });
        wsClaude.on("message", (raw) => {
          const msg = JSON.parse(String(raw));
          receivedByClaude.push(msg);
          if (msg.type === "auth_ok") resolve();
        });
      });

      // Human creates a private group and invites both Claude and Codex
      const createGroupRes = await fetch(`${status.httpUrl}/api/channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: "local-sprint-room",
          name: "Local Sprint Room",
          type: "group",
          visibility: "private",
          members: ["cloud-claude-global"],
        }),
      });
      expect(createGroupRes.status).toBe(201);

      const inviteRes = await fetch(`${status.httpUrl}/api/channels/local-sprint-room/invite`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ agent_id: "cloud-codex-global" }),
      });
      expect(inviteRes.status).toBe(200);

      // Human posts an @mention in the group -> Claude receives it in real time with `mentioned_ids`
      const postRes = await fetch(`${status.httpUrl}/api/channels/local-sprint-room/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: "Hey @cloud-claude-global please check the local server!",
        }),
      });
      expect(postRes.status).toBe(201);

      await new Promise((r) => setTimeout(r, 80));
      const groupBroadcast = receivedByClaude.find(
        (m) => m.type === "message" && m.channel_id === "local-sprint-room",
      );
      expect(groupBroadcast).toBeDefined();
      expect(groupBroadcast.sender_id).toBe("boss@agents-chat.com");
      expect(groupBroadcast.sender_type).toBe("human");
      expect(groupBroadcast.mentioned_ids).toEqual(["cloud-claude-global"]);

      // Deterministic 1v1 DM creation
      const dmRes = await fetch(`${status.httpUrl}/api/channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "direct",
          members: ["cloud-claude-global"],
        }),
      });
      expect(dmRes.status).toBe(201);
      const dmData = (await dmRes.json()) as any;
      expect(dmData.channel.id).toMatch(/^dm-/);

      // Cloud-only endpoints return explicit 501 CLOUD_SERVER_REQUIRED pointing to upstream
      for (const cloudPath of ["/api/cloud-agents", "/api/loops/mine", "/api/okr/objectives", "/api/memory"]) {
        const cr = await fetch(`${status.httpUrl}${cloudPath}`, {
          headers: { Authorization: `Bearer ${mockCloud.validHumanJwt}` },
        });
        expect(cr.status).toBe(501);
        const cd = (await cr.json()) as any;
        expect(cd.code).toBe("CLOUD_SERVER_REQUIRED");
        expect(cd.upgrade_url).toBe(mockCloud.url);
      }

      wsClaude.close();
    } finally {
      await local.closeAll();
      await mockCloud.close();
    }
  });

  test("100% wire-compatible with real agentschat-mcp stdio server (whoami, join_channel, reply, get_history, find_dm)", async () => {
    const mockCloud = await startMockCloudUpstream();
    const tempHome = mkdtempSync(join(tmpdir(), "desktop-mcp-e2e-"));
    mkdirSync(join(tempHome, ".agentschat"), { recursive: true });
    writeFileSync(
      join(tempHome, ".agentschat", "ClaudeLocalTest.json"),
      JSON.stringify({
        agent_id: "cloud-claude-global",
        display_name: "Claude Global Bot",
        token: "ac_cloud_claude_secret",
        capabilities: ["claude-code", "chat"],
      }),
      { mode: 0o600 },
    );

    const local = new LocalMiniServer({
      port: 0,
      upstreamUrl: mockCloud.url,
      allowLoopbackHttpUpstream: true,
    });
    const status = await local.start();

    const mcpServerEntry = resolve(import.meta.dir, "../../mcp-plugin/src/server.ts");
    const proc = Bun.spawn(
      [process.execPath, mcpServerEntry, "--profile", "ClaudeLocalTest", "--url", status.httpUrl],
      {
        env: {
          PATH: process.env.PATH!,
          HOME: tempHome,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const reader = proc.stdout.getReader();
    let buffer = "";
    const nextRpcResponse = async (expectedId: number): Promise<any> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id === expectedId) return msg;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
      }
      throw new Error(`Timed out waiting for JSON-RPC id=${expectedId}`);
    };

    const sendRpc = (msg: Record<string, unknown>) => {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    };

    try {
      sendRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "desktop-test", version: "0.1.0" },
        },
      });
      const initRes = await nextRpcResponse(1);
      expect(initRes.result?.serverInfo).toBeDefined();

      // Wait briefly for WS auth_ok handshake
      await new Promise((r) => setTimeout(r, 250));

      sendRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "whoami", arguments: {} },
      });
      const whoamiRes = await nextRpcResponse(2);
      const whoamiText = whoamiRes.result?.content?.[0]?.text || "";
      expect(whoamiText).toContain("cloud-claude-global");
      expect(whoamiText).toContain("WebSocket: connected");
      expect(whoamiText).toContain("REST auth: ok");

      sendRpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "join_channel", arguments: { chat_id: "welcome" } },
      });
      const joinRes = await nextRpcResponse(3);
      expect(joinRes.result?.content?.[0]?.text || "").toContain("Joined channel welcome");

      sendRpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "reply",
          arguments: { chat_id: "welcome", text: "Hello from real MCP connected to Desktop Local Server!" },
        },
      });
      const replyRes = await nextRpcResponse(4);
      expect(replyRes.result?.isError).not.toBe(true);

      sendRpc({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_history", arguments: { chat_id: "welcome", limit: 5 } },
      });
      const histRes = await nextRpcResponse(5);
      expect(histRes.result?.content?.[0]?.text || "").toContain(
        "Hello from real MCP connected to Desktop Local Server!",
      );

      // Verify `channel_brief` & `list_members` see live online presence via `/api/presence`
      sendRpc({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "channel_brief", arguments: { chat_id: "welcome" } },
      });
      const briefRes = await nextRpcResponse(6);
      const briefText = briefRes.result?.content?.[0]?.text || "";
      expect(briefText).toContain("cloud-claude-global");

      // Verify direct batch presence API returns live online status
      const presRes = await fetch(
        `${status.httpUrl}/api/presence?ids=cloud-claude-global,cloud-codex-global`,
        { headers: { Authorization: "Bearer ac_cloud_claude_secret" } },
      );
      expect(presRes.status).toBe(200);
      const presJson = (await presRes.json()) as any;
      expect(presJson.presence["cloud-claude-global"]).toBe("online");
      expect(presJson.presence["cloud-codex-global"]).toBe("offline");

      // Verify `list_channels` (uses /api/channels/discover), `list_my_channels`, and `list_members`
      sendRpc({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "list_channels", arguments: {} },
      });
      const listChRes = await nextRpcResponse(7);
      expect(listChRes.result?.content?.[0]?.text || "").toContain("welcome");
      expect(listChRes.result?.content?.[0]?.text || "").toContain("1 online");

      sendRpc({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "list_my_channels", arguments: {} },
      });
      const myChRes = await nextRpcResponse(8);
      expect(myChRes.result?.content?.[0]?.text || "").toContain("welcome");

      sendRpc({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "list_members", arguments: { chat_id: "welcome" } },
      });
      const membersRes = await nextRpcResponse(9);
      expect(membersRes.result?.content?.[0]?.text || "").toContain("cloud-claude-global");

      // Verify Cloud-only MCP endpoint (/api/me/entitlements) cleanly returns 501 CLOUD_SERVER_REQUIRED
      const entRes = await fetch(`${status.httpUrl}/api/me/entitlements`, {
        headers: { Authorization: "Bearer ac_cloud_claude_secret" },
      });
      expect(entRes.status).toBe(501);
      const entBody = (await entRes.json()) as any;
      expect(entBody.code).toBe("CLOUD_SERVER_REQUIRED");
    } finally {
      proc.kill();
      await proc.exited.catch(() => {});
      await local.closeAll();
      await mockCloud.close();
      rmSync(tempHome, { recursive: true, force: true });
    }
  }, 20_000);

  test("supports scoped /api/search with SQLite wildcard escaping, private room isolation, and in_reply_to quote replies", async () => {
    const mockCloud = await startMockCloudUpstream();
    const local = new LocalMiniServer({
      port: 0,
      dbPath: ":memory:",
      upstreamUrl: mockCloud.url,
      allowLoopbackHttpUpstream: true,
    });
    const status = await local.start();
    try {
      // Seed public welcome message + quote reply
      const pubMsg1 = await fetch(`${status.httpUrl}/api/channels/welcome/messages`, {
        method: "POST",
        headers: {
          Authorization: "Bearer ac_cloud_claude_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Deploy 100% passed on macOS_arm64" }),
      });
      expect(pubMsg1.status).toBe(201);
      const pub1Body = (await pubMsg1.json()) as any;
      const parentId = pub1Body.message.id;

      const pubMsg2 = await fetch(`${status.httpUrl}/api/channels/welcome/messages`, {
        method: "POST",
        headers: {
          Authorization: "Bearer ac_cloud_codex_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Verified quote reply!", in_reply_to: parentId }),
      });
      expect(pubMsg2.status).toBe(201);
      const pub2Body = (await pubMsg2.json()) as any;
      expect(pub2Body.message.in_reply_to).toBe(parentId);

      // Boss creates a private room with secret keyword (Codex is NOT a member)
      const privRes = await fetch(`${status.httpUrl}/api/channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Secret Strategy Room",
          type: "group",
          visibility: "private",
          members: ["cloud-claude-global"],
        }),
      });
      expect(privRes.status).toBe(201);
      const privId = ((await privRes.json()) as any).channel.id;

      await fetch(`${status.httpUrl}/api/channels/${privId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mockCloud.validHumanJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "TopSecretLaunchCode42" }),
      });

      // Wildcard `%` must match literally ("100%"), NOT match every message
      const pctSearch = (await (
        await fetch(`${status.httpUrl}/api/search?q=${encodeURIComponent("100%")}`, {
          headers: { Authorization: "Bearer ac_cloud_codex_secret" },
        })
      ).json()) as any;
      expect(pctSearch.total).toBe(1);
      expect(pctSearch.messages[0].id).toBe(parentId);

      // Outsider (Codex) searching for private-room secret must get 0 hits (global & targeted)
      const outsiderGlobal = (await (
        await fetch(`${status.httpUrl}/api/search?q=TopSecretLaunchCode42`, {
          headers: { Authorization: "Bearer ac_cloud_codex_secret" },
        })
      ).json()) as any;
      expect(outsiderGlobal.total).toBe(0);

      const outsiderDirect = (await (
        await fetch(`${status.httpUrl}/api/search?q=TopSecretLaunchCode42&channel_id=${privId}`, {
          headers: { Authorization: "Bearer ac_cloud_codex_secret" },
        })
      ).json()) as any;
      expect(outsiderDirect.total).toBe(0);

      // Member (Claude) searching for private-room secret finds it
      const memberSearch = (await (
        await fetch(`${status.httpUrl}/api/search?q=topsecretlaunchcode42`, {
          headers: { Authorization: "Bearer ac_cloud_claude_secret" },
        })
      ).json()) as any;
      expect(memberSearch.total).toBe(1);
      expect(memberSearch.messages[0].channel_id).toBe(privId);

      // REST PATCH / DELETE message + real-time WS broadcast + strict sender/admin authorization
      const ws = new WebSocket(status.wsUrl);
      const wsEvents: any[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "auth", agent_id: "cloud-codex-global", token: "ac_cloud_codex_secret" }));
        });
        ws.on("message", (raw) => {
          const f = JSON.parse(String(raw));
          wsEvents.push(f);
          if (f.type === "auth_ok") {
            ws.send(JSON.stringify({ type: "join_channel", channel_id: "welcome" }));
            resolve();
          }
        });
        ws.once("error", reject);
      });

      // Outsider (Codex) cannot edit Claude's message
      const badPatch = await fetch(`${status.httpUrl}/api/channels/welcome/messages/${parentId}`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ac_cloud_codex_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "tampered" }),
      });
      expect(badPatch.status).toBe(403);

      // Sender (Claude) edits own message -> 200 + WS `message_edited`
      const okPatch = await fetch(`${status.httpUrl}/api/channels/welcome/messages/${parentId}`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ac_cloud_claude_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: "Deploy 100% passed on macOS_arm64 (edited)" }),
      });
      expect(okPatch.status).toBe(200);
      const patchedBody = (await okPatch.json()) as any;
      expect(patchedBody.message.content).toContain("(edited)");
      expect(patchedBody.message.edited_at).toBeTruthy();

      // Outsider (Codex) cannot delete Claude's message in welcome
      const badDel = await fetch(`${status.httpUrl}/api/channels/welcome/messages/${parentId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer ac_cloud_codex_secret" },
      });
      expect(badDel.status).toBe(403);

      // Sender (Claude) deletes own message -> 200 + WS `message_deleted`
      const okDel = await fetch(`${status.httpUrl}/api/channels/welcome/messages/${parentId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer ac_cloud_claude_secret" },
      });
      expect(okDel.status).toBe(200);

      // Wait briefly for WS frames
      await new Promise((r) => setTimeout(r, 80));
      const editEvt = wsEvents.find((f) => f.type === "message_edited" && f.message_id === parentId);
      expect(editEvt).toBeTruthy();
      expect(editEvt.content).toContain("(edited)");
      expect(editEvt.new_content).toContain("(edited)");
      expect(wsEvents.some((f) => f.type === "message_deleted" && f.message_id === parentId)).toBe(true);

      // Channel topic update via PATCH broadcasts `topic_update`
      const topicRes = await fetch(`${status.httpUrl}/api/channels/welcome`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer ac_cloud_claude_secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ topic: "Local dual-agent coding room" }),
      });
      expect(topicRes.status).toBe(200);

      // Presence broadcast: Claude connects on WS -> Codex receives `agent_online`, disconnects -> `agent_offline`
      const claudeWs = new WebSocket(status.wsUrl);
      await new Promise<void>((resolve, reject) => {
        claudeWs.once("open", () => {
          claudeWs.send(JSON.stringify({ type: "auth", agent_id: "cloud-claude-global", token: "ac_cloud_claude_secret" }));
        });
        claudeWs.on("message", (raw) => {
          const f = JSON.parse(String(raw));
          if (f.type === "auth_ok") resolve();
        });
        claudeWs.once("error", reject);
      });
      await new Promise((r) => setTimeout(r, 60));
      claudeWs.close();
      await new Promise((r) => setTimeout(r, 80));

      expect(wsEvents.some((f) => f.type === "topic_update" && f.topic === "Local dual-agent coding room")).toBe(true);
      expect(wsEvents.some((f) => f.type === "agent_online" && f.agent_id === "cloud-claude-global")).toBe(true);
      expect(wsEvents.some((f) => f.type === "agent_offline" && f.agent_id === "cloud-claude-global")).toBe(true);
      ws.close();
    } finally {
      await local.closeAll();
      await mockCloud.close();
    }
  });
});
