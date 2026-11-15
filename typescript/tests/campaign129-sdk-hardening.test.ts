import { describe, expect, test } from "bun:test";
import { AgentChatClient } from "../src/client";
import { AgentChatREST } from "../src/rest";
import { redactError, validatePathSegment, validateTransportUrl } from "../src/security";

describe("Campaign #129 KR4 — TypeScript SDK SSRF, path-segment, frame-bound & redaction parity", () => {
  test("validateTransportUrl blocks cloud metadata, unspecified binds, and IPv4-mapped metadata/unspecified hosts", () => {
    const blockedRest = [
      "https://0.0.0.0",
      "https://[::]",
      "https://[0:0:0:0:0:0:0:0]",
      "https://100.100.100.200",
      "https://[fd00:ec2::254]",
      "https://metadata",
      "https://instance-data",
      "https://sub.metadata.google.internal",
      "https://sub.metadata.goog",
      "https://[::ffff:169.254.169.254]",
      "https://[::ffff:100.100.100.200]",
      "https://[::ffff:0.0.0.0]",
      "https://[0:0:0:0:0:ffff:6464:64c8]",
    ];
    for (const baseUrl of blockedRest) {
      expect(() => new AgentChatREST({ baseUrl })).toThrow("Invalid baseUrl");
    }

    const blockedWs = [
      "wss://0.0.0.0/ws",
      "wss://[::]/ws",
      "wss://100.100.100.200/ws",
      "wss://[fd00:ec2::254]/ws",
      "wss://[::ffff:169.254.169.254]/ws",
      "wss://sub.metadata.google.internal/ws",
    ];
    for (const url of blockedWs) {
      expect(() => validateTransportUrl(url, true)).toThrow("Invalid url");
    }
  });

  test("validatePathSegment rejects prototype keys, >256-char segments, C1 controls, and pre-encoded traversal while preserving Unicode handles & query-encoded tags", () => {
    expect(() => validatePathSegment("机器人", "agentId")).not.toThrow();
    expect(() => validatePathSegment("bot#tag", "agentId")).not.toThrow();
    for (const bad of [
      "__proto__",
      "constructor",
      "prototype",
      "__PROTO__",
      "x".repeat(257),
      "room%2fadmin",
      "room%5cadmin",
      "%2e%2e",
      "bot\x85",
    ]) {
      expect(() => validatePathSegment(bad, "seg")).toThrow("Invalid seg");
    }
  });

  test("redactError scrubs GitLab, Stripe rk_live/test, HuggingFace/npm tokens, URL userinfo, and C1 controls while keeping CJK text", () => {
    const glTok = `${"gl"}${"pat-"}SdkSecretToken12345`;
    const rkTok = `${"rk_"}${"live_"}SdkRestrictedKey12345`;
    const hfTok = `${"hf"}${"_"}HuggingFaceSecretToken12345`;
    const msg = `err https://user:secretPass99@api.example.com/v1 ${glTok} ${rkTok} ${hfTok} 中文\x85`;
    const out = redactError(msg);
    expect(out).not.toContain("secretPass99");
    expect(out).not.toContain("SdkSecretToken12345");
    expect(out).not.toContain("SdkRestrictedKey12345");
    expect(out).not.toContain("HuggingFaceSecretToken12345");
    expect(out).not.toContain("\x85");
    expect(out).toContain("https://[REDACTED]@api.example.com/v1");
    expect(out).toContain("中文");
  });

  test("AgentChatClient drops >4MiB inbound WS frames, decodes binary UTF-8 frames, and strips unsafe shard_moved targetUrl", async () => {
    let fakeSocket: any = null;
    const receivedMessages: any[] = [];
    const reconnectEvents: any[] = [];

    const client = new AgentChatClient({
      url: "wss://agents-chat.com/ws",
      agentId: "sdk-bot",
      token: "tok-1",
      wsFactory: () => {
        fakeSocket = {
          readyState: WebSocket.OPEN,
          send() {},
          close() {},
          onopen: null as any,
          onmessage: null as any,
          onclose: null as any,
          onerror: null as any,
        };
        queueMicrotask(() => {
          fakeSocket.onopen?.();
          fakeSocket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", session_id: "s1" }) });
        });
        return fakeSocket as unknown as WebSocket;
      },
    });

    client.onMessage((m) => receivedMessages.push(m));
    client.onReconnectNeeded((ev) => reconnectEvents.push(ev));
    await client.connect();

    // 1. Binary Uint8Array UTF-8 frame within 4 MiB decodes cleanly
    const binaryFrame = new TextEncoder().encode(
      JSON.stringify({
        type: "message",
        id: "m1",
        channel_id: "c1",
        sender_id: "peer",
        sender_type: "agent",
        content: "hello binary",
        content_type: "text",
        timestamp: "2026-11-15T02:00:00.000Z",
      }),
    );
    fakeSocket.onmessage({ data: binaryFrame });
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].content).toBe("hello binary");

    // 2. Oversized >4 MiB frame is dropped before JSON.parse
    const huge = `{"type":"message","id":"m2","channel_id":"c1","content":"${"x".repeat(4 * 1024 * 1024 + 64)}"}`;
    fakeSocket.onmessage({ data: huge });
    expect(receivedMessages).toHaveLength(1);

    // 3. Unsafe SSRF target_url on shard_moved is stripped before invoking handlers
    fakeSocket.onmessage({
      data: JSON.stringify({
        type: "shard_moved",
        target_url: "ws://169.254.169.254/ws",
      }),
    });
    expect(reconnectEvents).toEqual([{ reason: "shard_moved" }]);
    client.disconnect();
  });
});
