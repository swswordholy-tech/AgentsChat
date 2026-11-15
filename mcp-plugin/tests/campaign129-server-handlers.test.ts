import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "../src/server.ts");
const homes: string[] = [];
let hub: ReturnType<typeof Bun.serve>;
let BASE = "";
const hitPaths: string[] = [];
const glTok = `${"gl"}${"pat-"}SecretServerToken123456`;

beforeEach(() => {
  hitPaths.length = 0;
});

beforeAll(() => {
  hub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hitPaths.push(`${req.method} ${url.pathname}`);
      if (req.headers.get("authorization") !== "Bearer ac_test_token_1234567890") {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (req.method === "POST" && url.pathname === "/mcp") {
        const rpc = (await req.json()) as any;
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "Unknown tool: agentschat_cloud_agent_wake_health" },
        });
      }
      // Production route name in Server/src/cloud-wake-health.ts: /api/channels/:id/wake-health
      if (req.method === "GET" && url.pathname === "/api/channels/prod-room/wake-health") {
        return Response.json({
          channel_id: "prod-room",
          observation_only: true,
          agents: [
            {
              agent_id: "codex-live",
              name: "Codex Live human@example.com",
              runtime: "codex",
              cloud_status: "active",
              wake: { status: "ok", last_wake_at: "2026-11-15T02:00:00.000Z", last_duration_ms: 420 },
            },
          ],
        });
      }
      if (req.method === "POST" && url.pathname === "/api/loops/loop-err/pause") {
        return new Response(`upstream failed: Bearer superSecretBearer123 ${glTok} https://u:pass123@db.internal`, {
          status: 502,
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  hub?.stop(true);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};
const INITED = { jsonrpc: "2.0", method: "notifications/initialized" };
const callTool = (id: number, name: string, args: any = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ac-c129-mcp-"));
  homes.push(home);
  const dir = join(home, ".agentschat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "TestBot.json"),
    JSON.stringify({
      agent_id: "test-bot-c129",
      token: "ac_test_token_1234567890",
      saved_at: new Date().toISOString(),
    }),
  );
  return home;
}

function drive(frames: any[], waitMs = 1800) {
  return new Promise<{ res: Map<number, any> }>((done) => {
    const child = spawn(process.execPath, [ENTRY, "--url", BASE, "--profile", "TestBot"], {
      env: {
        PATH: process.env.PATH!,
        HOME: makeHome(),
        AGENTCHAT_NO_PROXY: "1",
        AGENTCHAT_REST_URL: BASE,
        AGENTCHAT_URL: "ws://127.0.0.1:1/ws",
        AGENTSCHAT_TOOL_ONLY: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const res = new Map<number, any>();
    child.stdout.on("data", (data) => {
      out += data;
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) res.set(msg.id, msg);
        } catch {}
      }
    });
    (async () => {
      for (const f of frames) {
        child.stdin.write(JSON.stringify(f) + "\n");
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, waitMs));
      child.kill();
      done({ res });
    })();
  });
}

describe("Campaign #129 KR3 — MCP server REST route parity, path traversal & error redaction", () => {
  test("cloud_agent_wake_health hits canonical /api/channels/:id/wake-health first in production fallback", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      callTool(3, "cloud_agent_wake_health", { channel_id: "prod-room" }),
    ]);
    const text = res.get(3)?.result?.content?.[0]?.text || "";
    const payload = JSON.parse(text);
    expect(payload).toMatchObject({
      channel_id: "prod-room",
      observation_only: true,
      untrusted: true,
      summary: { total: 1, ok: 1, auth_required: 0, timeout: 0, error: 0, unobserved: 0 },
    });
    expect(text).toContain("human@example.com");
    expect(hitPaths).toContain("GET /api/channels/prod-room/wake-health");
    expect(hitPaths).not.toContain("GET /api/channels/prod-room/cloud-wake-health");
  });

  test("blocks ./../prototype path traversal across pause_loop, stop_loop, wake_health, pins, proposals, and vote without hitting HTTP", async () => {
    const { res } = await drive([
      INIT,
      INITED,
      callTool(2, "load_tool_group", { group_name: "notifications" }),
      callTool(3, "load_tool_group", { group_name: "moderation" }),
      callTool(4, "pause_loop", { loop_id: ".." }),
      callTool(5, "pause_loop", { loop_id: "." }),
      callTool(6, "pause_loop", { loop_id: "__proto__" }),
      callTool(7, "stop_loop", { loop_id: "." }),
      callTool(8, "cloud_agent_wake_health", { channel_id: ".." }),
      callTool(9, "list_pins", { chat_id: "__proto__" }),
      callTool(10, "list_proposals", { chat_id: "../admin" }),
      callTool(11, "propose", { chat_id: "..", title: "T", content: "C" }),
      callTool(12, "vote", { chat_id: "room-1", proposal_id: "..", decision: "approve" }),
      callTool(13, "pause_loop", { loop_id: "loop-err" }),
    ]);

    for (const id of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(res.get(id)?.result?.isError).toBe(true);
    }
    // Only startup onboarding + the valid loop-err request should have touched HTTP!
    expect(hitPaths.filter((p) => p !== "GET /api/account/onboarding")).toEqual(["POST /api/loops/loop-err/pause"]);

    const errText = res.get(13)?.result?.content?.[0]?.text || "";
    expect(errText).not.toContain("superSecretBearer123");
    expect(errText).not.toContain("SecretServerToken123456");
    expect(errText).not.toContain("pass123");
  });
});
