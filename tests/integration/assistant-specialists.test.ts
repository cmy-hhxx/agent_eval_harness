import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildPlan } from "@eval/workflows/comparison";
import { writeJson } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { LocalSpecialists } from "../../apps/host/src/assistant-specialists.js";
import { LocalAnalysisData } from "../../apps/host/src/assistant-data.js";
import { loadConfig } from "@eval/host-app/config";
import { services, ROOT } from "../fixtures/services.js";
import { fixtureConfig, fakeIdentity, taskResult, draftFor } from "../fixtures/comparison.js";
import { analysisTools } from "@eval/assistant";
import type { AnalysisReference } from "@eval/contracts";

test("standalone Attribution and Comparison share material, validation, accepted results and resume", {timeout:30000}, async()=>{
 const fixture=await fixtureConfig();
 let calls=0;
 const worker=await startWorker({identity:fakeIdentity,async createSession(options){return {async run(){calls++;const result=await options.execute("submit_evaluation",draftFor(options.spec,taskResult(options.spec)));assert.equal(result.isError,undefined,JSON.stringify(result));},async abort(){},async dispose(){}};}},path.join(fixture.directory,"worker"));
 try {
  const config=await loadConfig(path.join(ROOT,"configs/host.json"),{EVAL_BASE_URL:"http://127.0.0.1:1/v1"});
  config.evaluation=fixture.config;config.models=fixture.models;
  const plan=await buildPlan(fixture.config);
  // Persist only the current source catalogue through the same Host preflight path.
  await runEvaluation({...services,plan:{...plan,tasks:[]},runId:"source",output:fixture.config.output,engine:"pi",evaluatorVersion:config.evaluatorVersion,config:fixture.config,policy:fixture.config.execution,modelForStage:fixture.modelForStage,retries:0,retryDelaySeconds:0,workerUrls:[worker.url],concurrency:1});
  const source=new LocalAnalysisData(fixture.config.output.path), gateway=new LocalSpecialists(path.join(fixture.directory,"assistant"),source,config,false,{workerUrls:[worker.url],identity:fakeIdentity});
  const task=plan.tasks.find(task=>task.stage==="comparison")!;
  const inputs: AnalysisReference[]=Object.values(task.inputIds).map(inputId=>({runId:"source",inputId}));
  const scope={userId:"alice",sessionId:randomUUID()},signal=new AbortController().signal;
  const interruptedId=randomUUID();
  await writeJson(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",interruptedId,"request.json"),{operationId:interruptedId,kind:"attribution",inputs:[inputs[0]]});
  assert.equal((await gateway.read(scope,interruptedId)).error,"interrupted");
  const missing=await gateway.invoke(scope,{kind:"comparison",operationId:randomUUID(),inputs},signal);
  assert.equal(missing.error,"missingAttributions");assert.equal(calls,0);
  const attributions=[];
  for(const reference of inputs){
   const operationId=randomUUID(),request={kind:"attribution" as const,operationId,inputs:[reference]};
   const accepted=await gateway.invoke(scope,request,signal);assert.equal(accepted.state,"succeeded",JSON.stringify(accepted));
   assert.equal(accepted.evaluatorVersion,config.evaluatorVersion);
   const before: number=calls;assert.deepEqual(await gateway.invoke(scope,request,signal),accepted);assert.equal(calls,before);
   attributions.push({inputId:reference.inputId!,operationId});
  }
  const operationId=randomUUID(),result=await gateway.invoke(scope,{kind:"comparison",operationId,inputs,attributions},signal);
  assert.equal(result.state,"succeeded",JSON.stringify(result));assert.equal(calls,3);
  const formalData=new LocalAnalysisData(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",operationId,"execution"));
  const formal=await formalData.read({runId:operationId,taskId:operationId});
  assert.equal(formal.evaluatorVersion,config.evaluatorVersion);assert.deepEqual(formal.result,result.result);
  const serialized=JSON.stringify(result.result);assert(serialized.includes("正确"));assert(serialized.includes("evaluator_version"));
  await assert.rejects(gateway.read({userId:"bob",sessionId:scope.sessionId},operationId),/ENOENT/);
  let saved="";
  const tools=analysisTools({data:source,specialists:gateway,save:async(_,text)=>{saved=text;return {id:"summary"};}});
  const save=tools.find(tool=>tool.name==="save_summary")!;
  const context={scope,signal,callId:"summary",progress(){}};
  await save.execute({markdown:"评测总结",references:[{operationId}]},context);
  assert(saved.includes(config.evaluatorVersion));assert(saved.includes(operationId));
  await assert.rejects(save.execute({markdown:"伪造",references:[{reference:{runId:"source",taskId:"missing"}}]},context));
  const read=await source.read({...inputs[0],messageIndex:1},{offset:2,limit:2});assert.equal(read.text,"ss");assert.equal((read.evidence as {quote:string}[])[0].quote,"ss");
  const state=await readFile(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",operationId,"execution",operationId,"state.json"),"utf8");
  assert(!state.includes('"messages"'),"state keeps references, not original message bodies");
  assert(!JSON.stringify(read).includes("undefined"));
 }finally{await worker.close();await rm(fixture.directory,{recursive:true,force:true});}
});
