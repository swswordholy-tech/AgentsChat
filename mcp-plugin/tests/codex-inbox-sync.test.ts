import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboxSync } from '../codex/inbox-sync.ts';

const dirs:string[]=[];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'codex-inbox-sync-'));dirs.push(dir);
  const file=join(dir,'inbound-cursors.json');
  const seed='2026-09-27T00:00:00.000000000Z';
  writeFileSync(file,JSON.stringify({version:1,channels:{group:seed}}),{mode:0o600});
  const row=(id:string,n:number)=>({id,channel_id:'group',sender_id:'owner',content:'@bot task',timestamp:`2026-09-27T00:00:00.${String(n).padStart(9,'0')}Z`});
  return {dir,file,seed,row,state:()=>JSON.parse(readFileSync(file,'utf8'))};
}

test('durable REST cursor catches gaps before a later live arrival without duplicates', async () => {
  const f=fixture(), ledger=new Set(['live-later']), executed:string[]=[], paths:string[]=[];
  const rows=[f.row('missed',1),f.row('live-later',2)];
  const api=async(path:string)=>{paths.push(path);const after=new URL(path,'http://localhost').searchParams.get('after')!;return {messages:rows.filter(m=>m.timestamp>after)};};
  const receive=(m:any)=>{if(!ledger.has(m.id)){ledger.add(m.id);executed.push(m.id);}return true;};
  let sync=new InboxSync(f.dir,api,receive,()=>true);sync.watch('group');await sync.sync();
  expect(executed).toEqual(['missed']);
  sync=new InboxSync(f.dir,api,receive,()=>true);sync.watch('group');await sync.sync();
  expect(executed).toEqual(['missed']);
  expect(decodeURIComponent(paths[1]!)).toContain('after='+rows[1]!.timestamp);
  expect(f.state().last_success_at).toBeString();
});

test('cold installation starts now without replaying historical instructions', async () => {
  const f=fixture();rmSync(f.file);let after='';let deliveries=0;
  const start=Date.now();
  const sync=new InboxSync(f.dir,async path=>{after=new URL(path,'http://localhost').searchParams.get('after')!;return {messages:[]};},()=>{deliveries++;return true;},()=>true);
  sync.watch('group');await sync.sync();
  expect(Date.parse(after)).toBeGreaterThanOrEqual(start);expect(deliveries).toBe(0);
});

test('full inbox retains page checkpoint, including an unaccepted equal-time sibling', async () => {
  const f=fixture(), seen=new Set<string>();let full=true;
  const rows=[f.row('one',1),f.row('two',1)];
  const sync=new InboxSync(f.dir,async()=>({messages:rows}),(m:any)=>{
    if(m.id==='two'&&full)return false;seen.add(m.id);return true;
  },()=>true);
  sync.watch('group');await sync.sync();expect(f.state().channels.group).toBe(f.seed);
  full=false;await sync.sync();expect([...seen]).toEqual(['one','two']);expect(f.state().channels.group).toBe(rows[1]!.timestamp);
});

test('failed or stopped fetch cannot advance cursor or deliver after shutdown', async () => {
  const f=fixture();let active=true, calls=0, delivered=0;
  let release!:(value:any)=>void;
  const sync=new InboxSync(f.dir,async()=>{
    if(++calls===1)throw Error('unavailable');return await new Promise(r=>{release=r;});
  },()=>{delivered++;return true;},()=>active,()=>{});
  sync.watch('group');await sync.sync();expect(f.state().channels.group).toBe(f.seed);expect(f.state().last_error).toBeString();
  const pending=sync.sync();expect(sync.sync()).toBe(pending);
  active=false;release({messages:[f.row('late',1)]});await pending;
  expect(delivered).toBe(0);expect(f.state().channels.group).toBe(f.seed);
});

