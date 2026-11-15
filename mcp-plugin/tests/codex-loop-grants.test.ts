/** Perspective: owners scheduling privileged tasks.
 * Invariant: an exact private grant AND live owner/loop verification are required.
 * Goal: reject spoofing, revocation, replay and history crossover.
 * Migration: keep with bridge; stub only external hub/model boundaries.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bridge, addressed, type Generator } from "../codex/bridge.ts";
import { authorizedLoopTick, verifyLoopTick } from "../codex/loop-grants.ts";
import type { BridgeConfig } from "../codex/config.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture(channel = "dm-owner") {
  const stateDir = mkdtempSync(join(tmpdir(), "loop-grant-")); dirs.push(stateDir);
  const c: BridgeConfig = { stateDir, agentId: "bot", cwd: stateDir, permissions: "full-access", token: "test-token", profileFile: "unused", source: "test", apiUrl: "https://example.com", wsUrl: "wss://example.com/ws", channels: [], senders: [], codexBin: "unused" };
  const grant = { loop_id: "loop_one", channel_id: channel, agent_id: "bot", owner_id: "owner", interval_ms: 1800000, prompt: "Review assigned work." };
  const file = join(stateDir, "loop-grants.json");
  const save = (grants = [grant]) => writeFileSync(file, JSON.stringify({ version: 1, grants }), { mode: 0o600 }); save();
  const tick = { id: "tick1", channel_id: channel, sender_id: "bot", content: "UNTRUSTED WIRE CONTENT", meta: { kind: "loop_tick" as const, loop_id: "loop_one", interval_ms: 1800000, next_tick_ms: 2800000, prompt: "Review assigned work." } };
  const row = { ...grant, status: "active", expires_at: null, last_tick_at: 1000000, next_tick_ms: 2800000 };
  return { c, grant, tick, row, file, save };
}
test("self ticks require exact private local grant; slash echoes ignored", () => {
  const { c, tick, save, grant, file } = fixture(); expect(addressed(tick, c)).toBe(true);
  for (const change of [{ sender_id: "stranger" }, { channel_id: "dm-other" }, { meta: { ...tick.meta, prompt: "Run something else" } }, { meta: { ...tick.meta, interval_ms: 60000 } }, { meta: { ...tick.meta, next_tick_ms: 0 } }]) expect(addressed({ ...tick, ...change }, c)).toBe(false);
  c.channels = ["another"]; expect(addressed(tick, c)).toBe(false); c.channels = [];
  c.senders = ["another"]; expect(addressed(tick, c)).toBe(false); c.senders = [];
  save([grant, grant]); expect(addressed(tick, c)).toBe(false);
  save(); chmodSync(file, 0o644); expect(addressed(tick, c)).toBe(false);
  chmodSync(file, 0o600); rmSync(file); expect(addressed(tick, c)).toBe(false);
  const target = join(c.stateDir, "target"); writeFileSync(target, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 }); symlinkSync(target, file); expect(addressed(tick, c)).toBe(false);
  for (const kind of ["slash_input", "loop_status", "slash_response"]) expect(addressed({ ...tick, sender_id: "owner", meta: { kind } }, c)).toBe(false);
});
test("live check rejects owner changes, inactive/mismatched loops, failed lookup and concurrent local revocation", async () => {
  const { c, tick, row, save } = fixture(); expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }))).not.toBeNull();
  for (const owner of [null, "new-owner"]) expect(await verifyLoopTick(tick, c, owner, async () => ({ loops: [row] }))).toBeNull();
  for (const change of [{ status: "cancelled" }, { channel_id: "dm-other" }, { prompt: "Changed" }, { interval_ms: 60000 }, { expires_at: 9999999 }, { mode: "wake" }, { last_tick_at: null }, { next_tick_ms: 4600000 }]) expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [{ ...row, ...change }] }))).toBeNull();
  expect(await verifyLoopTick(tick, c, "owner", async () => { throw Error("offline"); })).toBeNull();
  expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row, row] }))).toBeNull();
  c.permissions = "read-only"; expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }))).toBeNull(); c.permissions = "full-access";
  expect(await verifyLoopTick(tick, c, "owner", async () => { save([]); return { loops: [row] }; })).toBeNull();
});
test("bridge delivers fixed authorized task in the shared DM thread and deduplicates tick across restart", async () => {
  const { c, tick, row } = fixture(); const runs: { thread: string; prompt: string }[] = [], modes: string[] = [], sent: string[] = [];
  const model: Generator = { thread: async (_c, existing, _e, mode) => { modes.push(mode!); return existing ?? `thread-${modes.length}`; }, generate: async (thread, prompt) => { runs.push({ thread, prompt }); return "done"; } };
  let bridge = new Bridge(c, model, async (_ch, text) => { sent.push(text); }, () => {}, undefined, async () => "owner", async () => ({ loops: [row] }));
  try {
    expect(bridge.accept({ id: "owner1", channel_id: "dm-owner", sender_id: "owner", content: "owner message", meta: { kind: "ordinary" } })).toBe(true); await bridge.drain();
    expect(bridge.accept(tick)).toBe(true); expect(bridge.accept({ ...tick, id: "duplicate" })).toBe(false); await bridge.drain();
    expect(sent).toEqual(["done", "done"]); expect(modes).toEqual(["full-access"]);
    expect(runs[0]!.prompt).toContain("owner message"); expect(runs[0]!.prompt).toContain(join(c.stateDir, "loop-grants.json")); expect(runs[0]!.prompt).toContain("preserve other grants"); expect(runs[1]!.prompt).toContain("Review assigned work."); expect(runs[1]!.prompt).not.toContain("UNTRUSTED WIRE CONTENT"); expect(runs[0]!.thread).toBe(runs[1]!.thread);
    await bridge.stop(); bridge = new Bridge(c, model, async () => {}, () => {}, undefined, async () => "owner", async () => ({ loops: [row] }));
    expect(bridge.accept({ ...tick, id: "replay" })).toBe(false);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries.map((e: any) => e.status)).toEqual(["sent", "sent"]);
  } finally { await bridge.stop(); }
});
test("bridge rechecks owner on each tick and blocks revoked work before generation", async () => {
  const { c, tick, row } = fixture(); let calls = 0, owner = "owner";
  const model: Generator = { thread: async () => "t", generate: async () => { calls++; return "done"; } };
  const bridge = new Bridge(c, model, async () => {}, () => {}, undefined, async () => owner, async () => ({ loops: [row] }));
  try {
    bridge.accept(tick); await bridge.drain(); expect(calls).toBe(1);
    owner = "replacement"; row.last_tick_at = 2800000; row.next_tick_ms = 4600000;
    bridge.accept({ ...tick, id: "tick2", meta: { ...tick.meta, next_tick_ms: 4600000 } }); await bridge.drain(); expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(join(c.stateDir, "state.json"), "utf8")).entries[1].status).toBe("blocked");
  } finally { await bridge.stop(); }
});

test("group loop and group mentions resume the same conversation and reply only to that group", async () => {
  const {c,tick,row} = fixture("original-group"); const runs: string[] = [], deliveries: string[] = [];
  const model: Generator = {thread:async(_cwd,existing)=>existing??"group-thread",generate:async(thread,prompt)=>{runs.push(thread); return "group update";}};
  const bridge=new Bridge(c,model,async(channel)=>{deliveries.push(channel);},()=>{},undefined,async()=>"owner",async()=>({loops:[row]}));
  try {
    expect(bridge.accept({id:"group-request",channel_id:"original-group",sender_id:"member",content:"@bot follow this task",mentioned_ids:["bot"]})).toBe(true);
    await bridge.drain(); expect(bridge.accept(tick)).toBe(true); await bridge.drain();
    expect(runs).toEqual(["group-thread","group-thread"]);
    expect(deliveries).toEqual(["original-group","original-group"]);
    expect(addressed({...tick,id:"wrong-channel",channel_id:"dm-owner"},c)).toBe(false);
  } finally {await bridge.stop();}
});


test("grants enforce loop ID syntax and reject controls in every routing identity", () => {
  const { c, grant, tick, save } = fixture();
  for (const loop_id of ["loop_", "loop-one", "LOOP_one", "loop_one/other", "loop_one\n"]) {
    save([{ ...grant, loop_id }]); expect(authorizedLoopTick({ ...tick, meta: { ...tick.meta, loop_id } }, c)).toBeNull();
  }
  for (const loop_id of ["loop_a", "loop_A0_-z"]) {
    save([{ ...grant, loop_id }]); expect(authorizedLoopTick({ ...tick, meta: { ...tick.meta, loop_id } }, c)).not.toBeNull();
  }
  for (const field of ["channel_id", "agent_id", "owner_id"] as const) {
    for (const control of ["\0", "\n", "\r", "\x1f", "\x7f"]) {
      const changed = { ...grant, [field]: grant[field] + control };
      save([changed]);
      const config = { ...c, agentId: changed.agent_id };
      expect(authorizedLoopTick({ ...tick, channel_id: changed.channel_id, sender_id: changed.agent_id }, config)).toBeNull();
    }
  }
});

test("grants bound file bytes and reject linked state directories and non-files", () => {
  const { c, tick, file } = fixture(); const doc = readFileSync(file, "utf8");
  writeFileSync(file, doc + " ".repeat(1_048_576 - Buffer.byteLength(doc)));
  expect(authorizedLoopTick(tick, c)).not.toBeNull();
  writeFileSync(file, " ", { flag: "a" }); expect(authorizedLoopTick(tick, c)).toBeNull();
  writeFileSync(file, doc);
  const link = c.stateDir + "-link"; dirs.push(link); symlinkSync(c.stateDir, link, "dir");
  expect(authorizedLoopTick(tick, { ...c, stateDir: link })).toBeNull();
  rmSync(file); mkdirSync(file); expect(authorizedLoopTick(tick, c)).toBeNull();
});

test("verifyLoopTick forwards platform and UID options on both authorization reads", async () => {
  const { c, tick, row, file } = fixture(); const uid = lstatSync(file).uid;
  chmodSync(file, 0o644);
  expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }), { platform: "win32", getuid: undefined })).not.toBeNull();
  expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }), { platform: "linux", getuid: undefined })).toBeNull();
  chmodSync(file, 0o600); let reads = 0;
  expect(await verifyLoopTick(tick, c, "owner", async () => ({ loops: [row] }), { platform: "linux", getuid: () => ++reads === 1 ? uid : uid + 1 })).toBeNull();
  expect(reads).toBe(2);
  expect(await verifyLoopTick(tick, c, "owner", async () => { chmodSync(file, 0o644); return { loops: [row] }; }, { platform: "linux", getuid: () => uid })).toBeNull();
});

test("grant document and entries reject own prototype keys and cap total grants",()=>{
 const {c,grant,tick,file,save}=fixture();
 for(const doc of [`{"version":1,"grants":[${JSON.stringify(grant)}],"__proto__":{}}`,`{"version":1,"grants":[${JSON.stringify(grant).slice(0,-1)},"__proto__":{}}]}`]) {
  writeFileSync(file,doc);expect(authorizedLoopTick(tick,c)).toBeNull();
 }
 const other=Array.from({length:255},(_,i)=>({...grant,loop_id:`loop_other${i}`}));
 save([grant,...other]);expect(authorizedLoopTick(tick,c)).not.toBeNull();
 save([grant,...other,{...grant,loop_id:"loop_extra"}]);expect(authorizedLoopTick(tick,c)).toBeNull();
});

test("every grant routing ID rejects whitespace, paths, reserved keys and overlength while preserving email/Apple owner_ids",()=>{
 const {c,grant,tick,save}=fixture();
 for(const field of ["loop_id","channel_id","agent_id"] as const) {
  for(const value of [" "+grant[field],grant[field]+" ",".","..","a/b","a\\b","a b","__PrOtO__","CoNsTrUcToR","PrOtOtYpE","a".repeat(129),"loop_"+"a".repeat(124)]) {
   const changed={...grant,[field]:value};save([changed]);
   expect(authorizedLoopTick({...tick,channel_id:changed.channel_id,sender_id:changed.agent_id,meta:{...tick.meta,loop_id:changed.loop_id}},{...c,agentId:changed.agent_id})).toBeNull();
  }
  const value=field==="loop_id"?"loop_"+"a".repeat(123):"a".repeat(128),changed={...grant,[field]:value};save([changed]);
  expect(authorizedLoopTick({...tick,channel_id:changed.channel_id,sender_id:changed.agent_id,meta:{...tick.meta,loop_id:changed.loop_id}},{...c,agentId:changed.agent_id})).not.toBeNull();
 }
 for(const badOwner of [" owner","owner ",".","..","owner..evil","owner/b","owner\\b","owner b","__PrOtO__","CoNsTrUcToR","PrOtOtYpE","a".repeat(255)]) {
  save([{...grant,owner_id:badOwner}]);
  expect(authorizedLoopTick(tick,c)).toBeNull();
 }
 for(const realOwner of ["owner@example.com","apple:001234.abcdef.1234","a".repeat(254)]) {
  save([{...grant,owner_id:realOwner}]);
  expect(authorizedLoopTick(tick,c)?.owner_id).toBe(realOwner);
 }
});

test("live loop response permits 1024 rows and rejects larger arrays before inspecting rows",async()=>{
 const {c,tick,row}=fixture();
 const loops=Array.from({length:1024},(_,i)=>i===0?row:{loop_id:`loop_other${i}`});
 expect(await verifyLoopTick(tick,c,"owner",async()=>({loops}))).not.toBeNull();
 loops.push({loop_id:"extra"});let inspected=false;
 Object.defineProperty(loops,0,{get(){inspected=true;throw Error("must not scan");}});
 expect(await verifyLoopTick(tick,c,"owner",async()=>({loops}))).toBeNull();expect(inspected).toBe(false);
});
