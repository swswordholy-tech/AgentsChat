import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertSafeParentDirectories, isSafeAgentId, loadConfig, validateEndpointUrl } from "../src/config.ts";
import { MuseAgentChatClient } from "../src/client.ts";
import * as wake from "../src/wake.ts";
const { appendWakeQueue, buildWakePayload, fireWake, redactSecrets, sanitizeMuseText } = wake;
import { main, registerOnly } from "../src/cli.ts";
import { TypingHeartbeat } from "../src/typing.ts";

const options = { agentId: "bot", token: "tok", url: "ws://localhost:9000" };
const identity = { AGENTCHAT_AGENT_ID: "bot", AGENTCHAT_TOKEN: "tok" };
const blockedHosts = [
  "0.0.0.0", "0", "0x0", "[::]", "[0:0:0:0:0:0:0:0]", "169.254.0.1", "169.254.255.255",
  "0xa9fea9fe", "2852039166", "100.100.100.200", "metadata.google.internal", "metadata.google.internal.",
  "metadata.goog", "foo.metadata.goog", "FOO.METADATA.GOOG.", "metadata", "instance-data",
  "[fe80::1]", "[febf::1]", "[fd00:ec2::254]", "[::ffff:169.254.1.2]", "[::ffff:a9fe:a9fe]",
  "[::ffff:100.100.100.200]", "[::ffff:6464:64c8]", "[::ffff:0:0]", "[::ffff:0:169.254.169.254]",
];
const secrets = [
  "ac_sensitive", "mcp_at_sensitive", "mcp_rt_sensitive", "mcp_code_sensitive", "agent_key_sensitive",
  "sk-sensitive", "whsec_sensitive", "rk_live_sensitive", "rk_test_sensitive", "AIzaSensitive1234",
  "glpat-sensitive", ..."baprs".split("").map(x => `xox${x}-sensitive`),
  "Bearer confidential", "Basic confidential", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  "abcdefgh.ijklmnop.qrstuvwx", "-----BEGIN RSA PRIVATE KEY-----\nprivate-body\n-----END RSA PRIVATE KEY-----",
];
function temp(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "muse126-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function hook(t, name, fn) {
  const original = fs[name];
  fs[name] = (...args) => fn(original, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}
function outbound(t) {
  const client = new MuseAgentChatClient(options);
  const sent = [];
  t.mock.method(client, "send", frame => sent.push(frame));
  return { client, sent };
}

test("126: config and client reject metadata/link-local/unspecified aliases across secure/plain protocols", t => {
  const old = process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP;
  process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP = "1";
  t.after(() => old === undefined ? delete process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP : process.env.AGENTSCHAT_ALLOW_INSECURE_HTTP = old);
  for (const host of blockedHosts) {
    for (const [scheme, kind] of [["https", "rest"], ["http", "rest"], ["wss", "ws"], ["ws", "ws"]]) {
      const url = `${scheme}://${host}/endpoint`;
      assert.throws(() => validateEndpointUrl(url, kind), /URL/, url);
      if (kind === "ws") assert.throws(() => new MuseAgentChatClient({ ...options, url }), /URL/, url);
    }
  }
});

test("126: URL guards reject port zero/query/hash before constructor or registration side effects", async t => {
  const dir = temp(t);
  for (const suffix of [":0", "/?query", "/#hash", "/?", "/#", '/a"b', "/a\\b"]) {
    assert.throws(() => new MuseAgentChatClient({ ...options, url: `wss://example.com${suffix}` }), /URL/);
    const file = join(dir, "new", "profile");
    await assert.rejects(registerOnly("bot", `https://example.com${suffix}`, file, async () => assert.fail("network reached")), /URL/);
    assert.equal(fs.existsSync(join(dir, "new")), false);
  }
  for (const host of blockedHosts) {
    await assert.rejects(registerOnly("bot", `https://${host}`, join(dir, "new", "profile"), async () => assert.fail("network reached")), /URL/);
  }
});

test("126: endpoint guards retain loopback, public IPv6 and dotted names", () => {
  for (const host of ["localhost:99", "127.0.0.1:99", "[::1]:99"]) {
    assert.doesNotThrow(() => new MuseAgentChatClient({ ...options, url: `ws://${host}/ws` }));
    assert.doesNotThrow(() => validateEndpointUrl(`http://${host}`, "rest"));
  }
  for (const host of ["example.com", "release-v1.0.example.com", "[2606:4700:4700::1111]", "[::ffff:8.8.8.8]", "metadata.goog.example.com"]) {
    assert.doesNotThrow(() => new MuseAgentChatClient({ ...options, url: `wss://${host}/ws` }));
    assert.doesNotThrow(() => validateEndpointUrl(`https://${host}`, "rest"));
  }
});

test("126: readProfile refuses ancestor symlinks and raw symlink/.. before touching profile", t => {
  const dir = temp(t), outside = temp(t), link = join(dir, "link");
  fs.symlinkSync(outside, link);
  fs.writeFileSync(join(outside, "profile"), JSON.stringify({ agentId: "leak", token: "tok" }));
  fs.writeFileSync(join(dir, "profile"), JSON.stringify({ agentId: "collapsed", token: "tok" }));
  const paths = [join(link, "profile"), `${link}/../profile`, `${link}/..//profile`, `${link}/../missing/profile`];
  const touched = [];
  hook(t, "existsSync", (original, path) => {
    if (paths.includes(path)) touched.push(["exists", path]);
    return original(path);
  });
  hook(t, "lstatSync", (original, path, ...args) => {
    if (paths.includes(path)) touched.push(["lstat", path]);
    return original(path, ...args);
  });
  hook(t, "readFileSync", (original, path, ...args) => {
    if (paths.includes(path)) touched.push(["read", path]);
    return original(path, ...args);
  });
  for (const path of paths) {
    assert.throws(() => loadConfig({}, path), /identity/);
    assert.equal(loadConfig(identity, path).agentId, "bot");
    assert.throws(() => assertSafeParentDirectories(path), /symlink/);
  }
  assert.deepEqual(touched, []);
  const safe = join(dir, "profile");
  assert.equal(loadConfig({}, safe).agentId, "collapsed");
});

test("126: Darwin canonical /tmp /var /etc links remain readable; arbitrary links fail", t => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", desc));
  const system = ["/tmp", "/var", "/etc"];
  let canonical = true;
  hook(t, "lstatSync", (_, path) => ({ isSymbolicLink: () => system.includes(path), isDirectory: () => !system.includes(path), isFile: () => path.endsWith("/profile"), size: 64 }));
  hook(t, "realpathSync", (_, path) => canonical ? `/private${path}` : "/attacker");
  hook(t, "existsSync", () => true);
  hook(t, "readFileSync", () => '{"agentId":"darwin-bot","token":"tok"}');
  for (const dir of system) {
    canonical = true;
    assert.equal(loadConfig({}, `${dir}/nested/profile`).agentId, "darwin-bot");
    canonical = false;
    assert.throws(() => loadConfig({}, `${dir}/nested/profile`), /identity/);
  }
});

