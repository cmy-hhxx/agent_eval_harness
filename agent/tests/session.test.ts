import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantSessions, type ConversationDriverOptions } from "@eval/runtime/assistant";
import { AssistantJournal } from "@eval/data";
import { object, type AssistantEvent, type JsonObject, type ModelConfig } from "@eval/contracts";
import { createAssistantMessage, createToolResultMessage } from "../../packages/runtime/src/deepseek.js";

async function until(fn:()=>Promise<boolean>){for(let n=0;n<200;n++){if(await fn())return;await delay(10);}throw new Error("Timed out");}
test("opening messages stay visible through slow preparation, compaction and reconnect without duplicate replay", async () => {
 const directory=await mkdtemp(tmpdir()+"/assistant-admission-");
 const gate=()=>{let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
 const prepared=gate(), prepare=gate(), compacting=gate(), compact=gate();
 const sessions=new AssistantSessions({directory,url:"http://127.0.0.1:1",model:{provider:"test",model:"test"} as ModelConfig,systemPrompt:"test",tools:[],driver:async options=>{
  assert(!options.history.some(event=>event.type==="user/message"),"the opening input is passed to prompt, not replayed twice");
  assert(!options.records.some(record=>record.kind==="event" && record.event.type==="user/message"));
  prepared.resolve(); await prepare.promise;
  return {async prompt(text,messageId){
   compacting.resolve();await compact.promise;
   assert.equal(messageId,requestId);
   await options.event({type:"agent_start"});await options.event({type:"turn_start"});
   await options.event({type:"message_end",entryId:"sdk-user-id",message:{role:"user",content:[{type:"text",text}]}});
   await options.event({type:"turn_end"});await options.event({type:"agent_end"});
  },async steer(){},async abort(){prepare.resolve();compact.resolve();},async dispose(){}};
 }});
 const requestId=randomUUID();
 try {
  const scope=await sessions.create("local");
  await sessions.prompt("local",{sessionId:scope.sessionId,requestId,mode:"queue",content:[{type:"text",text:"这条消息要一直可见"}]});
  const check=async()=>{
   const page=object(await sessions.page(scope)),events=(page.records as {event:AssistantEvent}[]).map(row=>row.event);
   const header=object(events.find(event=>event.type==="request/header")?.data.header);
   assert(!Object.hasOwn(header,"tools"),"tool-less sessions omit the catalog so history and live events satisfy the wire contract");
   const messages=events.filter(event=>event.type==="user/message");
   assert.equal(messages.length,1);assert.equal(messages[0].data.id,requestId);
   assert.equal(events.filter(event=>event.type==="turn/start").length,1);
   const signal=new AbortController(),follow=sessions.events(scope,signal.signal)[Symbol.asyncIterator]();
   try { assert(JSON.stringify((await follow.next()).value).includes("这条消息要一直可见")); }
   finally {signal.abort();await follow.return?.();}
  };
  await prepared.promise;await check();
  prepare.resolve();await compacting.promise;await check();
  compact.resolve();await until(async()=>(await sessions.list("local"))[0].requests[requestId]==="completed");await check();
 } finally {prepare.resolve();compact.resolve();await sessions.dispose();await rm(directory,{recursive:true,force:true});}
});

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

const recoveryCalls = ["accepted", "unknown", "not-started"];
const recoveryContent = recoveryCalls.map(id => ({ type: "toolCall", id, name: "lookup", arguments: {} }));
function assertRecovery(events: AssistantEvent[]) {
  const results = events.filter(event => event.type === "tool/result");
  assert.equal(results.length, 3, "preserve the accepted result and recover each unanswered request once");
  const accepted = results.find(event => object(event.data.message).toolCallId === "accepted")!;
  assert.equal(object(accepted.data.message).isError, false);
  assert.deepEqual(object(accepted.data.message).content, [{ type: "text", text: "accepted result" }]);
  for (const [callId, code] of [["unknown", "TOOL_OUTCOME_UNKNOWN"], ["not-started", "TOOL_NOT_STARTED"]]) {
    const result = results.find(event => object(event.data.message).toolCallId === callId)!;
    assert.equal(object(result.data.error).code, code);
    assert.equal(object(result.data.message).isError, true);
    assert(JSON.stringify(object(result.data.message).content).includes("按原 operationId 查询"));
  }
  const stepEnd = events.findIndex(event => event.type === "step/end");
  const turnEnd = events.findIndex(event => event.type === "turn/end");
  assert(results.every(result => result.seq < stepEnd), "settle tools before closing their step");
  assert(stepEnd < turnEnd, "close an open step before its turn");
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index));
}

