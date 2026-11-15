import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const codexDir = fileURLToPath(new URL("../codex/", import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-run-hardening-")); roots.push(root);
  const stateDir = join(root, "state"); mkdirSync(stateDir);
  const config = { cwd: root, profileFile: "fixture", source: "test", stateDir, agentId: "fixture",
    token: "ac_fixture_12345678901234567890", apiUrl: "https://test.invalid", wsUrl: "wss://test.invalid",
    permissions: "read-only", codexBin: "unused", channels: [], senders: [], codexHomeMode: "isolated" };
  const events = join(root, "events.jsonl");
  function run(args: string[], options: { channels?: unknown; failure?: string; history?: unknown; token?: string; ipc?: unknown; state?: unknown; beforeSpawn?: () => void } = {}) {
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(Object.hasOwn(options, "state") ? options.state : { channels: Object.hasOwn(options, "channels") ? options.channels : {} }));
    // Each CLI gets its own process: mocks never affect the bridge suites or a real Codex home.
    const harness = join(root, "harness.ts");
    writeFileSync(harness, `
      import { mock } from "bun:test";
      import { appendFileSync } from "node:fs";
      const event = value => appendFileSync(${JSON.stringify(events)}, JSON.stringify(value) + "\\n");
      const config = ${JSON.stringify({ ...config, ...(options.token === undefined ? {} : { token: options.token }) })};
      const configModule = await import(${JSON.stringify(join(codexDir, "config.ts"))});
      mock.module(${JSON.stringify(join(codexDir, "config.ts"))}, () => ({...configModule, resolveConfig: () => config}));
      mock.module(${JSON.stringify(join(codexDir, "runtime-home.ts"))}, () => ({ prepareRuntimeHome: () => ({home:${JSON.stringify(stateDir)}}) }));
      class AppServer {
        async start() { event("start"); }
        close() { event("close"); }
        async readThread() { event("read"); ${options.failure === "read" ? 'throw Error("history unavailable");' : `return ${JSON.stringify(options.history ?? { text: "history fixture" })};`} }
        async readLegacyThread() { return this.readThread(); }
        async authenticationStatus() { event("auth"); ${options.failure === "auth" ? 'throw Error("authentication unavailable");' : 'return "unknown";'} }
      }
      mock.module(${JSON.stringify(join(codexDir, "app-server.ts"))}, () => ({ AppServer, ThreadBusyError: class extends Error {} }));
      const report = console.error;
      console.error = (...args) => {event("error");report(...args);};
      ${Object.hasOwn(options, "ipc") ? `
        Object.defineProperty(process, "connected", {value:true, configurable:true});
        const originalTimeout = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms, ...args) => {
          const timer = originalTimeout(fn, ms, ...args);
          if (ms === 10000) {
            const unref = timer.unref.bind(timer);
            timer.unref = () => {event("unref");return unref();};
            queueMicrotask(() => process.emit("message", JSON.parse(${JSON.stringify(JSON.stringify(options.ipc))})));
          }
          return timer;
        };
      ` : ""}
      process.argv = [process.execPath, ${JSON.stringify(join(codexDir, "run.ts"))}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(join(codexDir, "run.ts"))});
    `);
    rmSync(events, { force: true });
    options.beforeSpawn?.();
    const child = spawnSync(process.execPath, [harness], { env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 5000 });
    expect(child.error).toBeUndefined();
    return { status: child.status, stdout: child.stdout, stderr: child.stderr,
      events: existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").map(s => JSON.parse(s)) : [] };
  }
  return { root, config, stateDir, run };
}

test("CLI GUI submission rejects links, directories, FIFOs and oversized files before reading", () => {
  const f = fixture(), message = join(f.root, "message.txt"), link = join(f.root, "link");
  writeFileSync(message, "hello"); symlinkSync(message, link);
  for (const file of [link, f.root]) {
    const result = f.run(["--gui-thread", "target", "--gui-message-file", file]);
    expect(result.status).toBe(1); expect(result.stderr).toContain("regular file");
  }
  if (process.platform !== "win32") {
    const fifo = join(f.root, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const result = f.run(["--gui-thread", "target", "--gui-message-file", fifo]);
    expect(result.status).toBe(1); expect(result.stderr).toContain("regular file");
  }
  writeFileSync(message, "x".repeat(256 * 1024 + 1));
  expect(f.run(["--gui-thread", "target", "--gui-message-file", message]).stderr).toContain("256 KiB");
  writeFileSync(message, "x".repeat(256 * 1024));
  expect(f.run(["--gui-thread", "target", "--gui-message-file", message]).stderr).toContain("24000");
  writeFileSync(message, "hello");
  const result = f.run(["--gui-thread", "target", "--gui-message-file", message]);
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout).status).toBe("pending");
  expect(result.stdout).not.toContain("hello");
});