test("126: agent IDs enforce 128 maximum and reserved-key rejection at config and registration", async t => {
  const file = join(temp(t), "profile");
  for (const id of ["a".repeat(129), "__proto__", "Constructor", "PROTOTYPE"]) {
    assert.equal(isSafeAgentId(id), false);
    assert.throws(() => loadConfig({ ...identity, AGENTCHAT_AGENT_ID: id }, file), /identity/);
    await assert.rejects(registerOnly("bot", "http://localhost:99", file, async () => new Response(JSON.stringify({ agentId: id, token: "tok" }))), /unsafe/);
    assert.equal(fs.existsSync(file), false);
  }
  assert.equal(isSafeAgentId("a".repeat(128)), true);
  assert.equal(isSafeAgentId("release-v1.0"), true);
});

test("126: all outbound channel paths reject separators/reserved keys while preserving dotted IDs", t => {
  const { client, sent } = outbound(t);
  for (const id of [".", "..", "/", "\\", "a/b", "a\\b", "__proto__", "Constructor", "PROTOTYPE", "bad\x00room", "x".repeat(129)]) {
    client.joinChannel(id); client.leaveChannel(id); client.sendMessage(id, "text"); client.sendTyping(id);
    client.handleMessage(JSON.stringify({ type: "channel_created", channel_id: id }));
  }
  assert.deepEqual(sent, []);
  assert.equal(client.joinedChannels.size, 0);
  for (const id of ["release-v1.0", "a.b", "x".repeat(128), " room "]) {
    client.joinChannel(id); client.sendMessage(id, "text"); client.sendTyping(id); client.leaveChannel(id);
    assert.deepEqual(sent.slice(-4).map(x => x.channel_id), Array(4).fill(id.trim()));
  }
});

