import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { InboxSync } from "../codex/inbox-sync.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { loadBots } from "../codex/bots-config.ts";
import { modelName, reasoningEffort, resolveConfig, type BridgeConfig } from "../codex/config.ts";
import { authorizedLoopTick } from "../codex/loop-grants.ts";
import { getBotOwner } from "../codex/owner.ts";
import { prepareRuntimeHome } from "../codex/runtime-home.ts";
import { preserveChannelHistory, priorChannelThreads } from "../codex/thread-history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test("authorizedLoopTick permits regular grant files on win32 without getuid while enforcing POSIX uid checks", () => {
  const stateDir = tempDir("codex-win32-grants-");
  const config: BridgeConfig = {
    stateDir,
    agentId: "bot-win",
    cwd: stateDir,
    permissions: "full-access",
    token: "ac_fixture",
    profileFile: "unused",
    source: "test",
    apiUrl: "https://agents-chat.com",
    wsUrl: "wss://agents-chat.com/ws",
    channels: [],
    senders: [],
    codexBin: "codex",
  };
  const grant = {
    loop_id: "loop_win",
    channel_id: "dm-owner",
    agent_id: "bot-win",
    owner_id: "owner-1",
    interval_ms: 600_000,
    prompt: "Check status",
  };
  const file = join(stateDir, "loop-grants.json");
  writeFileSync(file, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 });
  const raw = {
    id: "m1",
    channel_id: "dm-owner",
    sender_id: "bot-win",
    meta: {
      kind: "loop_tick" as const,
      loop_id: "loop_win",
      interval_ms: 600_000,
      next_tick_ms: 1_200_000,
      prompt: "Check status",
    },
  };
  expect(authorizedLoopTick(raw, config, { platform: "win32", getuid: undefined })).toEqual(grant);
  expect(authorizedLoopTick(raw, config, { platform: "linux", getuid: undefined })).toBeNull();
  expect(authorizedLoopTick(raw, config, { platform: "linux", getuid: () => (process.getuid?.() ?? 0) + 1 })).toBeNull();
});

test("getBotOwner cancels unconsumed response bodies on partial HTTP failure or peer rejection", async () => {
  for (const failOnboarding of [true, false]) {
    let okCancelled = false;
    let errCancelled = false;
    const makeStreamResponse = (payload: unknown, status: number, onCancel: () => void) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          },
          cancel() {
            onCancel();
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      );

    const request = (async (url: RequestInfo | URL) => {
      const onboarding = String(url).endsWith("/api/account/onboarding");
      if (onboarding === failOnboarding) {
        return makeStreamResponse({ error: "denied" }, 403, () => { errCancelled = true; });
      }
      return makeStreamResponse(
        onboarding ? { agent_id: "bot-1", claimed: true } : { owner_account_id: "owner-1" },
        200,
        () => { okCancelled = true; },
      );
    }) as typeof fetch;

    expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", request)).toBeNull();
    expect(okCancelled).toBe(true);
    expect(errCancelled).toBe(true);
  }

  let survivingCancelled = false;
  const rejectOne = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/api/account/onboarding")) throw new Error("network down");
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"owner_account_id":"owner-1"}'));
        },
        cancel() {
          survivingCancelled = true;
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", rejectOne)).toBeNull();
  expect(survivingCancelled).toBe(true);

  for (const badOwner of [" owner-1 ", "owner\n1", "owner\x001"]) {
    const req = (async (url: RequestInfo | URL) =>
      Response.json(String(url).endsWith("/api/account/onboarding")
        ? { agent_id: "bot-1", claimed: true }
        : { owner_account_id: badOwner })) as typeof fetch;
    expect(await getBotOwner("https://test.invalid", "bot-1", "ac_test", req)).toBeNull();
  }
});