test("failed steps settle tools and save state even when driver cleanup fails", async () => {
  const directory = await mkdtemp(tmpdir() + "/assistant-failed-step-");
  const histories: AssistantEvent[][] = [], errors: unknown[] = [];
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model: { provider: "test", model: "test" } as ModelConfig,
    systemPrompt: "test", tools: [], recoveryMessage: "请按原 operationId 查询专业任务的正式结果后再决定继续。", onError: error => errors.push(error),
    driver: async options => {
      histories.push(structuredClone([...options.history]));
      const first = histories.length === 1;
      return {
        async prompt(text) {
          await options.event({ type: "agent_start" }); await options.event({ type: "turn_start" });
          await options.event({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
          if (text === "fail") {
            await options.event({ type: "message_end", message: { role: "assistant", content: recoveryContent } });
            await options.event({ type: "tool_execution_start", toolCallId: "accepted", toolName: "lookup", args: {} });
            await options.event({ type: "message_end", message: { role: "toolResult", toolCallId: "accepted", content: [{ type: "text", text: "accepted result" }] } });
            await options.event({ type: "tool_execution_start", toolCallId: "unknown", toolName: "lookup", args: {} });
            await options.event({ type: "message_start", message: { role: "assistant" } });
            throw new Error("dispatch failed");
          }
          await options.event({ type: "turn_end" }); await options.event({ type: "agent_end" });
        }, async steer() {}, async abort() { if (first) throw new Error("abort cleanup failed"); }, async dispose() { if (first) throw new Error("dispose cleanup failed"); },
      };
    },
  });
  try {
    const scope = await sessions.create("local"), failedId = randomUUID();
    await sessions.prompt("local", { sessionId: scope.sessionId, requestId: failedId, mode: "queue", content: [{ type: "text", text: "fail" }] });
    await until(async () => (await sessions.list("local"))[0].requests[failedId] === "interrupted");
    const page = object(await sessions.page(scope));
    const events = (page.records as {event: AssistantEvent}[]).map(record => record.event);
    assertRecovery(events);
    const control = new AbortController(), follow = sessions.events(scope, control.signal)[Symbol.asyncIterator]();
    const snapshot = object((await follow.next()).value);
    assert.equal(object(snapshot.assistantStream).activeAttempt, undefined, "failed partial streams do not survive as active attempts");
    control.abort(); await follow.return?.();
    const nextId = randomUUID();
    await sessions.prompt("local", { sessionId: scope.sessionId, requestId: nextId, mode: "queue", content: [{ type: "text", text: "continue" }] });
    await until(async () => (await sessions.list("local"))[0].requests[nextId] === "completed");
    assert.equal(histories.length, 2, "a failed driver must be rebuilt before the next request");
    assertRecovery(histories[1]);
    assert.equal(errors.length, 2);
    assert(errors[1] instanceof AggregateError);
    assert.equal((errors[1] as AggregateError).errors.length, 2, "report both cleanup failures after preserving request state");
  } finally { await sessions.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("crash recovery balances the open tail and never repairs tools from earlier closed steps", async () => {
  const directory = await mkdtemp(tmpdir() + "/assistant-crash-step-");
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model: { provider: "test", model: "test" } as ModelConfig,
    systemPrompt: "test", tools: [], recoveryMessage: "请按原 operationId 查询专业任务的正式结果后再决定继续。",
    driver: async () => { throw new Error("an interrupted request must not replay"); },
  });
  try {
    const journal = await AssistantJournal.create(directory, "local"), requestId = randomUUID();
    await journal.command({ sessionId: journal.state.sessionId, requestId, mode: "queue", content: [{ type: "text", text: "analyze" }] });
    const append = (type: string, data: JsonObject, surface = false) => journal.append({ kind: "event", event: {
      type, seq: journal.events.length, time: Date.now(), data, ...(surface ? { surfaceOp: "append" as const } : {}),
    } });
    await append("assistant/request", { requestId, status: "running" });
    await append("turn/start", { turn: 1 }); await append("step/start", { turn: 1, step: 1 });
    await append("assistant/message", { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: "tool-call", id: "earlier", name: "lookup", arguments: "{}" }] }), stream: [] }, true);
    await append("step/end", { turn: 1, step: 1 });
    await append("step/start", { turn: 1, step: 2 });
    await append("assistant/message", { turn: 1, step: 2, message: createAssistantMessage({ content: recoveryCalls.map(id => ({ type: "tool-call", id, name: "lookup", arguments: "{}" })) }), stream: [] }, true);
    await append("tool/call", { turn: 1, step: 2, callId: "accepted", name: "lookup", arguments: "{}" });
    await append("tool/result", { turn: 1, step: 2, message: createToolResultMessage({ callId: "accepted", isError: false, content: [{ type: "text", text: "accepted result" }] }) }, true);
    await append("tool/call", { turn: 1, step: 2, callId: "unknown", name: "lookup", arguments: "{}" });
    const scope = journal.state;
    const events = (object(await sessions.page(scope)).records as {event: AssistantEvent}[]).map(record => record.event);
    const current = events.slice(events.findIndex(event => event.type === "step/start" && event.data.step === 2));
    // Keep the original sequence positions while checking the recovered tail.
    assertRecovery(current.map((event, index) => ({ ...event, seq: index })));
    assert(!events.some(event => event.type === "tool/result" && object(event.data.message).toolCallId === "earlier"));
    assert.equal(object(events.findLast(event => event.type === "turn/end")!.data.reason).kind, "interrupted");
    assert.equal((await sessions.list("local"))[0].requests[requestId], "interrupted");
    assert.deepEqual(object(await sessions.page(scope)).records, events.map(event => ({ type: "event", event })), "a second read does not repeat recovery");
  } finally { await sessions.dispose(); await rm(directory, { recursive: true, force: true }); }
});
