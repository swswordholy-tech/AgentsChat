import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectProfileSelector } from "../src/profile-selection.ts";

test("project selector: binding, local profile, absent; malformed declarations fail closed", () => {
  const cwd = mkdtempSync(join(tmpdir(), "profile-selection-"));
  try {
    expect(projectProfileSelector(cwd)).toBeUndefined();
    mkdirSync(join(cwd, ".agentschat"));
    const profile = join(cwd, ".agentschat/profile.json");
    writeFileSync(profile, "{}");
    expect(projectProfileSelector(cwd)).toEqual({ selector: profile, source: "project-profile" });
    const config = join(cwd, ".agentschat/config.json");
    writeFileSync(config, JSON.stringify({ profile: "Chosen" }));
    expect(projectProfileSelector(cwd)).toEqual({ selector: "Chosen", source: "project-config" });
    writeFileSync(config, JSON.stringify({ profile: "./private/bot.json" }));
    expect(projectProfileSelector(cwd)?.selector).toBe(join(cwd, "private/bot.json"));
    writeFileSync(config, JSON.stringify({ profile: "Chosen", agent_id: "expected", api_url: "http://127.0.0.1:9876", ws_url: "ws://127.0.0.1:9876/ws" }));
    expect(projectProfileSelector(cwd)).toEqual({ selector: "Chosen", source: "project-config", agentId: "expected", apiUrl: "http://127.0.0.1:9876", wsUrl: "ws://127.0.0.1:9876/ws" });
    for (const bad of [
      "broken",
      "[]",
      "null",
      '{"profile":""}',
      '{"profile":"Chosen","agent_id":1}',
      '{"profile":"Chosen","api_url":"http://example.com"}',
      '{"profile":"Chosen","api_url":"https://user:secret@example.com"}',
      '{"profile":"../../outside.json"}',
      '{"profile":"~/../../etc/passwd"}',
      '{"profile":"Chosen\\u0000evil"}',
      '{"profile":"Chosen","token":"ac_inline_secret"}',
      '{"profile":"Chosen","agent_key":"ac_inline_secret"}',
      '{"profile":"Chosen","constructor":"evil"}',
      '{"profile":"constructor"}',
      '{"profile":"Chosen","api_url":"http://127.0.0.1:0"}',
    ]) {
      writeFileSync(config, bad);
      expect(() => projectProfileSelector(cwd)).toThrow();
    }
    writeFileSync(config, JSON.stringify({ profile: "Chosen", api_url: "http://localhost.:9876" }));
    expect(projectProfileSelector(cwd)?.apiUrl).toBe("http://localhost.:9876");
    rmSync(config);
    writeFileSync(profile, "x".repeat(1_048_577));
    expect(() => projectProfileSelector(cwd)).toThrow(/non-regular|symlink/i);
    rmSync(profile);
    const outside = join(cwd, "outside.json");
    writeFileSync(outside, '{"profile":"Chosen"}');
    symlinkSync(outside, config);
    expect(() => projectProfileSelector(cwd)).toThrow(/Invalid project \.agentschat\/config\.json|symlink/i);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
