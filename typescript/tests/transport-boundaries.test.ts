import { expect, test } from "bun:test";
import { AgentChatClient } from "../src/client";
import { AgentChatREST } from "../src/rest";
import { redactError } from "../src/security";

const MAX_BYTES = 10 * 1024 * 1024;
const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).concat("\x7f");
const ws = (url = "wss://agents-chat.com/ws", agentId = "bot", token = "secret") =>
  new AgentChatClient({ url, agentId, token });

test("REST rejects unsafe schemes, remote plaintext, credentials, query, hash and whitespace", () => {
  for (const baseUrl of [
    "", " ", " https://example.com", "https://example.com ", "file:///tmp/key", "ftp://localhost",
    "ws://localhost", "http://example.com", "http://localhost.example.com", "http://[::2]",
    "https://user@example.com", "https://user:pass@example.com", "https://@example.com",
    "https://example.com?token=secret", "https://example.com?", "https://example.com#secret", "https://example.com#",
    ...controls.map(c => `https://example.com/${c}`),
  ]) expect(() => new AgentChatREST({ baseUrl })).toThrow("Invalid baseUrl");
});

test("secure and loopback REST endpoints preserve path prefixes and bearer overrides", async () => {
  for (const baseUrl of ["https://example.com", "http://localhost:8080", "http://127.0.0.1", "http://[::1]:8080"]) {
    const calls: Array<[string, string | null]> = [];
    const rest = new AgentChatREST({ baseUrl: `${baseUrl}/prefix/`, bearerToken: " default ",
      fetchImpl: async (url, init) => {
        calls.push([String(url), new Headers(init?.headers).get("Authorization")]);
        return Response.json({});
      } });
    await rest.health();
    await rest.getMe({ bearerToken: " override " });
    await rest.listPersonalSkills({ bearerToken: " " });
    expect(calls).toEqual([
      [`${baseUrl}/prefix/health`, "Bearer default"],
      [`${baseUrl}/prefix/api/account/me`, "Bearer override"],
      [`${baseUrl}/prefix/api/skills`, "Bearer default"],
    ]);
  }
});

test("WebSocket rejects unsafe URL schemes, remote plaintext, userinfo, fragments and controls", () => {
  for (const url of ["", " ", " wss://localhost/ws", "https://localhost/ws", "file:///tmp/ws",
    "ws://example.com/ws", "ws://localhost.example.com/ws", "ws://[::2]/ws",
    "wss://user:pass@example.com/ws", "wss://@example.com/ws", "wss://example.com/ws#", "wss://example.com/ws#fragment",
    ...controls.map(c => `wss://localhost/${c}`),
  ]) expect(() => ws(url)).toThrow("Invalid url");
  for (const url of ["wss://agents-chat.com/ws", "wss://localhost/ws", "ws://localhost/ws", "ws://127.0.0.1:9999/ws", "ws://[::1]/ws?version=1"]) {
    expect(ws(url).url).toBe(url);
  }
});

test("WebSocket validates agentId and token before any connection", () => {
  for (const id of ["", " ", ...controls.map(c => `bot${c}`)]) expect(() => ws(undefined, id)).toThrow("agentId");
  for (const c of controls) expect(() => ws(undefined, "bot", `${c}secret${c}`)).toThrow("token");
  expect(ws(undefined, "机器人", "").agentId).toBe("机器人");
  expect(new AgentChatClient({ url: "wss://localhost/ws", agentId: "bot" }).token).toBe("dev-token");
});

test("REST rejects all C0 and DEL token controls before trimming or fetch, across override paths", async () => {
  let calls = 0;
  const rest = new AgentChatREST({ baseUrl: "https://example.com", bearerToken: "default",
    fetchImpl: async () => { calls++; return Response.json({}); } });
  for (const c of controls) {
    const bearerToken = `${c}key${c}`;
    expect(() => new AgentChatREST({ baseUrl: "https://example.com", bearerToken })).toThrow("bearerToken");
    await expect(rest.getMe({ bearerToken })).rejects.toThrow("bearerToken");
    await expect(rest.listPersonalSkills({ bearerToken })).rejects.toThrow("bearerToken");
    await expect(rest.iterateChannelEvents("room", { bearerToken }).next()).rejects.toThrow("bearerToken");
  }
  expect(calls).toBe(0);
});

