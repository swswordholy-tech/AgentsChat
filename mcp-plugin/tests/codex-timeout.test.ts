import { expect, test, spyOn } from 'bun:test';
import { AppServer } from '../codex/app-server.ts';

const script = `
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let turns=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params;
 if(!m.id)return;
 const reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({});
 if(m.method==='config/read')reply({config:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:p.threadId||'same-thread'}});
 if(m.method==='turn/interrupt')process.exit(7);
 if(m.method==='turn/start'){
   const turn='turn-'+(++turns);reply({turn:{id:turn}});
   setTimeout(()=>emit({method:'turn/completed',params:{threadId:'same-thread',turn:{id:turn,status:'completed',items:[{type:'agentMessage',id:'answer',text:'done'}]}}}),150);
 }
});`;

test('long-running turns ignore the former time limit and keep the same backend and conversation', async () => {
  // A previous caller's 20 ms deadline must no longer interrupt a 150 ms turn.
  const app = new AppServer('node',['-e',script],20);
  let fatal=0;app.onFatal=()=>fatal++;
  try {
    await app.start();const id=await app.thread('/tmp');
    expect(await app.generate(id,'long task')).toBe('done');
    expect(await app.thread('/tmp',id)).toBe(id);
    expect(await app.generate(id,'next request')).toBe('done');
    expect(fatal).toBe(0);
  } finally {app.close();}
});

test('explicit operator shutdown still ends a pending turn', async () => {
  const app = new AppServer('node',['-e',script],20);
  try {
    await app.start();const id=await app.thread('/tmp');
    const pending=app.generate(id,'work');
    const observed=pending.then(()=>null,error=>error);
    await Bun.sleep(20);app.close();
    expect((await observed)?.message).toContain('stopped');
  } finally {app.close();}
});

test('Campaign #80: stalled control RPC times out cleanly without hanging start(), and SIGTERM-ignoring child is reaped', async () => {
  const stalledScript = `
    process.on('SIGTERM', () => {}); // ignore SIGTERM to exercise cleanup path
    setInterval(() => {}, 10000);
  `;
  const app = new AppServer('node', ['-e', stalledScript], undefined, 'full-access', undefined, undefined, undefined, undefined, 80);
  let fatalCount = 0;
  app.onFatal = () => fatalCount++;
  try {
    let err: Error | null = null;
    try {
      await app.start();
    } catch (e: any) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err!.message).toContain('timed out (initialize)');
    expect(fatalCount).toBe(1);
  } finally {
    app.close();
  }
});


test.each([null,123,[],"text",true])('non-object JSON-RPC frame %j rejects initialization once and closes cleanly', async frame => {
 const app=new AppServer('node',['-e',`process.stdout.write(${JSON.stringify(JSON.stringify(frame)+'\n')}); setInterval(()=>{},10000);`]);
 let fatal=0; app.onFatal=()=>fatal++;
 try {await expect(app.start()).rejects.toThrow('Invalid app-server response'); expect(fatal).toBe(1); expect((app as any).pending.size).toBe(0);}
 finally {app.close();}
});

test('turn/completed without turn metadata rejects the active turn without crashing', async () => {
 const malformed=script.replace("turn:{id:turn,status:'completed',items:[{type:'agentMessage',id:'answer',text:'done'}]}","turnId:turn");
 const app=new AppServer('node',['-e',malformed]);
 try {
  await app.start(); const id=await app.thread('/tmp');
  await expect(app.generate(id,'work')).rejects.toThrow('Codex turn unknown');
  expect(await app.thread('/tmp',id)).toBe(id);
 } finally {app.close();}
});

test('control RPC timeout normalizes invalid values and clamps fractional and 32-bit limits', async () => {
 const app=new AppServer(), delays:number[]=[];
 (app as any).write=()=>{};
 const original=globalThis.setTimeout;
 const timer=spyOn(globalThis,'setTimeout').mockImplementation(((fn:any,ms:number)=>{delays.push(ms);return original(fn,ms);}) as any);
 try {
  for(const ms of [NaN,0,-1,Infinity,-Infinity,1,50.9,123.9,2_147_483_648,Number.MAX_VALUE]) {
   const request=app.request('test',{},ms);
   (app as any).receive({id:(app as any).nextId,result:'ok'});
   expect(await request).toBe('ok');
  }
  expect(delays).toEqual([30000,30000,30000,30000,30000,50,50,123,2147483647,2147483647]);
  expect((app as any).pending.size).toBe(0);
 } finally {timer.mockRestore();app.close();}
});

test('closing a child already terminated by signal creates no escalation timer', () => {
 const app=new AppServer(); let killed=0, ended=0;
 (app as any).child={exitCode:null,signalCode:'SIGTERM',stdin:{end:()=>ended++},kill:()=>killed++};
 app.close(); expect(ended).toBe(1); expect(killed).toBe(0); expect((app as any).killTimer).toBeUndefined();
});
