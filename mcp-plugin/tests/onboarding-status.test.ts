/** Perspective: agents completing setup. Invariant: public chat does not require
 * claiming, status never exposes keys, and one-shot registration remains private.
 * Goal: prevent ownership prompts blocking public onboarding. Migration: keep
 * alongside the real CLI registration tests. */
import {test,expect} from "bun:test";
import {getOnboardingStatus,claimSummary} from "../src/onboarding-status";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
test("claimed false, true, absent, mismatched and failed status stay distinct",async()=>{
 for(const [body,expected] of [[{agent_id:"bot",claimed:true},true],[{agent_id:"bot",claimed:false},false],[{},null],[{agent_id:"other",claimed:true},null]] as const){
  const calls:any[]=[];
  const request=(async(url:any,options:any)=>{calls.push({url,options});return Response.json(body);});
  const s=await getOnboardingStatus("https://example.com","bot","ac_private",request);
  expect(s.claimed).toBe(expected);expect(JSON.stringify(s)).not.toContain("ac_private");
  expect(s.next_step).toBe(expected===true?"verify_reply":expected===false?"join_public_chat":"check_identity");
  if(expected===false)expect(claimSummary(s)).toContain("public group chat can proceed");
  expect(calls[0].options.headers.Authorization).toBe("Bearer ac_private");expect(calls[0].options.cache).toBe("no-store");
 }
 for(const code of [401,403,404,503]){
  let cancelled=false;
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
  const s=await getOnboardingStatus("https://example.com","bot","ac_private",(async()=>new Response(stream,{status:code})));
  expect(s.claimed).toBeNull();expect(claimSummary(s)).toContain("unknown");
  expect(s.authentication).toBe(code===401||code===403?"failed":"unknown");
  expect(cancelled).toBe(true);
 }
 // Plaintext non-loopback, credentialed URLs, and control-char tokens fail closed before sending Bearer headers
 for(const [badBase,badToken] of [["http://example.com","ac_private"],["https://u:p@example.com","ac_private"],["file:///etc/passwd","ac_private"],["https://example.com","ac_bad\r\ntoken"]] as const){
  let called=false;
  const s=await getOnboardingStatus(badBase,"bot",badToken,(async()=>{called=true;return Response.json({agent_id:"bot",claimed:true});}));
  expect(called).toBe(false);expect(s.claimed).toBeNull();expect(s.authentication).toBe("unknown");
 }
 // Oversized (>64 KiB) onboarding JSON bodies are cancelled and rejected without buffering unbounded payloads
 let oversizeCancelled=false;
 const hugeChunk=new TextEncoder().encode(`{"agent_id":"bot","claimed":true,"pad":"${"x".repeat(80*1024)}"}`);
 const hugeStream=new ReadableStream({pull(c){c.enqueue(hugeChunk);},cancel(){oversizeCancelled=true;}});
 const oversizeStatus=await getOnboardingStatus("https://example.com","bot","ac_private",(async()=>new Response(hugeStream,{status:200,headers:{"content-type":"application/json"}})));
 expect(oversizeStatus.claimed).toBeNull();expect(oversizeStatus.authentication).toBe("unknown");expect(oversizeCancelled).toBe(true);
 // claimSummary strips terminal escape / control characters from claim_url
 const forgedSummary=claimSummary({...oversizeStatus,claimed:false,claim_url:"https://example.com/chat/bot\x1b[31m\r\n?claim=1"});
 expect(forgedSummary).not.toMatch(/[\x00-\x1f\x7f]/);expect(forgedSummary).toContain("https://example.com/chat/bot[31m?claim=1");
});
test("one-shot registration exits with private clickable claim link, without logging key or starting MCP",async()=>{
 let calls=0;
 const hub=Bun.serve({port:0,fetch:async(req)=>{
  if(new URL(req.url).pathname==="/api/account/register"){
   calls++;const body=await req.json() as any;expect(body).not.toHaveProperty("accepted_terms");expect(body.terms_notice_version).toBe("2026-05-29");
   return Response.json({id:"test-bot",key:"ac_private_test_key",claim_url:"https://example.com/chat/test-bot?key=ac_private_test_key"});
  }
  return Response.json({agent_id:"test-bot",claimed:false});
 }});
 const home=mkdtempSync(join(tmpdir(),"onboarding-once-"));
 try {
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,"../src/server.ts"),"--name","test","--register-only","--url",`http://127.0.0.1:${hub.port}`],{
   env:{PATH:process.env.PATH,HOME:home,AGENTCHAT_REST_URL:`http://127.0.0.1:${hub.port}`,AGENTCHAT_NO_PROXY:"1",AGENTCHAT_URL:"ws://127.0.0.1:1/ws"},stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code).toBe(0);expect(calls).toBe(1);const result=JSON.parse(out);
  expect(result.claim_url).toContain("?key=ac_private_test_key");expect(result.claimed).toBe(false);expect(result.reply_verified).toBe(false);
  expect(result.next_step).toBe("join_public_chat");expect(result.terms_notice.requires_acceptance).toBe(false);
  expect(err).not.toContain("ac_private_test_key");expect(err).not.toContain("?key=");
  expect(JSON.parse(readFileSync(result.profile_file,"utf8")).agent_id).toBe("test-bot");
 } finally {hub.stop(true);rmSync(home,{recursive:true,force:true});}
},15000);
