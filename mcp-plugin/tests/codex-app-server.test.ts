import { expect, test, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AppServer } from "../codex/app-server.ts";

// Real readline/JSON-RPC path over memory pipes; no model process or network.
async function pipedServer() {
  const child: any = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
    kill(this: any, signal: string) { this.signalCode = signal; return true; },
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(String(chunk));
    if (request.method === "initialize") child.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n");
  });
  const spawn = spyOn(childProcess, "spawn").mockReturnValue(child);
  const app = new AppServer();
  try { await app.start(); } finally { spawn.mockRestore(); }
  return { app, child };
}
function activeTurn(app: AppServer) {
  const items = new Map<string, string>();
  const completed = new Promise<string>((resolve, reject) => {
    (app as any).active = { thread: "thread", turn: "turn", items, early: [], resolve, reject };
  });
  void completed.catch(() => {});
  const notify = (method: string, fields: object) => (app as any).receive({ method, params: { threadId: "thread", turnId: "turn", ...fields } });
  return { items, completed, notify };
}
const item = (id: unknown, text: unknown) => ({ type: "agentMessage", id, text });
const done = (items: unknown = []) => ({ turn: { id: "turn", status: "completed", items } });

test("stdout accepts exactly 8 Mi characters including multibyte text", async () => {
  const { app, child } = await pipedServer(); let fatal = 0; app.onFatal = () => fatal++;
  try {
    const response = app.request("boundary", {});
    const body = JSON.stringify({ id: (app as any).nextId, result: "汉" });
    const line = body + " ".repeat(8 * 1024 * 1024 - body.length);
    expect(Buffer.byteLength(line)).toBeGreaterThan(line.length);
    child.stdout.write(line + "\n");
    expect(await response).toBe("汉"); expect(fatal).toBe(0);
  } finally { app.close(); }
});
test("oversized stdout fails before parsing and rejects pending RPC and active turn once", async () => {
  const { app, child } = await pipedServer(); let fatal = 0; app.onFatal = () => fatal++;
  const turn = activeTurn(app);
  const pending = app.request("stalled", {}).then(() => "resolved", (e: Error) => e.message);
  const completion = turn.completed.then(() => "resolved", (e: Error) => e.message);
  try {
    // Invalid JSON distinguishes the size guard from parse failure.
    child.stdout.write("!".repeat(8 * 1024 * 1024 + 1) + "\n");
    expect(await pending).toBe("Oversized app-server response");
    expect(await completion).toBe("Oversized app-server response");
    expect(fatal).toBe(1); expect((app as any).pending.size).toBe(0);
    expect((app as any).active).toBeUndefined(); expect(child.signalCode).toBe("SIGTERM");
  } finally { app.close(); }
});
test.each(["item/completed", "turn/completed"])("%s ignores malformed items and retains final answer filtering", async method => {
  const app = new AppServer(), turn = activeTurn(app);
  const malformed = [null, 1, {}, item(undefined, "bad"), item(null, "bad"), item("", "bad"), item(1, "bad"),
    item("bad", null), item("bad", {}), item("bad", ["text"]), { ...item("analysis", "hidden"), phase: "analysis" },
    { type: "userMessage", id: "user", text: "hidden" }];
  try {
    const records = [...malformed, item("answer", "valid"), { ...item("final", "final"), phase: "final_answer" }];
    if (method === "item/completed") {
      for (const entry of records) turn.notify(method, { item: entry });
      turn.notify("turn/completed", done());
    } else turn.notify(method, done(records));
    expect(await turn.completed).toBe("valid\nfinal");
    expect([...turn.items.keys()]).toEqual(["answer", "final"]);
  } finally { app.close(); }
});
test("notification and completion items share a 512-item limit; existing IDs still update", async () => {
  const app = new AppServer(), turn = activeTurn(app);
  try {
    for (let i = 0; i < 511; i++) turn.notify("item/completed", { item: item(String(i), `text-${i}`) });
    turn.notify("turn/completed", done([item("511", "last"), item("overflow", "must-not-appear"), item("0", "updated")]));
    const output = await turn.completed;
    expect(turn.items.size).toBe(512); expect(turn.items.has("511")).toBe(true);
    expect(turn.items.has("overflow")).toBe(false); expect(turn.items.get("0")).toBe("updated");
    expect(output.split("\n")).toHaveLength(512); expect(output).not.toContain("must-not-appear");
  } finally { app.close(); }
});
test("item notifications stop at 512 and retain updates of recorded items", async () => {
  const app = new AppServer(), turn = activeTurn(app);
  try {
    for (let i = 0; i < 513; i++) turn.notify("item/completed", { item: item(String(i), `text-${i}`) });
    expect(turn.items.size).toBe(512); expect(turn.items.has("512")).toBe(false);
    turn.notify("item/completed", { item: item("511", "replacement") });
    turn.notify("turn/completed", done());
    expect((await turn.completed).endsWith("replacement")).toBe(true);
  } finally { app.close(); }
});
test("malformed completion collections reject empty replies cleanly", async () => {
  for (const items of [null, {}, "text", 42]) {
    const app = new AppServer(), turn = activeTurn(app);
    try {
      turn.notify("turn/completed", done(items));
      await expect(turn.completed).rejects.toThrow("without a final reply");
    } finally { app.close(); }
  }
});
test("read-only MCP overrides skip prototype keys, preserve stdio/http transport, and strip nullable/secret fields", async () => {
  const app = new AppServer(); let params: any;
  (app as any).request = async (method: string, p: any) => {
    if (method === "config/read") {
      return {
        config: {
          mcp_servers: JSON.parse(
            '{"__proto__":{},"constructor":{},"prototype":{},"__PROTO__":{},"Constructor":{},"PROTOTYPE":{},"agentschat":{"command":"/usr/bin/node","args":["cli.mjs"],"env":{"AGENTSCHAT_TOKEN":"secret"},"tool_timeout_sec":null},"dot.http":{"url":"https://mcp.example.invalid/mcp","bearer_token_env_var":"TOKEN_ENV","http_headers":{"Authorization":"Bearer x"}},"toString":{}}',
          ),
        },
      };
    }
    params = p; return { thread: { id: "readonly" } };
  };
  try {
    expect(await app.thread("/tmp", undefined, false, "read-only")).toBe("readonly");
    const mcp = params.config.mcp_servers;
    expect(Object.keys(mcp)).toEqual(["agentschat", "dot.http", "toString"]);
    expect(Object.getPrototypeOf(mcp)).toBe(Object.prototype);
    expect(mcp.agentschat).toEqual({ command: "/usr/bin/node", enabled: false });
    expect(mcp["dot.http"]).toEqual({ url: "https://mcp.example.invalid/mcp", enabled: false });
    expect(mcp.toString).toEqual({ enabled: false });
  } finally { app.close(); }
});
test("config rejection errors surface sanitized transport diagnostics instead of opaque codes", async () => {
  const app = new AppServer("node", [
    "-e",
    `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='config/read')console.log(JSON.stringify({id:m.id,result:{config:{mcp_servers:{}}}}));else if(m.method==='thread/start')console.log(JSON.stringify({id:m.id,error:{code:-32600,message:'failed to load configuration: invalid transport\\nin \`mcp_servers.agentschat\`\\n'}}));});`,
  ], undefined, "read-only");
  try {
    await app.start();
    await expect(app.thread("/tmp")).rejects.toThrow("App-server configuration rejected (thread/start, -32600): failed to load configuration: invalid transport in `mcp_servers.agentschat`");
  } finally { app.close(); }
});
test("thread permission cache retains 1024 entries and evicts oldest on overflow", async () => {
  const app = new AppServer(); let next = 0;
  (app as any).request = async (method: string, p: any) => method === "config/read"
    ? { config: {} } : { thread: { id: p.threadId ?? `t-${next++}` } };
  try {
    for (let i = 0; i < 1024; i++) await app.thread("/tmp");
    const cache = (app as any).threadPermissions;
    expect(cache.size).toBe(1024); expect(cache.has("t-0")).toBe(true);
    await app.thread("/tmp", "t-0"); expect(cache.size).toBe(1024);
    await expect(app.thread("/tmp", "t-1", false, "read-only")).rejects.toThrow("Cannot change permissions");
    expect(await app.thread("/tmp", undefined, false, "read-only")).toBe("t-1024");
    expect(cache.size).toBe(1024); expect(cache.has("t-0")).toBe(false); expect(cache.has("t-1")).toBe(true);
    expect(cache.get("t-1024")).toBe("read-only");
    await expect(app.generate("t-0", "work")).rejects.toThrow("permissions have not been configured");
    await app.thread("/tmp"); expect(cache.size).toBe(1024); expect(cache.has("t-1")).toBe(false);
  } finally { app.close(); }
});