test("CLI requires an own conversation key and an object channels map before backend startup", () => {
  const f = fixture();
  for (const key of ["constructor", "__proto__", "toString"]) {
    const result = f.run(["--read-conversation", key]);
    expect(result.status).toBe(1); expect(result.stderr).toContain("Unknown conversation");
    expect(result.events).not.toContain("start");
  }
  for (const channels of [null, [], "bad", 5, true]) {
    for (const args of [["--conversations"], ["--read-conversation", "0"]]) {
      const result = f.run(args, { channels });
      expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid conversation channels");
      expect(result.events).not.toContain("start");
    }
  }
  const own = f.run(["--read-conversation", "constructor"], { channels: { constructor: { thread: "t" } } });
  expect(own.status).toBe(0); expect(own.events).toEqual(["start", "read", "close"]);
  const list = f.run(["--conversations"], { channels: { room: { thread: "t", namespace: f.stateDir } } });
  expect(list.status).toBe(0); expect(JSON.parse(list.stdout.trim().split("\n").at(-1)!)).toEqual([{ channel: "room", thread: "t", isolated: true }]);
  expect(list.events).toEqual([]);
});

test("CLI reads redact exact and generic credentials and preserve history with an empty selected token", () => {
  const f = fixture(), other = "ac_other_12345678901234567890", jwt = `eyJ${"a".repeat(25)}.abc.def`;
  for (const token of [f.config.token, ""]) {
    const result = f.run(["--read-conversation", "room"], { channels: { room: { thread: "t" } }, token,
      history: { text: `plain history ${f.config.token} ${other} ${jwt}` } });
    expect(result.status).toBe(0); expect(result.stdout).toContain("plain history");
    for (const secret of [f.config.token, other, jwt]) expect(result.stdout).not.toContain(secret);
    expect(result.events).toEqual(["start", "read", "close"]);
    const list = f.run(["--conversations"], { token, channels: { [other]: { thread: `${f.config.token} ${jwt}` } } });
    expect(list.status).toBe(0);
    for (const secret of [f.config.token, other, jwt]) expect(list.stdout).not.toContain(secret);
  }
});

test("CLI closes initialized backend in finally before reporting read and check failures", () => {
  const f = fixture();
  const read = f.run(["--read-conversation", "room"], { channels: { room: { thread: "t" } }, failure: "read" });
  expect(read.status).toBe(1); expect(read.events).toEqual(["start", "read", "close", "error", "close"]);
  const check = f.run(["--check"], { failure: "auth" });
  expect(check.status).toBe(1); expect(check.events).toEqual(["start", "auth", "close", "error", "close"]);
  const success = f.run(["--check"]);
  expect(success.status).toBe(0); expect(success.events).toEqual(["start", "auth", "close"]);
});

test("CLI diagnostics scrub API keys and JWTs and suppress credential-labelled errors", () => {
  const f = fixture(), apiKey = "ac_diagnostic_12345678901234567890", jwt = `eyJ${"a".repeat(25)}.abc.def`;
  for (const value of [apiKey, jwt, "Bearer-private", "PASSWORD-private", "api-key-private"]) {
    const result = f.run([`--${value}`]);
    expect(result.status).toBe(1); expect(result.stderr).not.toContain(value);
    expect(result.stderr).toContain("Bridge startup failed");
  }
  expect(f.run(["--unknown-option"]).stderr).toContain("unknown-option");
});

test("managed CLI rejects non-object or empty IPC configs and unreferences its wait timer", () => {
  const f = fixture();
  for (const ipc of [null, [], "bad", 42, {}, true]) {
    const result = f.run(["--managed-worker", "--conversations"], { ipc });
    expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid parent configuration");
    expect(result.events).toEqual(["unref", "error"]);
  }
  const result = f.run(["--managed-worker", "--conversations"], { ipc: f.config });
  expect(result.status).toBe(0); expect(result.events).toEqual(["unref"]);
});


test("conversation CLI rejects unsafe state paths and bounds state files before backend startup", () => {
  for (const args of [["--conversations"], ["--read-conversation", "room"]]) {
    for (const kind of ["directory-link", "file-link", "directory", "fifo", "oversized"]) {
      if (kind === "fifo" && process.platform === "win32") continue;
      const f = fixture(), stateFile = join(f.stateDir, "state.json");
      const result = f.run(args, { beforeSpawn() {
        if (kind === "directory-link") {
          const moved = join(f.root, "moved"); mkdirSync(moved);
          writeFileSync(join(moved, "state.json"), '{"channels":{}}');
          rmSync(f.stateDir, { recursive: true }); symlinkSync(moved, f.stateDir);
        } else if (kind === "oversized") writeFileSync(stateFile, " ".repeat(16 * 1024 * 1024 + 1));
        else {
          rmSync(stateFile);
          if (kind === "directory") mkdirSync(stateFile);
          else if (kind === "fifo") expect(spawnSync("mkfifo", [stateFile]).status).toBe(0);
          else { const target = join(f.root, "target.json"); writeFileSync(target, '{"channels":{}}'); symlinkSync(target, stateFile); }
        }
      }});
      expect(result.status).toBe(1); expect(result.events).not.toContain("start");
      expect(result.stderr).toContain(kind === "directory-link" ? "real directory" : "Unsafe conversation state file");
    }
  }
  const f = fixture();
  const raw = '{"channels":{}}';
  expect(f.run(["--conversations"], { beforeSpawn() {
    writeFileSync(join(f.stateDir, "state.json"), raw + " ".repeat(16 * 1024 * 1024 - raw.length));
  }}).status).toBe(0);
});