test('history pagination is bounded and resumes from completed page', async () => {
  const f=fixture(), all=Array.from({length:75},(_,i)=>f.row(String(i),i+1)), seen:string[]=[];
  const sync=new InboxSync(f.dir,async path=>{
    const q=new URL(path,'http://localhost').searchParams;expect(q.get('limit')).toBe('50');
    return {messages:all.filter(m=>m.timestamp>q.get('after')!).slice(0,50)};
  },(m:any)=>{seen.push(m.id);return true;},()=>true);
  sync.watch('group');await sync.sync();expect(seen).toHaveLength(50);
  await sync.sync();expect(seen).toHaveLength(75);expect(new Set(seen).size).toBe(75);
});

function idle(dir:string) { return new InboxSync(dir,async()=>[],()=>true,()=>true,()=>{}); }

test('state directory and live or dangling checkpoint symlinks are rejected', () => {
  const f=fixture(), alias=join(f.dir,'alias');
  symlinkSync(f.dir,alias,'dir');
  expect(()=>idle(alias)).toThrow();
  for(const target of [join(f.dir,'target'),join(f.dir,'missing')]) {
    if(target.endsWith('target')) writeFileSync(target,readFileSync(f.file,'utf8')); rmSync(f.file);
    symlinkSync(target,f.file);
    expect(()=>idle(f.dir)).toThrow();
    expect(lstatSync(f.file).isSymbolicLink()).toBe(true);
  }
});

test('only a missing checkpoint permits cold start; malformed structures fail closed', () => {
  const f=fixture();
  for(const value of ['null','{','[]','{"version":1,"channels":[]}','{"version":2,"channels":{}}','{"version":1,"channels":{"group":"bad"}}']) {
    writeFileSync(f.file,value); expect(()=>idle(f.dir)).toThrow(); expect(readFileSync(f.file,'utf8')).toBe(value);
  }
  rmSync(f.file); mkdirSync(f.file); expect(()=>idle(f.dir)).toThrow();
});

test('legacy invalid channel keys are filtered before timestamp validation', () => {
  const f=fixture(), channels=Object.create(null);
  for(const key of ['constructor','prototype','','  ','bad\u0000key','bad\u007fkey']) channels[key]='bad';
  channels.group=f.seed;
  writeFileSync(f.file,JSON.stringify({version:1,channels}));
  idle(f.dir).watch('new');
  expect(Object.keys(f.state().channels).sort()).toEqual(['group','new']);
  expect(f.state().channels.group).toBe(f.seed);
});

test('watch and memberships reject invalid channel IDs without changing membership', async () => {
  const f=fixture(), paths:string[]=[];
  const sync=new InboxSync(f.dir,async path=>{paths.push(path);return [];},()=>true,()=>true);
  sync.watch('group');
  for(const bad of [null,undefined,42,{},'', '  ','__proto__','constructor','prototype','bad\nkey','bad\u0085key']) {
    expect(()=>sync.watch(bad as any)).toThrow();
    expect(()=>sync.memberships(['new',bad as any])).toThrow();
  }
  await sync.sync(); expect(paths).toHaveLength(1); expect(paths[0]).toContain('/group/');
  expect(Object.keys(f.state().channels)).toEqual(['group']);
});

test('batch membership saves once for 100 new channels and never for unchanged channels', () => {
  const f=fixture(), sync=idle(f.dir), save=spyOn(sync as any,'save');
  const channels=Array.from({length:100},(_,i)=>`room-${i}`);
  sync.memberships([...channels,...channels]); expect(save).toHaveBeenCalledTimes(1);
  expect(Object.keys(f.state().channels)).toHaveLength(101);
  sync.memberships(channels); sync.memberships([]); expect(save).toHaveBeenCalledTimes(1);
  save.mockRestore();
});

