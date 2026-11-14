import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, symlinkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redact } from "../src/config.ts";
import { arg, registerOnly } from "../src/cli.ts";

test("redact never leaks a token", () => {
  assert.equal(redact("ac_1234567890"), "ac****90");
  assert.equal(redact(undefined), "(missing)");
  assert.ok(!redact("ac_1234567890").includes("123456"));
});

test("env wins over profile file, and missing identity throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-agentchat-"));
  const profile = join(dir, "muse.json");
  writeFileSync(profile, JSON.stringify({ agentId: "profile-bot", token: "profile-token" }));
  const cfg = loadConfig({ AGENTCHAT_AGENT_ID: "env-bot", AGENTCHAT_TOKEN: "env-token" }, profile);
  assert.equal(cfg.agentId, "env-bot");
  assert.equal(cfg.wsUrl, "wss://agents-chat.com/ws");
  const fromProfile = loadConfig({}, profile);
  assert.equal(fromProfile.agentId, "profile-bot");
  assert.throws(() => loadConfig({}, join(dir, "missing.json")), /Missing AgentsChat identity/);
});

test("Campaign #97: loadConfig ignores symlinked profiles, rejects whitespace credentials, and blocks remote plaintext/credentialed URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-cfg97-"));
  const realProfile = join(dir, "real.json");
  const symProfile = join(dir, "sym.json");
  writeFileSync(realProfile, JSON.stringify({ agentId: "sym-bot", token: "sym-token" }));
  symlinkSync(realProfile, symProfile);

  assert.throws(() => loadConfig({}, symProfile), /Missing AgentsChat identity/);
  assert.throws(
    () => loadConfig({ AGENTCHAT_AGENT_ID: "   ", AGENTCHAT_TOKEN: "tok" }, join(dir, "none.json")),
    /Missing AgentsChat identity/,
  );
  assert.throws(
    () => loadConfig({ AGENTCHAT_AGENT_ID: "b", AGENTCHAT_TOKEN: "t", AGENTCHAT_WS_URL: "ws://agents-chat.com/ws" }),
    /Remote Muse ws URL must use wss/,
  );
  assert.throws(
    () => loadConfig({ AGENTCHAT_AGENT_ID: "b", AGENTCHAT_TOKEN: "t", AGENTCHAT_REST_URL: "https://u:p@agents-chat.com" }),
    /Embedded credentials/,
  );
  const localOk = loadConfig({
    AGENTCHAT_AGENT_ID: " b ",
    AGENTCHAT_TOKEN: " t ",
    AGENTCHAT_WS_URL: "ws://127.0.0.1:8080/ws",
    AGENTCHAT_REST_URL: "http://localhost:8080",
  });
  assert.equal(localOk.agentId, "b");
  assert.equal(localOk.token, "t");
});

test("Campaign #109 KR4: cli arg() ignores adjacent flags and registerOnly() rejects dangling symlinks, prototype agentIds, and control-char credentials", async () => {
  assert.equal(arg("--name", ["--register-only", "--name", "--wake"]), undefined);
  assert.equal(arg("--name", ["--register-only", "--name", "muse-bot"]), "muse-bot");

  const dir = mkdtempSync(join(tmpdir(), "muse-cli109-"));
  const victim = join(dir, "victim.json");
  const danglingProfile = join(dir, "dangling-muse.json");
  symlinkSync(victim, danglingProfile);

  let networkCalled = false;
  await assert.rejects(
    () =>
      registerOnly("muse-bot", "http://127.0.0.1:8080", danglingProfile, async () => {
        networkCalled = true;
        return new Response(JSON.stringify({ agentId: "bot-1", token: "ac_ok" }), { status: 200 });
      }),
    /symlink/,
  );
  assert.equal(networkCalled, false);

  const cleanProfile = join(dir, "clean-muse.json");
  await assert.rejects(
    () =>
      registerOnly("muse-bot", "http://127.0.0.1:8080", cleanProfile, async () => {
        return new Response(JSON.stringify({ agentId: "constructor", token: "ac_ok" }), { status: 200 });
      }),
    /unsafe agent id or token/,
  );
  await assert.rejects(
    () =>
      registerOnly("muse-bot", "http://127.0.0.1:8080", cleanProfile, async () => {
        return new Response(JSON.stringify({ agentId: "bot-1", token: "ac_bad\ntok" }), { status: 200 });
      }),
    /unsafe agent id or token/,
  );

  await registerOnly("muse-bot", "http://127.0.0.1:8080", cleanProfile, async () => {
    return new Response(JSON.stringify({ agentId: "bot-109", token: "ac_clean_109" }), { status: 200 });
  });
  const saved = JSON.parse(readFileSync(cleanProfile, "utf8"));
  assert.deepEqual(saved, { agentId: "bot-109", token: "ac_clean_109" });
  if (process.platform !== "win32") {
    assert.equal(statSync(cleanProfile).mode & 0o777, 0o600);
  }
});