test("126: replyTo rejects every C0/DEL and byte-independent 256 character boundary", t => {
  const { client, sent } = outbound(t);
  for (const code of [...Array(32).keys(), 127]) client.sendMessage("room", "text", "text", `a${String.fromCharCode(code)}b`);
  for (const value of ["x".repeat(257), {}, 1, null]) client.sendMessage("room", "text", "text", value);
  assert.deepEqual(sent, []);
  client.sendMessage("room", "text", "text", "r".repeat(256));
  assert.equal(sent[0].reply_to.length, 256);
  client.sendMessage("room", "text");
  assert.equal(Object.hasOwn(sent[1], "reply_to"), false);
});

test("126: own proto, arrays, malformed and UTF8 frames above 1MiB cannot invoke handlers", t => {
  const { client } = outbound(t);
  const received = [], errors = [];
  client.onMessage(m => received.push(m)); client.onError(e => errors.push(e.message));
  for (const raw of ['{"type":"message","__proto__":{},"content":"bad"}', '[{"type":"message"}]', 'null', '{bad']) client.handleMessage(raw);
  client.handleMessage('{"type":"auth_ok","session_id":"bad","__proto__":{}}');
  assert.equal(client.session, null);
  const frame = content => JSON.stringify({ type: "message", channel_id: "room", content });
  const overhead = Buffer.byteLength(frame(""));
  const exact = frame("x".repeat(1_048_576 - overhead));
  client.handleMessage(exact);
  client.handleMessage(frame("x".repeat(1_048_577 - overhead)));
  client.handleMessage(frame("汉".repeat(400_000)));
  assert.equal(received.length, 1);
  assert.equal(Buffer.byteLength(exact), 1_048_576);
  assert.deepEqual(errors, []);
});

test("126: auth/error fields scrub all credentials, PEM blocks and controls before rejecting/emitting", t => {
  const { client } = outbound(t);
  const errors = [], rejects = [];
  client.onError(e => errors.push(e.message));
  client.connectReject = e => rejects.push(e.message);
  const dirty = secrets.join(" | ") + "\x00\x1b\x7f";
  client.handleMessage(JSON.stringify({ type: "error", message: dirty }));
  client.handleMessage(JSON.stringify({ type: "auth_error", error: dirty, message: "unused" }));
  assert.equal(rejects.length, 1);
  assert.equal(errors.length, 2);
  for (const text of [...errors, ...rejects]) {
    for (const secret of secrets) assert.ok(!text.includes(secret), secret);
    assert.doesNotMatch(text, /private-body|[\x00-\x1f\x7f]/);
    assert.ok(text.length <= 1024);
  }
  assert.equal(client.explicitlyDisconnected, true);
});

