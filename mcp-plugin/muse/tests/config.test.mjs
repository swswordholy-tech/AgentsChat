import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, redact } from "../src/config.ts";

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