test('state permissions are private and repeated same-millisecond saves leave no temp files', () => {
  const f=fixture(); chmodSync(f.dir,0o777);
  const clock=spyOn(Date,'now').mockReturnValue(12345);
  try {
    const sync=idle(f.dir); sync.watch('one'); sync.watch('two');
    expect(Object.keys(f.state().channels)).toEqual(['group','one','two']);
    expect(readdirSync(f.dir)).toEqual(['inbound-cursors.json']);
    if(process.platform!=='win32') {
      expect(lstatSync(f.dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(f.file).mode & 0o777).toBe(0o600);
    }
  } finally { clock.mockRestore(); }
});

test('blank or non-string history IDs reject the full page and preserve its checkpoint', async () => {
  for(const bad of ['', '  ', '\t', 12, null]) {
    const f=fixture(); let delivered=0;
    const sync=new InboxSync(f.dir,async()=>[f.row('good',1),{...f.row('bad',2),id:bad}],()=>{delivered++;return true;},()=>true,()=>{});
    sync.watch('group'); await sync.sync();
    expect(delivered).toBe(0); expect(f.state().channels.group).toBe(f.seed); expect(f.state().last_error).toBeString();
  }
});

test('failed atomic replacement removes its private temporary file', () => {
  const f=fixture(), sync=idle(f.dir);
  const original=(sync as any).state;
  (sync as any).state={...original,toJSON(){rmSync(f.file);mkdirSync(f.file);return original;}};
  expect(()=>sync.watch('new')).toThrow();
  expect(lstatSync(f.file).isDirectory()).toBe(true);
  expect(readdirSync(f.dir)).toEqual(['inbound-cursors.json']);
});

test('inbound channels reject traversal, case-insensitive prototype keys and excessive length', () => {
  const f=fixture(), channels=Object.create(null);
  const invalid=['__PROTO__','Constructor','PROTOTYPE','a..b','a/b','a\\b','x'.repeat(129)];
  for(const key of invalid) channels[key]='1';
  channels.group=f.seed;
  writeFileSync(f.file,JSON.stringify({version:1,channels}));
  const sync=idle(f.dir);
  for(const key of invalid) {
    expect(()=>sync.watch(key)).toThrow('Invalid inbound channel');
    expect(()=>sync.memberships([key])).toThrow('Invalid inbound channel');
  }
  sync.watch('x'.repeat(128));
  expect(Object.keys(f.state().channels)).toEqual(['group','x'.repeat(128)]);
});

test('non-ISO finite dates reject checkpoints and full history pages before delivery', async () => {
  for(const timestamp of ['1','2026-09-27','09/27/2026','2026-09-27T00:00:00','2026-99-99T00:00:00Z','2026-02-31T10:00:00+08:00']) {
    const f=fixture();
    writeFileSync(f.file,JSON.stringify({version:1,channels:{group:timestamp}}));
    expect(()=>idle(f.dir)).toThrow('Invalid history timestamp');
    writeFileSync(f.file,JSON.stringify({version:1,channels:{group:f.seed}}));
    let delivered=0;
    const sync=new InboxSync(f.dir,async()=>[f.row('good',1),{...f.row('bad',2),timestamp}],()=>{delivered++;return true;},()=>true,()=>{});
    sync.watch('group');await sync.sync();
    expect(delivered).toBe(0);expect(f.state().channels.group).toBe(f.seed);
  }
});

test('inbound checkpoint size boundary and serialization-time link replacement fail closed', () => {
  const f=fixture(), raw=readFileSync(f.file,'utf8');
  writeFileSync(f.file,raw+' '.repeat(1_048_576-raw.length));
  const sync=idle(f.dir);
  writeFileSync(f.file,raw+' '.repeat(1_048_577-raw.length));
  expect(()=>idle(f.dir)).toThrow('size limit');
  const state=(sync as any).state, outside=join(f.dir,'outside');writeFileSync(outside,'untouched');
  (sync as any).state={...state,toJSON(){rmSync(f.file);symlinkSync(outside,f.file);return state;}};
  expect(()=>sync.watch('new')).toThrow('Invalid inbound cursors file');
  expect(lstatSync(f.file).isSymbolicLink()).toBe(true);
  expect(readFileSync(outside,'utf8')).toBe('untouched');
  expect(readdirSync(f.dir).filter(f=>f.endsWith('.tmp'))).toEqual([]);
  const regular=join(f.dir,'regular');writeFileSync(regular,'');
  expect(()=>idle(regular)).toThrow('Invalid inbound state directory');
});