test("126: redaction covers each credential family and complete/unterminated PEM before truncation", () => {
  for (const secret of secrets) {
    assert.equal(redactSecrets(secret), "[redacted]", secret);
    const payload = buildWakePayload({ content: "x".repeat(494) + " " + secret });
    assert.equal(payload.content, ("x".repeat(494) + " [redacted]").slice(0, 500));
  }
  for (const type of ["", "RSA ", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    assert.equal(redactSecrets(`-----BEGIN ${type}PRIVATE KEY-----\nhidden`), "[redacted]");
  }
  assert.equal(sanitizeMuseText("whsec_\x01sensitive"), "[redacted]");
  assert.equal(redactSecrets("release-v1.0 ordinary 汉字🙂"), "release-v1.0 ordinary 汉字🙂");
});

test("126: wake structured fields, mentions and content are bounded/sanitized without input mutation", () => {
  const dirty = "a\x00\x1b\x7f" + "z".repeat(600);
  const msg = { type: dirty, id: dirty, channel_id: dirty, sender_id: "whsec_sensitive", content: dirty, timestamp: dirty, mentioned_ids: [null, 1, ...Array(300).fill(dirty)] };
  const before = JSON.stringify(msg);
  const payload = buildWakePayload(msg, { targetSessionId: dirty });
  const caps = { type: 64, message_id: 256, channel_id: 128, sender_id: 128, content: 500, timestamp: 64, target_session_id: 128 };
  for (const [key, cap] of Object.entries(caps)) {
    assert.ok(payload[key].length <= cap, key);
    assert.doesNotMatch(payload[key], /[\x00-\x1f\x7f]/);
  }
  assert.equal(payload.sender_id, "[redacted]");
  assert.equal(payload.mentioned_ids.length, 256);
  assert.ok(payload.mentioned_ids.every(x => x.length === 128 && !/[\x00-\x1f\x7f]/.test(x)));
  assert.equal(JSON.stringify(msg), before);
  assert.equal(buildWakePayload({ id: {}, channel_id: 1, sender_id: null }).message_id, undefined);
});

test("126: wake transport blocks metadata/mapped/unspecified hosts with zero fetch calls", async () => {
  let calls = 0;
  for (const host of blockedHosts) for (const scheme of ["https", "http"]) {
    await fireWake({}, { url: `${scheme}://${host}/wake`, fetchImpl: async () => { calls++; return new Response(); } });
  }
  assert.equal(calls, 0);
  for (const url of ["http://localhost:99", "http://[::1]:99", "https://example.com"]) {
    await fireWake({ id: "m" }, { url, fetchImpl: async (_, init) => { calls++; assert.equal(init.redirect, "error"); return new Response(); } });
  }
  assert.equal(calls, 3);
});

test("126: wake failure logs redact credentials/control characters and queued payload remains sanitized", async t => {
  const logs = [];
  await fireWake({}, { url: "https://example.com/whsec_sensitive?token=ac_sensitive", logger: text => logs.push(text), fetchImpl: async () => { throw new Error(secrets.join(" ") + "\x1b\n"); } });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /sensitive|private-body|[\x00-\x1f\x7f]/);
  const file = join(temp(t), "queue");
  const payload = buildWakePayload({ id: "message", sender_id: "whsec_sensitive", content: secrets.join(" ") });
  appendWakeQueue(file, payload);
  const queued = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(queued.sender_id, "[redacted]");
  assert.doesNotMatch(queued.content, /sensitive|private-body/);
});

for (const mode of ["--listen", "--wake"]) test(`126: ${mode} stdout scrubs sender/channel/content fields`, async t => {
  const dir = temp(t), previous = { ...process.env };
  Object.assign(process.env, identity, { AGENTCHAT_WS_URL: options.url, MUSE_WAKE_QUEUE: join(dir, "queue") });
  delete process.env.MUSE_WAKE_URL; delete process.env.AGENTCHAT_WAKE_URL;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  for (const method of ["joinChannel", "sendTyping", "disconnect"]) t.mock.method(MuseAgentChatClient.prototype, method, () => {});
  t.mock.method(MuseAgentChatClient.prototype, "connect", async () => {});
  t.mock.method(TypingHeartbeat.prototype, "start", () => {});
  t.mock.method(MuseAgentChatClient.prototype, "waitUntilClosed", async function () {
    for (const handler of this.messageHandlers) await handler({ id: "whsec_sensitive", channel_id: "dm-test\x1bwhsec_sensitive", sender_id: "glpat-sensitive\x00", content: "@bot " + secrets.join(" | ") + "\x1b\x7f", content_type: "text", timestamp: "now" });
  });
  await main([mode, "--channel", "dm-test"]);
  const line = logs.find(x => mode === "--listen" ? x.includes("[dm-test") : x.startsWith("[wake]"));
  assert.ok(line);
  assert.doesNotMatch(line, /sensitive|private-body|[\x00-\x1f\x7f]/);
  assert.ok(line.includes("[redacted]"));
});

test("126: direct CLI failure stderr redacts secrets and control characters", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const script = `globalThis.WebSocket = class { constructor() { throw new Error('whsec_sensitive\\x1b\\n'); } }; process.argv = [process.execPath, ${JSON.stringify(cli)}, '--listen']; await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ...identity, AGENTCHAT_WS_URL: options.url }, timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[redacted\]/);
  assert.doesNotMatch(result.stderr, /sensitive|\x1b/);
});
