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
