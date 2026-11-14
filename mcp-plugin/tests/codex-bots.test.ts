// Perspective: local bot operator managing several Codex-backed identities.
// Invariant: central identities ignore project settings; one bot survives bad registry edits.
// Goal: detect duplicate accounts and prevent orphan workers or app-server processes.
// Migration: legacy single-bot profiles remain supported; registry mode is explicit.
import { test, expect, spyOn } from "bun:test";
import { realpathSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { removeDeadLock, removeOwnedLock, save, start, stop, type Worker } from "../codex/manager.ts";
import { loadBots } from "../codex/bots-config.ts";
import { reasoningEffort, resolveConfig } from "../codex/config.ts";
import { parseProcesses, externalCodexPresent } from "../codex/processes.ts";
test("watcher excludes descendants and keeps multiple independent sessions active", () => {
 const own = parseProcesses("10 1 /opt/node\n11 10 /opt/node\n12 11 /app/codex");
 expect(externalCodexPresent(own,10)).toBe(false);
 expect(externalCodexPresent([...own,{pid:20,ppid:1,command:"/app/codex"}],10)).toBe(true);
 expect(externalCodexPresent(parseProcesses("20 1 /app/codex\n21 1 /app/codex"),10)).toBe(true);
});
test("central registry ignores project identity; workdir defaults and duplicate accounts validated", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-"));
 try {
  const profiles=join(home,".agentschat/profiles"), cwd=join(home,"project");
  mkdirSync(profiles,{recursive:true}); mkdirSync(join(cwd,".agentschat"),{recursive:true});
  writeFileSync(join(cwd,".agentschat/config.json"),'{"profile":"missing"}');
  writeFileSync(join(profiles,"one.json"),JSON.stringify({agent_id:"test-bot",token:"ac_test_bot_token"}),{mode:0o600});
  const file=join(home,"bots.json");
  const write=(bots:any[],extra:any={})=>writeFileSync(file,JSON.stringify({version:1,default_workdir:cwd,bots,...extra}));
  write([{name:"one",profile:"one"},{name:"disabled",enabled:false}]);
  expect(loadBots(file,home).map(c=>[c.agentId,c.cwd])).toEqual([["test-bot",realpathSync(cwd)]]);
  expect(loadBots(file,home)[0]!.permissions).toBe("full-access");
  expect(loadBots(file,home)[0]!.model).toBeUndefined();
  write([{name:"one",profile:"one",model:" gpt-6.1-sol ",effort:"medium"}]);
  expect(loadBots(file,home)[0]!.model).toBe("gpt-6.1-sol");
  expect(loadBots(file,home)[0]!.effort).toBe("medium");
  for (const model of [null,123,false,[],{},"", "   "]) {
   write([{name:"one",profile:"one",model}]);
   expect(()=>loadBots(file,home)).toThrow("model");
  }
  write([{name:"one",profile:"one",permissions:"read-only"}]);
  expect(loadBots(file,home)[0]!.permissions).toBe("read-only");
  write([{name:"one",profile:"one",state_root:"./bot-state",codex_home_mode:"auth-only"}]);
  const relocated=loadBots(file,home)[0]!;
  expect(relocated.stateDir.startsWith(join(home,"bot-state")+"/")).toBe(true);
  expect(relocated.codexHomeMode).toBe("auth-only");
  write([{name:"one",profile:"one",codex_home_mode:"bad"}]);
  expect(()=>loadBots(file,home)).toThrow("codex_home_mode");
  write([{name:"one",profile:"one",permissions:"typo"}]);
  expect(()=>loadBots(file,home)).toThrow("permissions");
  write([{name:"one",profile:"one"},{name:"two",profile:"one",workdir:home}]);
  expect(()=>loadBots(file,home)).toThrow("Duplicate");
  write([{name:"one",profile:"../one"}]); expect(()=>loadBots(file,home)).toThrow("central profile");
  write([{name:"one",profile:"one"}],{default_workdir:undefined});
  expect(loadBots(file,home)[0]!.cwd).toBe(realpathSync(join(home,".agentschat/workspace")));
  write([{name:"one",profile:"one",enabled:"false"}]); expect(()=>loadBots(file,home)).toThrow("enabled");
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("reasoning effort is optional and independently scoped to each bot", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-effort-"));
 try {
  const profiles=join(home,".agentschat/profiles"), cwd=join(home,"project");
  mkdirSync(profiles,{recursive:true}); mkdirSync(join(cwd,".agentschat"),{recursive:true});
  for (const name of ["one","two"])
   writeFileSync(join(profiles,`${name}.json`),JSON.stringify({agent_id:`test-${name}`,token:`ac_test_${name}_token`}),{mode:0o600});
  writeFileSync(join(cwd,".agentschat/config.json"),JSON.stringify({profile:"one",effort:"high"}));
  const file=join(home,"bots.json");
  const write=(effort:unknown)=>writeFileSync(file,JSON.stringify({version:1,default_workdir:cwd,bots:[{name:"one",profile:"one",effort},{name:"two",profile:"two"}]}));
  write("medium");
  expect(loadBots(file,home).map(bot=>bot.effort)).toEqual(["medium",undefined]);
  expect(resolveConfig({cwd},{},home).effort).toBe("high");
  write(undefined);
  expect(loadBots(file,home).map(bot=>bot.effort)).toEqual([undefined,undefined]);
  for (const invalid of [null,123,false,[],{},"","   "]) {
   write(invalid);
   expect(()=>loadBots(file,home)).toThrow("effort");
  }
  write(" medium ");
  expect(loadBots(file,home)[0]!.effort).toBe("medium");
  expect(reasoningEffort("model-specific-effort")).toBe("model-specific-effort");
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("manager snapshot survives broken registry; parent death cleans workers", async () => {
 const { spawn } = await import("node:child_process");
 const { WebSocketServer } = await import("ws");
 const home=realpathSync(mkdtempSync(join(tmpdir(),"bots-lifecycle-")));
 const profiles=join(home,".agentschat/profiles"); mkdirSync(profiles,{recursive:true});
 const hub = Bun.serve({port:0,fetch:(req)=>new URL(req.url).pathname==="/api/account/onboarding" ? Response.json({agent_id:"test-bot",claimed:true}) : Response.json({channels:[]})});
 const ws = new WebSocketServer({port:0}); await new Promise<void>(r=>ws.once("listening",r));
 ws.on("connection",socket=>socket.on("message",raw=>{if(JSON.parse(String(raw)).type==="auth")socket.send(JSON.stringify({type:"auth_ok"}));}));
 const fake=join(home,"fake-codex");
 writeFileSync(fake,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(join(home,'app.pid'))},String(process.pid));require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)console.log(JSON.stringify({id:m.id,result:{}}));});`,{mode:0o700});
 writeFileSync(join(profiles,"one.json"),JSON.stringify({agent_id:"test-bot",token:"ac_test_bot_token"}),{mode:0o600});
 const file=join(home,"bots.json");
 writeFileSync(file,JSON.stringify({version:1,codex_bin:fake,bots:[{name:"one",profile:"one",api_url:`http://127.0.0.1:${hub.port}`,ws_url:`ws://127.0.0.1:${(ws.address() as any).port}`}]}));
 const manager=spawn("node",[resolve(import.meta.dir,"../src/cli.mjs"),"--codex-bots","--config",file],{env:{...process.env,HOME:home},stdio:"ignore"});
 let worker=0;
 const wait=async(fn:()=>boolean)=>{const end=Date.now()+15000;while(Date.now()<end){if(fn())return;await Bun.sleep(100);}throw Error("lifecycle timeout");};
 const status=()=>{try{return JSON.parse(readFileSync(join(home,".agentschat/codex-bots/status.json"),"utf8")).bots[0];}catch{return {};}};
 const dead=(pid:number)=>{try{process.kill(pid,0);return false;}catch{return true;}};
 try {
  await wait(()=>status().status==="connected"); worker=status().pid; expect(worker).toBeGreaterThan(0);
  const firstApp=Number(readFileSync(join(home,"app.pid"),"utf8"));
  writeFileSync(file,"{"); process.kill(worker,"SIGKILL");
  await wait(()=>status().status==="connected"&&status().pid!==worker); worker=status().pid;
  await wait(()=>dead(firstApp)); expect(dead(firstApp)).toBe(true);
  const secondApp=Number(readFileSync(join(home,"app.pid"),"utf8"));
  expect(status().status).toBe("connected"); manager.kill("SIGKILL");
  await wait(()=>dead(worker)); expect(dead(worker)).toBe(true); await wait(()=>dead(secondApp)); expect(dead(secondApp)).toBe(true);
 } finally {manager.kill("SIGKILL");if(worker&&!dead(worker))process.kill(worker,"SIGKILL"); for(const c of ws.clients)c.terminate();ws.close();hub.stop(true);rmSync(home,{recursive:true,force:true});}
},40000);


test("registry rejects links, directories and oversized files while allowing exactly 1 MiB", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-file-"));
 try {
  const file=join(home,"bots.json"), link=join(home,"linked.json");
  const json=JSON.stringify({version:1,bots:[]});
  writeFileSync(file,json.padEnd(1_048_576," "));
  expect(loadBots(file,home)).toEqual([]);
  symlinkSync(file,link);
  expect(()=>loadBots(link,home)).toThrow("Cannot read bot registry JSON");
  expect(()=>loadBots(home,home)).toThrow("Cannot read bot registry JSON");
  writeFileSync(file,json.padEnd(1_048_577," "));
  expect(()=>loadBots(file,home)).toThrow("Cannot read bot registry JSON");
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("registry expands both home path separators for workdir and state root", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-home-path-"));
 try {
  mkdirSync(join(home,".agentschat/profiles"),{recursive:true}); mkdirSync(join(home,"project"));
  writeFileSync(join(home,".agentschat/profiles/one.json"),JSON.stringify({agent_id:"test-bot",token:"ac_test_bot_token"}),{mode:0o600});
  const file=join(home,"bots.json");
  for(const prefix of ["~/","~\\"]) for(const workdir of [false,true]) {
   writeFileSync(file,JSON.stringify({version:1,...(!workdir?{default_workdir:prefix+"project"}:{}),bots:[{name:"one",profile:"one",...(workdir?{workdir:prefix+"project"}:{}),state_root:prefix+"state"}]}));
   const bot=loadBots(file,home)[0]!;
   expect(bot.cwd).toBe(realpathSync(join(home,"project")));
   expect(bot.stateDir.startsWith(join(home,"state")+"/")).toBe(true);
  }
 } finally {rmSync(home,{recursive:true,force:true});}
});


test("manager import stays inert and direct/dynamic CLI entries handle missing and linked status", () => {
 const home=mkdtempSync(join(tmpdir(),"bots-entry-"));
 const manager=resolve(import.meta.dir,"../codex/manager.ts");
 const cli=resolve(import.meta.dir,"../src/cli.mjs");
 const run=(args:string[])=>spawnSync(process.execPath,args,{env:{...process.env,HOME:home},encoding:"utf8",timeout:5000});
 try {
  const imported=run(["-e",`await import(${JSON.stringify(manager)}); console.log('imported')`,"--unknown-test-option"]);
  expect(imported.status).toBe(0); expect(imported.stdout.trim()).toBe("imported");
  expect(existsSync(join(home,".agentschat/codex-bots"))).toBe(false);
  for(const args of [[manager,"--help"],[cli,"--codex-bots","--help"]]) {
   const result=run(args); expect(result.status).toBe(0); expect(result.stdout).toContain("Central registry");
  }
  const root=join(home,".agentschat/codex-bots"); mkdirSync(root,{recursive:true});
  for(const entry of [[manager],[cli,"--codex-bots"]]) {
   const absent=run([...entry,"--status"]);
   expect(absent.status).toBe(1); expect(absent.stderr).toContain("status file is missing, unsafe, or unreadable");
   const target=join(home,"private-status"); writeFileSync(target,"DO_NOT_PRINT"); symlinkSync(target,join(root,"status.json"));
   const linked=run([...entry,"--status"]);
   expect(linked.status).toBe(1); expect(linked.stdout).not.toContain("DO_NOT_PRINT");
   rmSync(join(root,"status.json"));
  }
 } finally {rmSync(home,{recursive:true,force:true});}
});

test("manager dead-lock cleanup preserves symlinks, directories, live PIDs and oversized files", () => {
 const dir=mkdtempSync(join(tmpdir(),"bots-lock-")), file=join(dir,"lock"), target=join(dir,"target");
 try {
  expect(()=>removeDeadLock(file)).not.toThrow();
  writeFileSync(target,"invalid"); symlinkSync(target,file);
  removeDeadLock(file); expect(lstatSync(file).isSymbolicLink()).toBe(true); expect(readFileSync(target,"utf8")).toBe("invalid");
  rmSync(file); mkdirSync(file); removeDeadLock(file); expect(lstatSync(file).isDirectory()).toBe(true); rmSync(file,{recursive:true});
  writeFileSync(file," ".repeat(65537)); removeDeadLock(file); expect(existsSync(file)).toBe(true);
  writeFileSync(file,String(process.pid)); removeDeadLock(file); expect(existsSync(file)).toBe(true);
  writeFileSync(file," ".repeat(65536)); removeDeadLock(file); expect(existsSync(file)).toBe(false);
  writeFileSync(file,"2147483647"); removeDeadLock(file); expect(existsSync(file)).toBe(false);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("manager saves private atomic snapshots and refuses linked roots/status or occupied temp paths", () => {
 const dir=mkdtempSync(join(tmpdir(),"bots-save-")), root=join(dir,"root"), target=join(dir,"target"), link=join(dir,"linked");
 mkdirSync(root); writeFileSync(target,"private");
 try {
  symlinkSync(root,link); save(link); expect(readdirSync(root)).toEqual([]);
  const status=join(root,"status.json"); symlinkSync(target,status); save(root);
  expect(lstatSync(status).isSymbolicLink()).toBe(true); expect(readFileSync(target,"utf8")).toBe("private"); rmSync(status);
  save(root); expect(JSON.parse(readFileSync(status,"utf8")).pid).toBe(process.pid);
  expect(lstatSync(status).mode & 0o777).toBe(0o600); expect(readdirSync(root)).toEqual(["status.json"]);
  // The next sequence is observable from exclusive create attempts, without exposing it publicly.
  const original=fs.writeFileSync;
  let occupied="";
  const spy=spyOn(fs,"writeFileSync").mockImplementation(((path:any,data:any,options:any)=>{
   if(String(path).endsWith(".tmp")) { occupied=String(path); original(path,"existing"); expect(options.flag).toBe("wx"); }
   return original(path,data,options);
  }) as any);
  const before=readFileSync(status,"utf8");
  try {save(root);} finally {spy.mockRestore();}
  expect(readFileSync(status,"utf8")).toBe(before); expect(readFileSync(occupied,"utf8")).toBe("existing");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

function worker(child?:any):Worker {
 return {child,config:{stateDir:"/nonexistent",cwd:tmpdir(),agentId:"test"} as any,fingerprint:"",failures:0,next:0,status:"running"};
}

test("manager stop resolves and clears its timer when SIGTERM throws", async () => {
 const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill:()=>{throw Error("already gone");}});
 const w=worker(child), clear=spyOn(globalThis,"clearTimeout");
 try {await stop(w); expect(w.child).toBeUndefined(); expect(w.status).toBe("stopped"); expect(child.listenerCount("exit")).toBe(0); expect(clear).toHaveBeenCalled();}
 finally {clear.mockRestore();}
});

test("manager IPC spawn callback tolerates disconnected channels and synchronous send failure", () => {
 for(const connected of [false,true]) {
  let sent=0;
  const child=Object.assign(new EventEmitter(),{connected,send:()=>{sent++;throw Error("closed IPC");}});
  start(worker(),(()=>child) as any);
  expect(()=>child.emit("spawn")).not.toThrow(); expect(sent).toBe(connected?1:0);
 }
});

test("manager shutdown lock cleanup tolerates absent files and removes only its own regular lock", () => {
 const dir=mkdtempSync(join(tmpdir(),"bots-unlock-")), file=join(dir,"lock"), target=join(dir,"target");
 try {
  expect(()=>removeOwnedLock(file)).not.toThrow();
  writeFileSync(file,"other-pid"); removeOwnedLock(file); expect(existsSync(file)).toBe(true);
  writeFileSync(file,` ${process.pid}\n`); removeOwnedLock(file); expect(existsSync(file)).toBe(false);
  writeFileSync(target,String(process.pid)); symlinkSync(target,file); removeOwnedLock(file);
  expect(lstatSync(file).isSymbolicLink()).toBe(true); expect(existsSync(target)).toBe(true);
  rmSync(file); mkdirSync(file); expect(()=>removeOwnedLock(file)).not.toThrow(); expect(lstatSync(file).isDirectory()).toBe(true);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
