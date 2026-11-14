import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldDispatch } from "../src/policy.ts";
import { buildMuseWakePrompt, fireWake, appendWakeQueue } from "../src/wake.ts";
import { loadConfig } from "../src/config.ts";
import * as config from "../src/config.ts";
import { registerOnly } from "../src/cli.ts";

const root = () => fs.mkdtempSync(join(tmpdir(), "muse119-"));
const identity = { AGENTCHAT_AGENT_ID: "bot", AGENTCHAT_TOKEN: "tok" };
const response = () => new Response('{"agentId":"bot","token":"tok"}');
const register = (file, fetchImpl = async () => response(), url = "http://127.0.0.1:8080") =>
  registerOnly("muse", url, file, fetchImpl);
function hook(name, impl, run) {
  const original = fs[name];
  fs[name] = (...args) => impl(original, ...args);
  syncBuiltinESMExports();
  try { return run(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
async function hookAsync(name, impl, run) {
  const original = fs[name];
  fs[name] = (...args) => impl(original, ...args);
  syncBuiltinESMExports();
  try { return await run(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}

test("119: unknown-kind DM colon parity preserves explicit group and self guards", () => {
  for (const channel_id of ["dm:one", "DM:two", "dm-one", "DM-two"]) {
    const msg = { channel_id, sender_id: "alice", content: "hello" };
    assert.equal(shouldDispatch(msg, { agentId: "bot" }), true);
    assert.equal(shouldDispatch(msg, { agentId: "bot", channelKind: "group" }), false);
    assert.equal(shouldDispatch({ ...msg, sender_id: "bot" }, { agentId: "bot" }), false);
  }
});

test("119: prompt headers remove every C0/DEL character and bound all three identifiers", () => {
  const dirty = "x" + Array.from({length: 32}, (_, i) => String.fromCharCode(i)).join("") + "\x7f" + "z".repeat(200);
  const clean = dirty.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 128);
  const prompt = buildMuseWakePrompt({ type: "message", channel_id: dirty, sender_id: dirty, message_id: dirty });
  assert.doesNotMatch(prompt, /[\x00-\x1f\x7f]/);
  assert.equal(prompt.split(clean).length - 1, 4);
  assert.ok(!prompt.includes("z".repeat(129)));
});

test("119: wake blocks credentials, zero port and remote metadata/private/link-local literals before transport", async () => {
  let calls = 0;
  for (const host of ["169.254.169.254", "169.254.1.2", "0xa9fea9fe", "metadata.google.internal", "metadata.goog.", "[::ffff:169.254.169.254]", "[::ffff:0:169.254.169.254]", "[fe80::1]", "[fc00::1]", "10.0.0.1", "172.16.1.1", "192.168.0.1", "example.com:0", "user:secret@example.com"]) {
    await fireWake({}, { url: `http://${host}/wake`, fetchImpl: async () => { calls++; return response(); } });
  }
  assert.equal(calls, 0);
  for (const url of ["http://localhost:9999/wake", "http://127.0.0.1:9999/wake", "http://[::1]:9999/wake", "https://example.com/wake"]) {
    await fireWake({}, { url, fetchImpl: async (_, init) => { calls++; assert.equal(init.redirect, "error"); return response(); } });
  }
  assert.equal(calls, 4);
});

test("119: config and registration reject ambiguous endpoint input before any network or mkdir", async () => {
  for (const suffix of [":0", "/?a=1", "/#hash", "/?", "/#", "/a\\b", '/a"b', "/<x>"]) {
    const url = `https://example.com${suffix}`;
    for (const [key, value] of [["AGENTCHAT_REST_URL", url], ["AGENTCHAT_WS_URL", url.replace("https:", "wss:")]]) {
      assert.throws(() => loadConfig({ ...identity, [key]: value }, join(root(), "none")), /URL/);
    }
    const dir = root(); const file = join(dir, "new", "profile");
    await assert.rejects(register(file, async () => { assert.fail("network reached"); }, url), /URL/);
    assert.equal(fs.existsSync(join(dir, "new")), false);
  }
  for (const url of [" https://example.com", "https://example.com ", "https://exa\nmple.com"]) {
    assert.throws(() => loadConfig({ ...identity, AGENTCHAT_REST_URL: url }), /URL/);
    await assert.rejects(register(join(root(), "p"), async () => { assert.fail("network reached"); }, url), /URL/);
  }
});

test("119: profile own proto and unsafe IDs cannot supply an identity", async () => {
  const file = join(root(), "profile");
  fs.writeFileSync(file, '{"agentId":"bot","token":"tok","__proto__":{}}');
  assert.throws(() => loadConfig({}, file), /Missing/);
  for (const agentId of [".", "..", "__PROTO__", "Constructor", "PROTOTYPE", "a/b", "a\\b", "a b", "a\tb", "a\x7fb"]) {
    assert.throws(() => loadConfig({ ...identity, AGENTCHAT_AGENT_ID: agentId }, file), /identity/);
    await assert.rejects(register(file, async () => new Response(JSON.stringify({ agentId, token: "tok" }))), /unsafe/);
  }
  for (const agentId of ["a", "bot-1", "bot_2", "bot.name", "机器人"]) {
    assert.equal(loadConfig({ ...identity, AGENTCHAT_AGENT_ID: agentId }, file).agentId, agentId);
  }
});

test("119: registration streams exact 1MiB response across split Unicode, rejects byte +1 and cancels", async () => {
  const file = join(root(), "profile");
  const encoder = new TextEncoder();
  const base = JSON.stringify({ agentId: "bot", token: "tok", extra: "汉🙂" });
  const bytes = encoder.encode(base + " ".repeat(1024 * 1024 - encoder.encode(base).length));
  const split = encoder.encode(base.slice(0, base.indexOf("汉"))).length + 1;
  let initSeen;
  await register(file, async (_, init) => {
    initSeen = init;
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, split)); c.enqueue(bytes.slice(split)); c.close(); } }));
  });
  assert.equal(initSeen.redirect, "error");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { agentId: "bot", token: "tok" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const status of [200, 500]) {
    let cancelled = false;
    let sent = false;
    await assert.rejects(register(file, async () => new Response(new ReadableStream({
      pull(c) { if (sent) c.close(); else { sent = true; c.enqueue(new Uint8Array(1024 * 1024 + 1)); } },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 }), {status, headers: { "content-length": "1" }})), /1MiB/);
    assert.equal(cancelled, true);
  }
});

