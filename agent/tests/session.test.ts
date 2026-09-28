import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantSessions, type ConversationDriverOptions } from "@eval/runtime/assistant";
import { object, type ModelConfig } from "@eval/contracts";

async function until(fn:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await fn())return;await delay(10);}throw new Error("Timed out");}
test("durable inbox supports edit, removal and steering; progress uses upstream tool events",async()=>{
 const directory=await mkdtemp(tmpdir()+"/assistant-queue-");let release=()=>{};let driver!:ConversationDriverOptions;
 const errors:unknown[]=[],seen:string[]=[];
 const sessions=new AssistantSessions({directory,url:"http://127.0.0.1:1",model:{provider:"test",model:"test"} as ModelConfig,systemPrompt:"test",tools:[],onError:e=>errors.push(e),driver:async options=>{driver=options;return {
  async prompt(text){seen.push(text);await options.event({type:"agent_start"});await options.event({type:"turn_start"});await options.event({type:"message_end",message:{role:"user",content:[{type:"text",text}]}});if(text==="first")await new Promise<void>(r=>{release=r;});await options.event({type:"turn_end"});await options.event({type:"agent_end"});},
  async steer(text){await options.event({type:"message_end",message:{role:"user",content:[{type:"text",text}]}});},async abort(){release();},async dispose(){}
 };}});
 try{
  const state=await sessions.create("local"),scope={userId:"local",sessionId:state.sessionId};
  const send=async(text:string,mode:"queue"|"steer"="queue")=>{const requestId=randomUUID();await sessions.prompt("local",{...scope,requestId,mode,content:[{type:"text",text}]});return requestId;};
  const first=await send("first");await until(async()=>seen.length===1 && JSON.stringify(await sessions.page(scope)).includes('"user/message"'));
  const second=await send("second"),removed=await send("remove");
  const inbox=object(object(await sessions.projections(scope)).values).inbox as {"next-turn":{id:string}[]};assert.equal(inbox["next-turn"].length,2);
  await sessions.updateQueue(scope,second,{kind:"edit",content:[{type:"text",text:"edited"}]});
  await sessions.updateQueue(scope,removed,{kind:"remove"});
  const steering=await send("steering","steer");
  await driver.event({type:"tool_execution_start",toolCallId:"specialist",toolName:"call_specialist",args:{operationId:"operation"}});
  driver.progress("specialist",{operationId:"operation",event:{type:"model",data:{type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"专业任务正在分析证据"}}}});
  await delay(180);
  await driver.event({type:"message_end",message:{role:"toolResult",toolCallId:"specialist",content:[{type:"text",text:"accepted"}]}});
  assert(JSON.stringify(await sessions.page(scope)).includes("tool/ptc-dispatch"));
  release();await until(async()=>(await sessions.list("local"))[0].requests[second]==="completed");
  assert.deepEqual(seen,["first","edited"]);
  const statuses=(await sessions.list("local"))[0].requests;assert.equal(statuses[first],"completed");assert.equal(statuses[steering],"completed");assert.equal(statuses[removed],"interrupted");
  const page=JSON.stringify(await sessions.page(scope));assert(page.includes(steering));assert(!page.includes("replayState"));assert.deepEqual(errors,[]);
 }finally{await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});

test("specialist previews coalesce durably, retain the final transcript and reconnect without sequence gaps", async()=>{
 const directory=await mkdtemp(tmpdir()+"/assistant-progress-");
 let release=()=>{};let driver!:ConversationDriverOptions;
 const options={directory,url:"http://127.0.0.1:1",model:{provider:"test",model:"test"} as ModelConfig,systemPrompt:"test",tools:[],driver:async(context:ConversationDriverOptions)=>{driver=context;return {
  async prompt(){await context.event({type:"agent_start"});await new Promise<void>(resolve=>{release=resolve;});await context.event({type:"agent_end"});},
  async steer(){},async abort(){release();},async dispose(){}
 };}};
 let sessions=new AssistantSessions(options);
 try{
  const scope=await sessions.create("local"),requestId=randomUUID();
  await sessions.prompt("local",{sessionId:scope.sessionId,requestId,mode:"queue",content:[{type:"text",text:"analyze"}]});
  await until(async()=>!!driver);
  await driver.event({type:"tool_execution_start",toolCallId:"specialist",toolName:"call_specialist",args:{operationId:"operation"}});
  let expected="";
  for(let i=0;i<26;i++){
   const delta=`fragment-${i}:`+"evidence ".repeat(120);expected+=delta;
   driver.progress("specialist",{operationId:"operation",event:{type:"model",data:{type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta}}}});
   await delay(50);
  }
  await delay(1000);
  const abort=new AbortController(),follow=sessions.events(scope,abort.signal)[Symbol.asyncIterator]();
  const baseline=object((await follow.next()).value);
  assert.equal(baseline.type,"snapshot");assert(JSON.stringify(baseline).includes("fragment-25:"),"reconnect baseline contains the latest durable specialist preview");
  abort.abort();await follow.return?.();
  await driver.event({type:"message_end",message:{role:"toolResult",toolCallId:"specialist",content:[{type:"text",text:"accepted"}]}});
  release();await until(async()=>(await sessions.list("local"))[0].requests[requestId]==="completed");
  const page=object(await sessions.page(scope));
  const events=(page.records as {event:{type:string;seq:number;data:Record<string,unknown>}}[]).map(row=>row.event);
  const previews=events.filter(event=>event.type==="tool/ptc-dispatch");
  assert(previews.length<=4,`${previews.length} snapshots for a short burst`);
  assert.equal((previews.at(-1)!.data.content as {text:string}[])[0].text,expected);
  assert(Buffer.byteLength(JSON.stringify(previews))<Buffer.byteLength(expected)+12000,"preview persistence must not multiply the transcript by the number of deltas");
  assert.deepEqual(events.map(event=>event.seq),events.map((_,index)=>index));
  await sessions.dispose();sessions=new AssistantSessions(options);
  const restored=await sessions.page(scope);
  assert.equal(JSON.stringify(restored),JSON.stringify(page),"restarting preserves the same final output and event sequence");
 }finally{await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});