test("bots registry and config reject dot-dot segments, prototype selectors, control characters and directory profiles", () => {
  const home = tempDir("codex-cfg-hardening-");
  const profiles = join(home, ".agentschat/profiles");
  const cwd = join(home, "workspace");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(profiles, "valid.json"), JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });

  const regFile = join(home, "bots.json");
  for (const badName of ["constructor", "prototype", "CONSTRUCTOR", "bot\n1"]) {
    writeFileSync(regFile, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: badName, profile: "valid" }] }));
    expect(() => loadBots(regFile, home)).toThrow();
  }
  for (const badProfile of ["a..b", "valid..", "constructor", "constructor.json", "prototype.json", "__proto__.json"]) {
    writeFileSync(regFile, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: "one", profile: badProfile }] }));
    expect(() => loadBots(regFile, home)).toThrow("central profile");
    expect(() => resolveConfig({ cwd, profile: badProfile }, {}, home)).toThrow();
  }
  for (const ctrl of ["gpt-5\0bad", "gpt-5\nbad"]) {
    expect(() => modelName(ctrl)).toThrow("model");
    expect(() => reasoningEffort(ctrl)).toThrow("effort");
  }
  expect(() => resolveConfig({ cwd, profile: "valid", codexBin: "codex\0bad" }, {}, home)).toThrow("codex_bin");

  const dirProfile = join(home, "dir-profile.json");
  mkdirSync(dirProfile, { mode: 0o700 });
  expect(() => resolveConfig({ cwd, profile: dirProfile }, {}, home)).toThrow("regular file");
});

test("thread history rejects symlink clobbering, ignores prototype keys and tolerates malformed envelopes", () => {
  const map = JSON.parse('{"__proto__":"evil","constructor":"evil","prototype":"evil","chan":"t1","bad":""}');
  expect(priorChannelThreads(map, "chan")).toEqual(["t1"]);
  expect(priorChannelThreads(map, "constructor")).toEqual([]);

  const root = tempDir("codex-history-hardening-");
  const prompt = preserveChannelHistory(root, "chan", [
    {
      id: "h1",
      turns: [
        {
          id: "001",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "AgentsChat message:\nnull" }] },
            { type: "userMessage", content: [{ type: "text", text: "AgentsChat message:\n[1,2,3]" }] },
            { type: "userMessage", content: null },
            { type: "agentMessage", phase: "final_answer", text: "clean reply" },
          ],
        },
      ],
    },
  ], s => s);
  expect(prompt).toContain("clean reply");
  const histDir = join(root, "history");
  expect(readdirSync(histDir).filter(f => f.endsWith(".tmp"))).toEqual([]);

  const outside = join(root, "outside.json");
  writeFileSync(outside, "do-not-overwrite");
  const archiveFile = join(histDir, readdirSync(histDir)[0]!);
  rmSync(archiveFile);
  symlinkSync(outside, archiveFile);
  expect(() => preserveChannelHistory(root, "chan", [], s => s)).toThrow("symlink");
});

test("independent runtime home rejects planted FIFO special files on POSIX", () => {
  if (process.platform === "win32") return;
  const root = tempDir("codex-fifo-home-");
  const runtime = prepareRuntimeHome(join(root, "bot"), join(root, "unused"), "isolated");
  const fifo = join(runtime.home, "planted.pipe");
  const mk = spawnSync("mkfifo", [fifo]);
  if (mk.status !== 0) return;
  expect(() => prepareRuntimeHome(join(root, "bot"), join(root, "unused"), "isolated")).toThrow("regular files");
});

function configFixture() {
  const home = tempDir("codex-config-gates-");
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".agentschat"), { recursive: true });
  mkdirSync(join(cwd, ".codex"));
  const profile = join(home, "valid.json");
  writeFileSync(profile, JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });
  return { home, cwd, profile };
}

test("config rejects linked project directories and linked config/profile files, including dangling links", () => {
  for (const relative of [".agentschat", ".codex", ".agentschat/config.json", ".codex/config.toml", ".agentschat/profile.json", "selected.json"]) {
    for (const dangling of [false, true]) {
      const { home, cwd, profile } = configFixture();
      const path = join(cwd, relative);
      const target = join(home, "outside");
      const isDir = relative === ".agentschat" || relative === ".codex";
      if (!dangling) {
        if (isDir) mkdirSync(target);
        else writeFileSync(target, relative.endsWith("toml") ? "" : '{}', { mode: 0o600 });
      }
      rmSync(path, { recursive: true, force: true });
      symlinkSync(target, path, isDir ? "dir" : "file");
      expect(() => resolveConfig({ cwd, profile: relative === "selected.json" ? path : profile }, {}, home)).toThrow(isDir ? "non-symlink directory" : "regular file");
    }
  }
});

test("config files enforce the exact 1 MiB byte boundary before parsing", () => {
  for (const relative of [".agentschat/config.json", ".codex/config.toml", ".agentschat/profile.json", "selected.json"]) {
    const { home, cwd, profile } = configFixture();
    const path = join(cwd, relative);
    const body = relative.endsWith("toml") ? "# config\n" : relative.endsWith("config.json") ? "{}" : JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" });
    writeFileSync(path, body + " ".repeat(1_048_576 - Buffer.byteLength(body)), { mode: 0o600 });
    const opts = { cwd, profile: relative === "selected.json" ? path : profile };
    expect(resolveConfig(opts, {}, home).agentId).toBe("bot-ok");
    writeFileSync(path, body + " ".repeat(1_048_577 - Buffer.byteLength(body)), { mode: 0o600 });
    expect(() => resolveConfig(opts, {}, home)).toThrow("1 MiB");
  }
});

