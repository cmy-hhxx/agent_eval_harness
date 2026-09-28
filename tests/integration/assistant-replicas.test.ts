import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteStreamCarrierError, RemoteStreamMuxClient } from "../../packages/runtime/src/deepseek.js";
import { type JsonObject, object } from "@eval/contracts";

async function launch(directory: string) {
  const child = fork("agent/tests/replica-process.mjs", [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr?.on("data", (chunk) => { stderr += String(chunk); console.error(String(chunk)); });
  const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(stderr); })]);
  return { child, url: (ready[0] as {url: string}).url };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(signal); const timeout = setTimeout(() => child.kill("SIGKILL"), 2000); try { await exited; } finally { clearTimeout(timeout); }
}
async function rpc(url: string, user: string, method: string, request: JsonObject = {}) {
  const response = await fetch(`${url}/u/${user}/api/${method}`, {method:"POST",signal:AbortSignal.timeout(5000),headers:{"content-type":"application/json"},body:JSON.stringify({type:"client-request",rpcId:randomUUID(),method,payload:{args:{request}}})});
  const result = object(object(await response.json()).result); assert.equal(result.ok, true, JSON.stringify(result)); return object(result.value);
}
async function until(fn: () => Promise<boolean>) { for (let n=0;n<200;n++){ if(await fn())return; await delay(20); } throw new Error("Timed out"); }

test("two local processes forward one Session, deduplicate UUIDs and replace a dead owner", {timeout:30000}, async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),"assistant-replicas-"));
 const a=await launch(directory),b=await launch(directory);
 const id=randomUUID(),requestId=randomUUID();let relay: RemoteStreamMuxClient|undefined;
 try {
  await rpc(a.url,"alice","session/create",{sessionId:id});
  const request={sessionId:id,requestId,mode:"queue",content:[{type:"text",text:"hold"}]};
  await rpc(a.url,"alice","session/prompt",request);
  await Promise.all([rpc(b.url,"alice","session/prompt",request),rpc(a.url,"alice","session/prompt",request)]);

  const address={kind:"session",sessionId:id};
  await until(async()=>(object(await rpc(b.url,"alice","session/page",{address})).records as {event:{type:string}}[]).some(r=>r.event.type==="tool/result"));
  const page=await rpc(b.url,"alice","session/page",{address});
  assert.equal((page.records as {event:{type:string}}[]).filter(r=>r.event.type==="user/message").length,1);
  assert.deepEqual((await rpc(b.url,"bob","session/list")).items,[]);
  const inspected=await rpc(b.url,"alice","assistant/toolResult",{sessionId:id,callId:"lookup-hold"});
  assert.equal((inspected.content as {text:string}[])[0].text,String(a.child.pid),"source inspection forwards to the current owner");

  relay=new RemoteStreamMuxClient(`${b.url.replace(/^http/,"ws")}/u/alice/api/remote.mux`);relay.start();
  const controller=new AbortController(),follow=relay.open("session/follow",{args:{request:{address,assistantStream:true}}},AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]))[Symbol.asyncIterator]();
  assert.equal(object((await follow.next()).value).type,"snapshot");
  // Committed events can still be in flight after the baseline. Only a physical
  // carrier failure proves generation recovery; a timeout/abort must fail.
  const carrierFailure=(async()=>{
   try { while(!(await follow.next()).done) {} return false; }
   catch(error) { return error instanceof RemoteStreamCarrierError; }
  })();
  await kill(a.child,"SIGKILL");
  assert.equal(await carrierFailure,true,"replica closes the physical carrier so upstream generation recovery runs");
  await relay.close();relay=undefined;
  const restored=await rpc(b.url,"alice","session/page",{address});
  const recoveredSource=await rpc(b.url,"alice","assistant/toolResult",{sessionId:id,callId:"lookup-hold"});
  assert.equal((recoveredSource.content as {text:string}[])[0].text,String(b.child.pid),"the new owner can resolve the recorded reference");
  assert(JSON.stringify(restored).includes('"kind":"interrupted"'));
  await rpc(b.url,"alice","session/prompt",request);
  await rpc(b.url,"alice","session/prompt",{...request,requestId:randomUUID(),content:[{type:"text",text:"continue"}]});
  await until(async()=>JSON.stringify(await rpc(b.url,"alice","session/page",{address})).includes("reply:continue"));
  const final=await rpc(b.url,"alice","session/page",{address});
  assert.equal((final.records as {event:{type:string}}[]).filter(r=>r.event.type==="user/message").length,2);
 }finally{await relay?.close();await kill(a.child,"SIGTERM");await kill(b.child,"SIGTERM");await rm(directory,{recursive:true,force:true});}
});