test("diagnostic redaction includes exact tokens, ac, Bearer, OpenAI keys and JWT", () => {
  const secrets = ["exact.token+value", "ac_other", "sk-123456789012", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"];
  const message = `${secrets.join(" ")} Bearer another-secret`;
  const redacted = redactError(message, secrets[0]);
  for (const secret of [...secrets, "another-secret"]) expect(redacted).not.toContain(secret);
  expect(redactError("plain text sk-short eyJguide 中文")).toBe("plain text sk-short eyJguide 中文");
});

test("REST, SSE and WebSocket diagnostic paths redact OpenAI and JWT secrets", async () => {
  const message = "sk-123456789012 eyJheader.payload.signature";
  const rest = new AgentChatREST({ baseUrl: "https://example.com", fetchImpl: async () => Response.json({ message }, { status: 403 }) });
  for (const request of [() => rest.health(), () => rest.iterateChannelEvents("room").next()]) {
    await expect(request()).rejects.toThrow("HTTP 403: [REDACTED] [REDACTED]");
  }
  const client = new AgentChatClient({ url: "wss://localhost/ws", agentId: "bot", wsFactory: () => { throw new Error(message); } });
  await expect(client.connect()).rejects.toThrow("[REDACTED] [REDACTED]");
});

test("REST and SSE default to redirect error and retain valid auth headers", async () => {
  const redirects: (RequestRedirect | undefined)[] = [];
  const rest = new AgentChatREST({ baseUrl: "https://example.com", bearerToken: "default",
    fetchImpl: async (_url, init) => {
      redirects.push(init?.redirect);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer default");
      return Response.json({});
    } });
  await rest.health();
  await rest.iterateChannelEvents("room").next();
  expect(redirects).toEqual(["error", "error"]);
});

test("real HTTP redirects never reach a second origin for JSON or SSE", async () => {
  let leaked = 0;
  let received = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked++; return Response.json({}); } });
  let status = 301;
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    received++;
    expect(req.headers.get("Authorization")).toBe("Bearer private-key");
    return new Response(null, { status, headers: { Location: `http://127.0.0.1:${target.port}/other` } });
  } });
  try {
    const rest = new AgentChatREST({ baseUrl: `http://127.0.0.1:${source.port}`, bearerToken: "private-key" });
    for (status of [301, 302, 303, 307, 308]) {
      await expect(rest.health()).rejects.toThrow();
      await expect(rest.iterateChannelEvents("room").next()).rejects.toThrow();
    }
    expect(received).toBe(10);
    expect(leaked).toBe(0);
  } finally { source.stop(true); target.stop(true); }
});

function oversized(status = 200) {
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(MAX_BYTES + 1).fill(32)); },
    cancel() { cancellations++; return new Promise<void>(() => {}); },
  });
  return { stream, response: new Response(stream, { status, headers: { "Content-Length": "2" } }), cancelled: () => cancellations };
}

test("JSON success, HTTP errors, SSE error bodies and archive responses share a hard byte limit", async () => {
  for (const kind of ["json", "error", "sse", "archive"]) {
    const result = oversized(kind === "error" || kind === "sse" ? 503 : 200);
    const rest = new AgentChatREST({ baseUrl: "http://localhost", fetchImpl: async () => result.response });
    const operation = kind === "sse" ? rest.iterateChannelEvents("room").next()
      : kind === "archive" ? rest.archiveChannelDoc("room", "doc") : rest.health();
    await expect(operation).rejects.toThrow("10 MiB");
    expect(result.cancelled()).toBe(1);
    expect(result.stream.locked).toBe(false);
  }
});

test("JSON limit measures actual UTF-8 bytes, accepts exactly 10 MiB and decodes split characters", async () => {
  const prefix = '{"data":"';
  const suffix = '"}';
  const overhead = prefix.length + suffix.length;
  const chars = Math.floor((MAX_BYTES - overhead) / 3);
  const payload = prefix + "文".repeat(chars) + " ".repeat((MAX_BYTES - overhead) % 3) + suffix;
  const encoded = new TextEncoder().encode(payload);
  expect(encoded.byteLength).toBe(MAX_BYTES);
  let offset = 0;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === encoded.length) { controller.close(); return; }
    const end = Math.min(offset + 65537, encoded.length);
    controller.enqueue(encoded.slice(offset, end));
    offset = end;
  } }));
  const rest = new AgentChatREST({ baseUrl: "http://localhost", fetchImpl: async () => response });
  expect((await rest.health() as unknown as { data: string }).data).toBe(JSON.parse(payload).data);
  expect(response.body?.locked).toBe(false);
});

test("malformed JSON and body read failures release the body lock and scrub errors", async () => {
  const malformed = new Response('{"broken":');
  const rest = new AgentChatREST({ baseUrl: "http://localhost", fetchImpl: async () => malformed });
  await expect(rest.health()).rejects.toThrow();
  expect(malformed.body?.locked).toBe(false);
  const failed = new Response(new ReadableStream({ pull() { throw new Error("sk-123456789012"); } }));
  const broken = new AgentChatREST({ baseUrl: "http://localhost", fetchImpl: async () => failed });
  await expect(broken.health()).rejects.toThrow("[REDACTED]");
  expect(failed.body?.locked).toBe(false);
});

test("stalled JSON and failed SSE handshakes cancel on deadline even if fetch ignores its signal", async () => {
  for (const sse of [false, true]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise<void>(() => {}); } });
    const rest = new AgentChatREST({ baseUrl: "http://localhost", timeoutMs: 15,
      fetchImpl: async () => new Response(stream, { status: sse ? 503 : 200 }) });
    await expect(sse ? rest.iterateChannelEvents("room").next() : rest.health()).rejects.toThrow("timed out after 15ms");
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  }
});
