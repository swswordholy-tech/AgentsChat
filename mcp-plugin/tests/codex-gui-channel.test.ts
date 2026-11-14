import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, readdirSync, lstatSync, utimesSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiChannel } from "../codex/gui-channel.ts";

test("GUI delivery requires exact user message in selected thread, not enqueue or tool ACK", async () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-channel-"));
 try {
  const q=new GuiChannel(dir,["target"]); let sends=0;
  expect(()=>q.enqueue("other","hi")).toThrow("not allowed");
  const e=q.enqueue("target","hello"); expect(e.status).toBe("pending");
  const history=(type:string,text:string,thread="target")=>({thread:{id:thread},turns:[{id:"turn",items:[{type,content:[{type:"text",text}]}]}]});
  const call=async(name:string)=>name==="send_message_to_thread" ? (++sends,{ok:true}) : history("agentMessage",e.prompt);
  expect((await q.dispatch(e.id,call)).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt,"wrong"))).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt+"suffix"))).status).toBe("submitted");
  expect((await q.dispatch(e.id,async()=>history("userMessage",e.prompt))).status).toBe("delivered");
  expect(sends).toBe(1);
  expect((await q.dispatch(e.id,async()=>{throw Error("should not call");})).turnId).toBe("turn");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("GUI outbox rejects directory links and isolates corrupt, special and linked receipts", () => {
 const root=mkdtempSync(join(tmpdir(),"gui-files-"));
 try {
  const dir=join(root,"outbox"); mkdirSync(dir);
  const alias=join(root,"alias"); symlinkSync(dir,alias,"dir");
  expect(()=>new GuiChannel(alias,["target"])).toThrow("symlink");
  const q=new GuiChannel(dir,["target"]), good=q.enqueue("target","hello");
  expect(lstatSync(join(dir,`${good.id}.json`)).mode & 0o777).toBe(0o600);
  for (const value of ["{", "null", "[]", "42", JSON.stringify({...good,id:randomUUID()}), JSON.stringify({...good,status:"fake"}), JSON.stringify({...good,hostId:[]})]) {
   const id=randomUUID(); writeFileSync(join(dir,`${id}.json`),value);
   expect(()=>q.get(id)).toThrow();
  }
  for (const target of [join(root,"missing"),join(dir,`${good.id}.json`)]) {
   const id=randomUUID(); symlinkSync(target,join(dir,`${id}.json`));
   expect(()=>q.get(id)).toThrow("symlink");
  }
  const id=randomUUID(); mkdirSync(join(dir,`${id}.json`));
  expect(()=>q.get(id)).toThrow("regular file");
  expect(q.list()).toEqual([good]);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test("GUI writes reject planted receipt links without clobbering targets", async () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-write-"));
 try {
  const q=new GuiChannel(dir,["target"]);
  for (const dangling of [false,true]) {
   const e=q.enqueue("target","hello"), path=join(dir,`${e.id}.json`), outside=join(dir,`outside-${dangling}`);
   if (!dangling) writeFileSync(outside,"untouched");
   await expect(q.dispatch(e.id,async(name)=>{
    if (name==="send_message_to_thread") {rmSync(path);symlinkSync(outside,path);return {ok:true};}
    throw Error("unexpected read");
   })).rejects.toThrow("symlink");
   expect(lstatSync(path).isSymbolicLink()).toBe(true);
   if (dangling) expect(existsSync(outside)).toBe(false);
   else expect(readFileSync(outside,"utf8")).toBe("untouched");
   expect(existsSync(`${path}.lock`)).toBe(false);
  }
  expect(readdirSync(dir).filter(f=>f.endsWith(".tmp"))).toEqual([]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("GUI failed atomic replacement cleans its exclusive private temporary file", () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-temp-"));
 try {
  const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","hello"), path=join(dir,`${e.id}.json`);
  // Replace the destination during serialization, after its metadata check, to fail rename.
  const changed={...e,toJSON(){rmSync(path);mkdirSync(path);return e;}};
  expect(()=>(q as any).save(changed)).toThrow();
  expect(lstatSync(path).isDirectory()).toBe(true);
  expect(readdirSync(dir).filter(f=>f.endsWith(".tmp"))).toEqual([]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("GUI dispatch preserves fresh locks, recovers stale directory locks and rejects links", async () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-lock-"));
 try {
  const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","hello"), lock=join(dir,`${e.id}.json.lock`);
  const call=async()=>({thread:{id:"target"},turns:[]});
  mkdirSync(lock);writeFileSync(join(lock,"owner"),"active");
  await expect(q.dispatch(e.id,call)).rejects.toThrow();
  expect(readFileSync(join(lock,"owner"),"utf8")).toBe("active");
  const old=new Date(Date.now()-301_000);utimesSync(lock,old,old);
  expect((await q.dispatch(e.id,call)).status).toBe("submitted");
  expect(existsSync(lock)).toBe(false);
  for (const target of [join(dir,"missing"),dir]) {
   symlinkSync(target,lock);await expect(q.dispatch(e.id,call)).rejects.toThrow("symlink");
   expect(lstatSync(lock).isSymbolicLink()).toBe(true);rmSync(lock);
  }
  writeFileSync(lock,"regular lock");utimesSync(lock,old,old);
  await expect(q.dispatch(e.id,call)).rejects.toThrow();
  expect(readFileSync(lock,"utf8")).toBe("regular lock");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("GUI pagination rejects invalid or repeated cursors and still finds a receipt on a later page", async () => {
 const dir=mkdtempSync(join(tmpdir(),"gui-pages-"));
 try {
  for (const next of [undefined,null,"",0,1,true,{},[],"repeat"]) {
   const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","hello"), cursors:unknown[]=[];
   const result=await q.dispatch(e.id,async(name,args)=>{
    if(name==="send_message_to_thread")return {};
    cursors.push(args.cursor);return {thread:{id:"target"},turns:[],page:{nextCursor:next}};
   });
   expect(result.status).toBe("submitted");
   expect(cursors).toEqual(next==="repeat"?[undefined,"repeat"]:[undefined]);
  }
  const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","hello");let reads=0;
  expect((await q.dispatch(e.id,async(name,args)=>{
   if(name==="send_message_to_thread")return {};
   if(++reads===1)return {thread:{id:"target"},turns:[],page:{nextCursor:"p2"}};
   expect(args.cursor).toBe("p2");
   return {thread:{id:"target"},turns:[{id:"turn",items:[{type:"userMessage",content:[{type:"text",text:e.prompt}]}]}]};
  })).status).toBe("delivered");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("ambiguous GUI send survives restart without duplicate; allowlist rechecked", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"gui-channel-"));
 try {
  const q=new GuiChannel(dir,["target"]), e=q.enqueue("target","test");let sends=0;
  const call=async(name:string)=>{if(name==="send_message_to_thread"){sends++;throw Error("timeout");}return {thread:{id:"target"},turns:[]};};
  expect((await q.dispatch(e.id,call)).status).toBe("uncertain");
  expect((await new GuiChannel(dir,["target"]).dispatch(e.id,call)).status).toBe("uncertain");
  expect(sends).toBe(1);
  await expect(new GuiChannel(dir,[]).dispatch(e.id,call)).rejects.toThrow("no longer allowed");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