test("conversation CLI rejects non-object state and own prototype keys", () => {
  const f = fixture();
  for (const state of [null, [], 42, true, "bad", JSON.parse('{"channels":{},"__proto__":{}}')]) {
    for (const args of [["--conversations"], ["--read-conversation", "room"]]) {
      const result = f.run(args, { state });
      expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid conversation state");
      expect(result.events).not.toContain("start");
    }
  }
});

test("managed CLI validates required IPC strings and rejects own prototype fields", () => {
  const f = fixture();
  const invalid: unknown[] = [JSON.parse(JSON.stringify(f.config).replace(/}$/, ',"__proto__":{}}'))];
  for (const field of ["cwd", "stateDir", "agentId", "token", "apiUrl", "wsUrl"]) {
    for (const value of [undefined, null, false, 1, {}, [], ...(field === "apiUrl" || field === "wsUrl" ? [] : [""])]) {
      invalid.push({ ...f.config, [field]: value });
    }
  }
  for (const ipc of invalid) {
    const result = f.run(["--managed-worker", "--conversations"], { ipc });
    expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid parent configuration");
    expect(result.events).toEqual(["unref", "error"]);
    expect(result.stderr).not.toContain(f.config.token);
  }
  expect(f.run(["--managed-worker", "--conversations"], { ipc: { ...f.config, apiUrl: "", wsUrl: "" } }).status).toBe(0);
});

test("GUI CLI rejects unsafe parent directories before creating the outbox", () => {
  for (const kind of ["link", "dangling", "file"]) {
    const f = fixture(), parent = join(f.root, ".agentschat"), outside = join(f.root, "outside");
    mkdirSync(outside);
    if (kind === "file") writeFileSync(parent, "untouched");
    else symlinkSync(kind === "link" ? outside : join(f.root, "missing"), parent);
    for (const args of [["--gui-status"], ["--gui-thread", "target"], ["--gui-message-file", "unused"]]) {
      const result = f.run(args);
      expect(result.status).toBe(1); expect(result.stderr).toContain("GUI parent must be a real directory");
      expect(existsSync(join(outside, "codex-gui-outbox"))).toBe(false);
      expect(existsSync(join(f.root, "missing"))).toBe(false);
    }
  }
});

test("conversation listing rejects own prototype channels before backend startup", () => {
  const f = fixture();
  for (const args of [["--conversations"], ["--read-conversation", "valid"]]) {
    const result = f.run(args, { channels: JSON.parse('{"valid":{"thread":"thread"},"__proto__":{}}') });
    expect(result.status).toBe(1); expect(result.stderr).toContain("Invalid conversation channels");
    expect(result.events).not.toContain("start"); expect(result.events).not.toContain("read");
  }
});

test("conversation reads reject ancestor links before reading state or starting backend", () => {
  const f = fixture(), moved = join(f.root, "moved");
  const result = f.run(["--conversations"], { beforeSpawn() {
    mkdirSync(moved); mkdirSync(join(moved, "state"));
    writeFileSync(join(moved, "state/state.json"), '{"channels":{"private-marker":{"thread":"secret"}}}');
    // stateDir itself stays a directory; its parent is the alias.
    f.config.stateDir = join(f.root, "alias/state");
    const harness = join(f.root, "harness.ts");
    writeFileSync(harness, readFileSync(harness, "utf8").replace(JSON.stringify(f.stateDir), JSON.stringify(f.config.stateDir)));
    symlinkSync(moved, join(f.root, "alias"));
  } });
  expect(result.status).toBe(1); expect(result.stderr).toContain("symlink");
  expect(result.stdout).not.toContain("private-marker"); expect(result.events).not.toContain("start");
});

test("GUI message reads reject ancestor links before reading or enqueuing", () => {
  const f = fixture(), source = join(f.root, "source"), alias = join(f.root, "alias");
  mkdirSync(source); writeFileSync(join(source, "message"), "private-message"); symlinkSync(source, alias);
  const result = f.run(["--gui-thread", "target", "--gui-message-file", join(alias, "message")]);
  expect(result.status).toBe(1); expect(result.stderr).toContain("symlink");
  expect(result.stdout).not.toContain("private-message");
  expect(new (require("../codex/gui-channel.ts").GuiChannel)(join(f.root, ".agentschat/codex-gui-outbox"), []).list()).toEqual([]);
});
