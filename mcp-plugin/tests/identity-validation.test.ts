import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function boot(profile: unknown, args: string[] = [], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "identity-validation-"));
  mkdirSync(join(home, ".agentschat"));
  const file = join(home, ".agentschat", "profile.json");
  if (profile !== undefined) writeFileSync(file, typeof profile === "string" ? profile : JSON.stringify(profile));
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/server.ts"), ...args], {
    env: { PATH: process.env.PATH!, HOME: home, AGENTCHAT_REST_URL: "http://127.0.0.1:1", AGENTCHAT_URL: "ws://127.0.0.1:1", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
  const timer = setTimeout(() => child.kill(), 1500);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  return { out, err, code, file };
}

test("identity help states the paired-token and default-profile contract", async () => {
  const r = await boot(undefined, ["--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("paired");
  expect(r.out).toContain("default profile");
  expect(r.out).not.toContain("default: auto-generated");
});

test("valid explicit pairs recover empty profiles without rewriting them", async () => {
  const r = await boot({}, ["--id=paired-id", "--token=ac_pair"]);
  expect(r.out).toContain('"result"');
  expect(r.err).toContain("MCP server started");
  expect(readFileSync(r.file, "utf8")).toBe("{}");
});

test("malformed JSON degrades default boot to ANONYMOUS with warning and fails closed on explicit --profile without echoing secrets", async () => {
  const defRes = await boot('{"token":"ac_DO_NOT_ECHO", broken');
  expect(defRes.out).toContain('"result"');
  expect(defRes.err).toContain("WARNING:");
  expect(defRes.err).toContain("ANONYMOUS");
  expect(defRes.err).toContain(defRes.file);
  expect(defRes.err).toContain("--profile");
  expect(defRes.err).not.toContain("Profile loaded:");
  expect(defRes.err).not.toContain("ac_DO_NOT_ECHO");

  const expRes = await boot('{"token":"ac_DO_NOT_ECHO", broken', ["--profile", "profile"]);
  expect(expRes.code).toBe(1);
  expect(expRes.out).toBe("");
  expect(expRes.err).toContain(expRes.file);
  expect(expRes.err).toContain("--profile");
  expect(expRes.err).not.toContain("ac_DO_NOT_ECHO");
});

test("malformed CLI options cannot silently select a default identity", async () => {
  for (const args of [["--profile"], ["--profiel", "A"], ["--profile", "--accept-terms"], ["--profile="], ["unexpected"], ["--register=no"], ["--profiel", "--help"]]) {
    const r = await boot({ agent_id: "default", token: "ac_default" }, args);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("--help");
  }
}, 20000);

test("direct credentials require a valid pair and cannot replace missing selected profiles", async () => {
  for (const [args, env] of [
    [["--profile", "missing"], { AGENTCHAT_TOKEN: "ac_supplied" }],
    [[], { AGENTCHAT_AGENT_ID: "a" }],
    [[], { AGENTCHAT_AGENT_ID: "a", AGENTCHAT_TOKEN: "dev-token" }],
    [[], { AGENTCHAT_AGENT_ID: "a", AGENTCHAT_TOKEN: "" }],
  ] as [string[], Record<string, string>][]) {
    const r = await boot(undefined, args, env);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(args.includes("--profile") ? "no profile" : "AGENTCHAT_AGENT_ID");
    expect(r.err).not.toContain("ac_supplied");
  }
});

test("token-only refuses random or implicit default-profile identity", async () => {
  for (const profile of [undefined, { agent_id: "other-account", token: "ac_other" }]) {
    const r = await boot(profile, [], { AGENTCHAT_TOKEN: "ac_supplied" });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("AGENTCHAT_AGENT_ID");
    expect(r.err).not.toContain("ac_supplied");
  }
});

test("invalid profile shapes degrade default boot to ANONYMOUS without 'Profile loaded:' and fail closed on explicit --profile", async () => {
  for (const value of [{}, null, [], { id: "legacy-only", key: "ac_SECRET" }, { agent_id: "a" }, { token: "ac_SECRET" }, { agent_id: "a", token: "" }, { agent_id: "a", token: "ac_SECRET", capabilities: "chat" }]) {
    const defRes = await boot(value);
    expect(defRes.out).toContain('"result"');
    expect(defRes.err).toContain("WARNING:");
    expect(defRes.err).toContain("ANONYMOUS");
    expect(defRes.err).toContain(defRes.file);
    expect(defRes.err).not.toContain("Profile loaded:");
    expect(defRes.err).not.toContain("ac_SECRET");

    const expRes = await boot(value, ["--profile", "profile"]);
    expect(expRes.code).toBe(1);
    expect(expRes.out).toBe("");
    expect(expRes.err).toContain(expRes.file);
    expect(expRes.err).toContain("--profile");
    expect(expRes.err).not.toContain("ac_SECRET");
  }

  // Symlinked profile.json must also be refused (degrades on default, exits 1 on explicit --profile)
  const home = mkdtempSync(join(tmpdir(), "identity-symlink-"));
  mkdirSync(join(home, ".agentschat"));
  writeFileSync(join(home, ".agentschat", "Named.json"), JSON.stringify({ agent_id: "named-bot", token: "ac_SECRET" }));
  symlinkSync("Named.json", join(home, ".agentschat", "profile.json"));
  const childDef = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/server.ts")], {
    env: { PATH: process.env.PATH!, HOME: home, AGENTCHAT_REST_URL: "http://127.0.0.1:1", AGENTCHAT_URL: "ws://127.0.0.1:1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  childDef.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
  const t1 = setTimeout(() => childDef.kill(), 1500);
  const [outDef, errDef] = await Promise.all([new Response(childDef.stdout).text(), new Response(childDef.stderr).text(), childDef.exited]);
  clearTimeout(t1);
  expect(outDef).toContain('"result"');
  expect(errDef).toContain("symlinked");
  expect(errDef).toContain("ANONYMOUS");
  expect(errDef).not.toContain("Profile loaded:");

  const childExp = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/server.ts"), "--profile", "profile"], {
    env: { PATH: process.env.PATH!, HOME: home, AGENTCHAT_REST_URL: "http://127.0.0.1:1", AGENTCHAT_URL: "ws://127.0.0.1:1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const t2 = setTimeout(() => childExp.kill(), 1500);
  const [, errExp, codeExp] = await Promise.all([new Response(childExp.stdout).text(), new Response(childExp.stderr).text(), childExp.exited]);
  clearTimeout(t2);
  expect(codeExp).toBe(1);
  expect(errExp).toContain("symlinked");
}, 30000);