test("119: malformed/truncated UTF8, nonobject and own-proto registration responses preserve profile", async () => {
  const file = join(root(), "profile"); fs.writeFileSync(file, "original");
  for (const body of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xe2, 0x82]), "null", "[]", '{"agentId":"bot","token":"tok","__proto__":{}}']) {
    await assert.rejects(register(file, async () => new Response(body)));
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  }
});

test("119: ancestor symlinks are rejected before recursive mkdir for queue and profile", async () => {
  const dir = root(); const outside = root(); const link = join(dir, "link"); fs.symlinkSync(outside, link);
  const file = join(link, "new", "nested", "file");
  assert.throws(() => appendWakeQueue(file, { type: "message" }), /symlink/);
  await assert.rejects(register(file, async () => { assert.fail("network reached"); }), /symlink/);
  assert.equal(fs.existsSync(join(outside, "new")), false);
  const traversal = `${link}/../muse119-traversal-${process.pid}/file`;
  assert.throws(() => appendWakeQueue(traversal, { type: "message" }), /symlink/);
  await assert.rejects(register(traversal, async () => { assert.fail("network reached"); }), /symlink/);
});

test("119: append rechecks target after reading and rotation rejects a replacement directory", () => {
  const file = join(root(), "queue"); fs.writeFileSync(file, '{"message_id":"old"}\n');
  hook("readFileSync", (original, path, ...args) => {
    const data = original(path, ...args);
    if (path === file) { fs.unlinkSync(file); fs.mkdirSync(file); }
    return data;
  }, () => assert.throws(() => appendWakeQueue(file, { type: "message", message_id: "new" }), /non-regular/));
  fs.rmdirSync(file); fs.writeFileSync(file, '{"message_id":"old"}\n');
  hook("writeFileSync", (original, path, ...args) => {
    const result = original(path, ...args);
    if (String(path).endsWith(".tmp")) { fs.unlinkSync(file); fs.mkdirSync(file); }
    return result;
  }, () => assert.throws(() => appendWakeQueue(file, { type: "message", message_id: "new" }, 1), /non-regular/));
  assert.deepEqual(fs.readdirSync(join(file, "..")), ["queue"]);
});

test("119: registration rechecks target after temp write and removes only its temporary file", async () => {
  const file = join(root(), "profile"); fs.writeFileSync(file, "old");
  await hookAsync("writeFileSync", (original, path, ...args) => {
    const result = original(path, ...args);
    if (String(path).endsWith(".tmp")) { fs.unlinkSync(file); fs.mkdirSync(file); }
    return result;
  }, () => assert.rejects(register(file), /non-regular/));
  assert.deepEqual(fs.readdirSync(join(file, "..")), ["profile"]);
});

test("119: exclusive private temp writes refuse preexisting symlinks in rotation and registration", async () => {
  const dir = root(); const file = join(dir, "queue"); const victim = join(dir, "victim");
  fs.writeFileSync(victim, "keep"); fs.writeFileSync(file, '{"message_id":"old"}\n');
  const intercept = (original, path, data, opts) => {
    if (String(path).endsWith(".tmp")) {
      assert.equal(opts.flag, "wx"); assert.equal(opts.mode, 0o600); fs.symlinkSync(victim, path);
    }
    return original(path, data, opts);
  };
  hook("writeFileSync", intercept, () => assert.throws(() => appendWakeQueue(file, { type: "message" }, 1), /EEXIST/));
  await hookAsync("writeFileSync", intercept, () => assert.rejects(register(join(dir, "profile")), /EEXIST/));
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["queue", "victim"]);
});

test("119: single-line rotation remains bounded and keeps a private regular queue", () => {
  const file = join(root(), "queue");
  for (let i = 0; i < 4; i++) appendWakeQueue(file, { type: "message", message_id: String(i) }, 1);
  assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse), [{ type: "message", message_id: "3" }]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});


test("119: macOS allows only the three canonical system symlinks", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    for (const dir of ["/var", "/tmp", "/etc"]) {
      const stat = path => ({ isSymbolicLink: () => path === dir, isDirectory: () => path !== dir });
      hook("lstatSync", (_, path) => stat(path), () => {
        hook("realpathSync", (_, path) => `/private${path}`, () => {
          assert.doesNotThrow(() => config.assertSafeParentDirectories(`${dir}/nested/file`));
        });
        hook("realpathSync", () => "/attacker", () => {
          assert.throws(() => config.assertSafeParentDirectories(`${dir}/nested/file`), /symlink/);
        });
      });
    }
  } finally { Object.defineProperty(process, "platform", platform); }
});
