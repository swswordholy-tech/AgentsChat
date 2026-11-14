/** Migration must retain original evidence, chronological chat and private file permissions. */
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { preserveChannelHistory, priorChannelThreads } from "../codex/thread-history.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function directory() { const root=mkdtempSync(join(tmpdir(),"channel-history-")); roots.push(root); return root; }
const user = (id: string, content: string, channel="group") => ({type:"userMessage",content:[{type:"text",text:"AgentsChat message:\n"+JSON.stringify({id,channel_id:channel,sender_id:"member",content})}]});
const assistant = (text: string) => ({type:"agentMessage",phase:"final_answer",text});

test("legacy lookup selects every lane for the exact channel, once", () => {
  expect(priorChannelThreads({group:"first", '["group","read-only","chat"]':"second", '["group",null,"owner"]':"first", '["other","full-access","owner"]':"private"}, "group")).toEqual(["first","second"]);
});
test("merge orders interleaved turns, deduplicates messages and retains full private tool evidence", () => {
  const root=directory();
  const prompt=preserveChannelHistory(root,"group",[
    {id:"owner-lane",turns:[{id:"003",items:[user("m3","third"),assistant("third answer")]}]},
    {id:"chat-lane",turns:[{id:"001",items:[user("m1","first"),{type:"commandExecution",output:"secret-tool-evidence"},assistant("first answer")]},{id:"002",items:[user("m2","second"),assistant("second answer")]},{id:"004",items:[user("m1","first"),user("other","private-chat","dm-other")]}]},
  ], s=>s.replaceAll("secret", "[REDACTED]"));
  expect(prompt.indexOf('"content":"first"')).toBeLessThan(prompt.indexOf('"content":"second"'));
  expect(prompt.indexOf('"content":"second"')).toBeLessThan(prompt.indexOf('"content":"third"'));
  expect(prompt.split('"id":"m1"').length).toBe(2);
  expect(prompt).not.toContain("private-chat");
  const archive=join(root,"history",readdirSync(join(root,"history"))[0]!);
  const saved=JSON.parse(readFileSync(archive,"utf8"));
  expect(saved.threads[1].turns[0].items[1].output).toBe("[REDACTED]-tool-evidence");
  expect(saved.threads.map((t: any)=>t.id)).toEqual(["owner-lane","chat-lane"]);
  expect(statSync(archive).mode & 0o777).toBe(0o600);
  expect(statSync(join(root,"history")).mode & 0o777).toBe(0o700);
});
test("long history has a bounded recent preview and a complete recoverable export", () => {
  const root=directory();
  const turns=Array.from({length:100},(_,i)=>({id:String(i).padStart(3,"0"),items:[user("m"+i,"x".repeat(1000))]}));
  const prompt=preserveChannelHistory(root,"group",[{id:"old",turns}],s=>s);
  expect(prompt.length).toBeLessThan(61000);
  expect(prompt).toContain('"id":"m99"');
  expect(prompt).not.toContain('"id":"m0"');
  expect(prompt).toContain("Earlier context remains in that file");
  const file=join(root,"history",readdirSync(join(root,"history"))[0]!);
  expect(JSON.parse(readFileSync(file,"utf8")).threads[0].turns).toHaveLength(100);
});

test("older plain-text envelopes and scheduled prompts remain in the imported context", () => {
  const prompt=preserveChannelHistory(directory(),"group",[{id:"legacy",turns:[{id:"001",items:[{type:"userMessage",content:[{type:"text",text:"Older bridge request: continue the agreed work"}]}]},{id:"002",items:[{type:"userMessage",content:[{type:"text",text:"Authorized task: report project progress"}]}]}]}],s=>s);
  expect(prompt).toContain("continue the agreed work");
  expect(prompt).toContain("report project progress");
});

test("repeated migration does not let nested bootstrap or a huge message erase recent chat",()=>{
 const root=directory();const old={id:"old",turns:[{id:"001",items:[user("actual","remember this agreement")]}]};
 const bootstrap="Previous conversations for this channel have been consolidated.\n"+"old preview".repeat(10000)+"\nEnd of historical context.\nLocal operator maintenance: migration completed";
 const current={id:"current",turns:[{id:"002",items:[{type:"userMessage",content:[{type:"text",text:bootstrap}]}]},{id:"003",items:[user("huge","x".repeat(70000))]}]};
 const prompt=preserveChannelHistory(root,"group",[old,current],s=>s);
 expect(prompt).toContain("remember this agreement");expect(prompt).toContain("migration completed");expect(prompt).not.toContain("old preview");expect(prompt).toContain('"truncated":true');expect(prompt.length).toBeLessThan(20000);
 const file=join(root,"history",readdirSync(join(root,"history"))[0]!);expect(readFileSync(file,"utf8")).toContain("old preview");
});


test("history rejects directory symlinks before recursive mkdir can create outside history", () => {
  for (const linkRoot of [false, true]) {
    const base = directory();
    const outside = join(base, "outside"); mkdirSync(outside);
    const state = join(base, "state");
    if (linkRoot) { mkdirSync(state); symlinkSync(outside, join(state, "history"), "dir"); }
    else symlinkSync(outside, state, "dir");
    expect(() => preserveChannelHistory(state, "group", [], s => s)).toThrow("non-symlink directory");
    expect(readdirSync(outside)).toEqual([]);
  }
  const base = directory();
  const state = join(base, "state"); writeFileSync(state, "ordinary file");
  expect(() => preserveChannelHistory(state, "group", [], s => s)).toThrow("non-symlink directory");
});

test("history rechecks archive symlinks introduced during serialization and removes the temporary file", () => {
  const root = directory();
  preserveChannelHistory(root, "group", [], s => s);
  const hist = join(root, "history");
  const archive = join(hist, readdirSync(hist)[0]!);
  const outside = join(root, "outside"); writeFileSync(outside, "unchanged");
  expect(() => preserveChannelHistory(root, "group", [], s => {
    rmSync(archive); symlinkSync(outside, archive); return s;
  })).toThrow("symlink");
  expect(readFileSync(outside, "utf8")).toBe("unchanged");
  expect(readdirSync(hist)).toEqual([basename(archive)]);
});

test("embedded message prototype keys are stripped from imported records without losing ordinary fields", () => {
  const root = directory();
  const text = 'AgentsChat message:\n{"id":"safe","channel_id":"group","content":"kept","__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}';
  const prompt = preserveChannelHistory(root, "group", [{id:"thread", turns:[{id:"001",items:[{type:"userMessage",content:[{type:"text",text}]}]}]}], s => s);
  const line = prompt.split("\n").find(line => line.startsWith('{"id":"safe"'))!;
  expect(JSON.parse(line)).toEqual({id:"safe",channel_id:"group",content:"kept",role:"user"});
  expect(({} as any).polluted).toBeUndefined();
});