test("config rejects special files without reading them and rejects own prototype settings", () => {
  const { home, cwd, profile } = configFixture();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const settings = Object.defineProperty({}, key, { value: "bad", enumerable: false });
    expect(() => resolveConfig({ cwd, profile, settings }, {}, home)).toThrow("prototype key");
    writeFileSync(join(cwd, ".agentschat/config.json"), `{ "${key}": "bad" }`);
    expect(() => resolveConfig({ cwd, profile }, {}, home)).toThrow("prototype key");
  }
  rmSync(join(cwd, ".agentschat/config.json"));
  if (process.platform !== "win32") {
    const fifo = join(cwd, "fifo.json");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(() => resolveConfig({ cwd, profile: fifo }, {}, home)).toThrow("regular file");
  }
});

test("config expands Windows tilde paths and accepts canonical loopback aliases while rejecting port zero", () => {
  const { home, cwd } = configFixture();
  const config = resolveConfig({ cwd, profile: "~\\valid.json", stateRoot: "~\\state", settings: { api_url: "http://LOCALHOST.:1234", ws_url: "ws://[::1]:1234/ws" } }, {}, home);
  expect(config.profileFile).toBe(join(home, "valid.json"));
  expect(config.stateDir.startsWith(join(home, "state") + sep)).toBe(true);
  for (const field of ["api_url", "ws_url"]) {
    for (const url of ["http://localhost:0", "https://localhost:0", "ws://[::1]:0/ws", "wss://localhost:0/ws"]) {
      expect(() => resolveConfig({ cwd, profile: "~\\valid.json", settings: { [field]: url } }, {}, home)).toThrow("Server URLs");
    }
  }
});

const metadataHosts = [
  "169.254.169.254", "169.254.0.1", "169.254.255.255", "2852039166", "0xa9fea9fe", "0251.0376.0251.0376",
  "metadata.google.internal", "METADATA.GOOGLE.INTERNAL.", "metadata.goog", "nested.metadata.goog.",
  "[fe80::1]", "[febf:ffff::1]", "[::ffff:169.254.169.254]", "[::ffff:0:169.254.1.2]",
];
test("config and owner reject canonical metadata/link-local hosts before authenticated requests", async () => {
  const { home, cwd, profile } = configFixture();
  let calls = 0;
  const request = (async (url: RequestInfo | URL) => {
    calls++;
    return Response.json(String(url).endsWith("onboarding") ? { agent_id: "bot-ok", claimed: true } : { owner_account_id: "owner-1" });
  }) as typeof fetch;
  for (const host of metadataHosts) {
    for (const field of ["api_url", "ws_url"] as const) {
      const url = `${field === "api_url" ? "https" : "wss"}://${host}`;
      expect(() => resolveConfig({ cwd, profile, settings: { [field]: url } }, {}, home)).toThrow("Server URLs");
    }
    expect(await getBotOwner(`https://${host}`, "bot-ok", "synthetic", request)).toBeNull();
  }
  expect(calls).toBe(0);
  for (const host of ["metadata.goog.example", "notmetadata.goog", "metadata.google.internal.example", "169.253.255.255", "169.255.0.1", "[fe7f::1]", "[fec0::1]", "[::ffff:169.253.1.2]"]) {
    expect(resolveConfig({ cwd, profile, settings: { api_url: `https://${host}` } }, {}, home).apiUrl).toBe(`https://${new URL(`https://${host}`).host}`);
    expect(await getBotOwner(`https://${host}`, "bot-ok", "synthetic", request)).toBe("owner-1");
  }
});

test("owner rejects own prototype JSON and path-like owners on either response", async () => {
  const status = { agent_id: "bot-ok", claimed: true }, entitlement = { owner_account_id: "owner-1" };
  const lookup = (s: unknown, e: unknown) => getBotOwner("https://example.invalid", "bot-ok", "synthetic",
    (async (url: RequestInfo | URL) => Response.json(String(url).endsWith("onboarding") ? s : e)) as typeof fetch);
  for (const value of [".", "..", "a/b", "a\\b"]) expect(await lookup(status, { owner_account_id: value })).toBeNull();
  for (const badStatus of [true, false]) {
    const dirty = JSON.parse('{"__proto__":{}}');
    expect(await lookup(badStatus ? { ...status, ...dirty } : status, badStatus ? entitlement : { ...entitlement, ...dirty })).toBeNull();
  }
  expect(await lookup(status, entitlement)).toBe("owner-1");
});

const sidecarStems = ["grok-binds", "session-binds", "agy-binds", "cursor", "read-cursors", "wake-pids", "config", "codex-bots"];
test("config and registry reject reserved sidecars and preserve mixed-case JSON suffixes", () => {
  const { home, cwd } = configFixture();
  const profiles = join(home, ".agentschat/profiles");
  mkdirSync(profiles, { recursive: true });
  writeFileSync(join(profiles, "Bot.JSON"), JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });
  expect(resolveConfig({ cwd, profile: "Bot.JSON" }, {}, home).profileFile).toBe(join(profiles, "Bot.JSON"));
  const registry = join(home, "bots.json");
  for (const stem of sidecarStems) {
    for (const selector of [stem, `${stem.toUpperCase()}.JSON`]) {
      expect(() => resolveConfig({ cwd, profile: selector }, {}, home)).toThrow("central profile");
      writeFileSync(registry, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: "one", profile: selector }] }));
      expect(() => loadBots(registry, home)).toThrow("central profile");
    }
  }
  writeFileSync(registry, JSON.stringify({ version: 1, default_workdir: cwd, bots: [{ name: "one", profile: "Bot.JSON" }] }));
  expect(loadBots(registry, home)[0]!.agentId).toBe("bot-ok");
});

test("selected profile JSON rejects an own __proto__ key even with valid credentials", () => {
  const { home, cwd, profile } = configFixture();
  writeFileSync(profile, '{"agent_id":"bot-ok","token":"ac_ok_token","__proto__":{}}', { mode: 0o600 });
  expect(() => resolveConfig({ cwd, profile }, {}, home)).toThrow("prototype key");
});

function linkedAncestor() {
  const root = tempDir("codex-ancestor-");
  const target = join(root, "target"), link = join(root, "link");
  mkdirSync(target); symlinkSync(target, link, "dir");
  return { root, target, link };
}
test("config rejects ancestors of explicit, central and project paths", () => {
  const { home, cwd, profile } = configFixture();
  const { target, link } = linkedAncestor();
  mkdirSync(join(target, "nested"));
  writeFileSync(join(target, "nested/profile.json"), JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });
  expect(() => resolveConfig({ cwd, profile: join(link, "nested/profile.json") }, {}, home)).toThrow("non-symlink directory");
  expect(() => resolveConfig({ cwd: join(link, "nested"), profile }, {}, home)).toThrow("non-symlink directory");
  mkdirSync(join(target, ".agentschat/profiles"), { recursive: true });
  writeFileSync(join(target, ".agentschat/profiles/valid.json"), JSON.stringify({ agent_id: "bot-ok", token: "ac_ok_token" }), { mode: 0o600 });
  expect(() => resolveConfig({ cwd, profile: "valid" }, {}, link)).toThrow("non-symlink directory");
});

test("registry rejects file and configured workdir ancestors", () => {
  const { home, cwd } = configFixture();
  const { target, link } = linkedAncestor();
  const registry = join(home, "bots.json");
  mkdirSync(join(target, "work"));
  const doc = { version: 1, default_workdir: cwd, bots: [{ name: "one", profile: "valid" }] };
  writeFileSync(join(target, "bots.json"), JSON.stringify(doc));
  expect(() => loadBots(join(link, "bots.json"), home)).toThrow("non-symlink directory");
  for (const botWorkdir of [true, false]) {
    writeFileSync(registry, JSON.stringify({ ...doc, default_workdir: botWorkdir ? cwd : join(link, "work"),
      bots: [{ ...doc.bots[0], ...(botWorkdir ? { workdir: join(link, "work") } : {}) }] }));
    expect(() => loadBots(registry, home)).toThrow("non-symlink directory");
  }
});

test("default bot workspace rejects an ancestor link before recursive mkdir", () => {
  const { root, target, link } = linkedAncestor();
  const registry = join(root, "bots.json");
  writeFileSync(registry, JSON.stringify({ version: 1, bots: [{ name: "one", profile: "valid" }] }));
  expect(() => loadBots(registry, link)).toThrow("non-symlink directory");
  expect(existsSync(join(target, ".agentschat"))).toBe(false);
});

test("all runtime home modes reject ancestor links before creating state", () => {
  for (const mode of ["isolated", "auth-only", "linked"] as const) {
    const { root, target, link } = linkedAncestor();
    const source = join(root, "desktop"); mkdirSync(source); writeFileSync(join(source, "auth.json"), "{}");
    expect(() => prepareRuntimeHome(join(link, "new/state"), source, mode)).toThrow("non-symlink directory");
    expect(existsSync(join(target, "new"))).toBe(false);
  }
});

test("inbox and thread archives reject ancestor links before creating directories", () => {
  const { target, link } = linkedAncestor();
  expect(() => new InboxSync(join(link, "new/state"), async () => [], () => true, () => true)).toThrow("non-symlink directory");
  expect(() => preserveChannelHistory(join(link, "new/state"), "room", [], s => s)).toThrow("non-symlink directory");
  expect(existsSync(join(target, "new"))).toBe(false);
});

test("inbox refuses prototype state, prototype channels and more than 1024 channel entries", () => {
  const root = tempDir("codex-cursor-prototype-");
  const file = join(root, "inbound-cursors.json");
  const timestamp = "2026-11-14T00:00:00.000Z";
  for (const text of ['{"version":1,"channels":{},"__proto__":{}}', '{"version":1,"channels":{"__proto__":"'+timestamp+'"}}',
    JSON.stringify({ version: 1, channels: Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`room-${i}`, timestamp])) })]) {
    writeFileSync(file, text);
    expect(() => new InboxSync(root, async () => [], () => true, () => true)).toThrow("Invalid inbound cursors");
    expect(readFileSync(file, "utf8")).toBe(text);
  }
  const text = JSON.stringify({ version: 1, channels: Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`room-${i}`, timestamp])) });
  writeFileSync(file, text);
  const sync = new InboxSync(root, async () => [], () => true, () => true);
  sync.watch("room-0"); sync.memberships(["room-0", "room-0"]);
  expect(() => sync.watch("overflow")).toThrow("channel limit");
  expect(() => sync.memberships(["room-0", "overflow"])).toThrow("channel limit");
  expect(readFileSync(file, "utf8")).toBe(text);
});

test("inbox rejects single dot and padded channels on registration and skips them in saved state", () => {
  const root = tempDir("codex-cursor-channel-");
  writeFileSync(join(root, "inbound-cursors.json"), JSON.stringify({ version: 1, channels: { ".": "invalid", " room": "invalid", "room ": "invalid" } }));
  const sync = new InboxSync(root, async () => [], () => true, () => true);
  for (const channel of [".", " room", "room ", "\troom"]) {
    expect(() => sync.watch(channel)).toThrow("Invalid inbound channel");
    expect(() => sync.memberships(["valid", channel])).toThrow("Invalid inbound channel");
  }
  sync.watch("room.name"); sync.watch("dm-owner");
  expect(Object.keys(JSON.parse(readFileSync(join(root, "inbound-cursors.json"), "utf8")).channels)).toEqual(["room.name", "dm-owner"]);
});

test("thread archive requires a regular destination before and after temp write", () => {
  for (const afterWrite of [false, true]) {
    const root = tempDir("codex-history-special-");
    const histDir = join(root, "history"); mkdirSync(histDir);
    const file = join(histDir, createHash("sha256").update("room").digest("hex").slice(0, 24) + ".json");
    if (!afterWrite) mkdirSync(file);
    expect(() => preserveChannelHistory(root, "room", [], s => {
      if (afterWrite) mkdirSync(file);
      return s;
    })).toThrow("regular file");
    expect(readdirSync(histDir)).toEqual([file.split(sep).at(-1)!]);
  }
});

test("thread preview strips every casing of prototype keys while retaining ordinary fields", () => {
  const root = tempDir("codex-history-keys-");
  const message = JSON.parse('{"channel_id":"room","id":"one","content":"hello","__proto__":{},"__PrOtO__":{},"CONSTRUCTOR":"bad","Prototype":"bad"}');
  const histories = [{ id: "h1", turns: [{ id: "001", items: [{ type: "userMessage", content: [{ type: "text", text: "AgentsChat message:\n" + JSON.stringify(message) }] }] }] }];
  const prompt = preserveChannelHistory(root, "room", histories, s => s);
  const line = prompt.split("Past messages in order:\n")[1]!.split("\n")[0]!;
  expect(JSON.parse(line)).toEqual({ channel_id: "room", id: "one", content: "hello", role: "user" });
  expect(Object.hasOwn(message, "__proto__")).toBe(true);
});
