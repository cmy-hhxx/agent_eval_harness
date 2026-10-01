import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildPlan, readRunTasks } from "@eval/workflows/comparison";
import { writeJson, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { LocalSpecialists } from "../../apps/host/src/assistant-specialists.js";
import { LocalAnalysisData } from "../../apps/host/src/assistant-data.js";
import { loadConfig } from "@eval/host-app/config";
import { services, ROOT } from "../fixtures/services.js";
import { fixtureConfig, fakeIdentity, taskResult, draftFor, parsedMaterial, raw } from "../fixtures/comparison.js";
import { createEris } from "@eval/assistant";
import type { AnalysisReference, TaskAnalysis } from "@eval/contracts";

test("standalone Attribution and Comparison share material, validation, accepted results and resume", {timeout:30000}, async()=>{
 const fixture=await fixtureConfig();
 let calls=0, interruptComparison=false;
 const worker=await startWorker({identity:fakeIdentity,async createSession(options){return {async run(){calls++;if(interruptComparison&&options.spec.evaluation.id==="comparison"){interruptComparison=false;throw new Error("fixture comparison interrupted");}const result=await options.execute("submit_evaluation",draftFor(options.spec,taskResult(options.spec)));assert.equal(result.isError,undefined,JSON.stringify(result));},async abort(){},async dispose(){}};}},path.join(fixture.directory,"worker"));
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
  const automatic=await gateway.invoke(scope,{kind:"comparison",operationId:randomUUID(),inputs},signal);
  assert.equal(automatic.state,"succeeded",JSON.stringify(automatic));assert.equal(calls,4);
  const attributions=[];
  for(const reference of inputs){
   const operationId=randomUUID(),request={kind:"attribution" as const,operationId,inputs:[reference]};
   const accepted=await gateway.invoke(scope,request,signal);assert.equal(accepted.state,"succeeded",JSON.stringify(accepted));
   assert.equal(accepted.evaluatorVersion,config.evaluatorVersion);
   const before: number=calls;assert.deepEqual(await gateway.invoke(scope,request,signal),accepted);assert.equal(calls,before);
   attributions.push({inputId:reference.inputId!,operationId});
  }
  const operationId=randomUUID(),comparisonRequest={kind:"comparison" as const,operationId,inputs,attributions};
  interruptComparison=true;
  const failed=await gateway.invoke(scope,comparisonRequest,signal);
  assert.equal(failed.state,"failed");assert.equal(calls,10);
  const result=await gateway.invoke(scope,comparisonRequest,signal);
  assert.equal(result.state,"succeeded",JSON.stringify(result));assert.equal(calls,11,"resume reuses accepted criteria and external attributions");
  const acceptedState=await readRunTasks(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",operationId,"execution",operationId),[]);
  assert.deepEqual(acceptedState.manifest.tasks.map(task=>task.stage),["criteria","comparison"],"matching accepted attributions are reused without duplicate execution");
  const formalData=new LocalAnalysisData(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",operationId,"execution"));
  const formal=await formalData.read({runId:operationId,taskId:operationId});
  assert.equal(formal.evaluatorVersion,config.evaluatorVersion);assert.deepEqual(formal.result,result.result);
  const serialized=JSON.stringify(result.result);assert(serialized.includes("正确"));assert(serialized.includes("evaluator_version"));
  await assert.rejects(gateway.read({userId:"bob",sessionId:scope.sessionId},operationId),/当前会话没有这个 operationId/);
  let saved="";
  const {tools}=createEris({data:source,specialists:gateway,save:async(_,text)=>{saved=text;return {id:"summary"};}});
  const save=tools.find(tool=>tool.name==="save_summary")!;
  const context={scope,signal,callId:"summary",progress(){}};
  const summary=await save.execute({markdown:"评测总结",references:[{operationId}]},context);
  assert.equal(saved,"评测总结");
  assert.deepEqual(summary.details,{references:[{operationId,evaluatorVersion:config.evaluatorVersion,reference:result.reference}]});
  await assert.rejects(save.execute({markdown:"伪造",references:[{reference:{runId:"source",taskId:"missing"}}]},context));
  const read=await source.read({...inputs[0],messageIndex:1},{offset:2,limit:2});assert.equal(read.text,"ss");assert.equal((read.evidence as {quote:string}[])[0].quote,"ss");
  await assert.rejects(source.read({...inputs[0],taskId:"wrong"}),/读取目标不明确/);
  const catalogue=await source.read(inputs[0],{limit:1});
  assert.equal(catalogue.unit,"messages");assert.equal(catalogue.nextOffset,1);assert.equal(catalogue.hasMore,true);
  const entries=catalogue.messages as {reference:AnalysisReference;preview:string;chars:number}[];
  const body=await source.read(entries[0].reference);
  assert.equal(body.unit,"characters");assert.equal(body.limit,8000);assert.equal(body.hasMore,false);assert.equal(body.nextOffset,null);
  assert.equal(entries[0].preview,(body.text as string).slice(0,160));assert.equal(entries[0].chars,body.total);
  assert.equal(read.unit,"characters");assert.equal(read.nextOffset,4);assert.equal(read.hasMore,true);
  const remainder=await source.read({...inputs[0],messageIndex:1},{offset:read.nextOffset as number});
  assert.equal(remainder.hasMore,false);assert.equal(remainder.nextOffset,null);
  const end=await source.read({...inputs[0],messageIndex:1},{offset:100000});
  assert.equal(end.text,"");assert.equal(end.hasMore,false);assert.equal(end.nextOffset,null);
  const state=await readFile(path.join(fixture.directory,"assistant/users/alice/sessions",scope.sessionId,"operations",operationId,"execution",operationId,"state.json"),"utf8");
  assert(!state.includes('"messages"'),"state keeps references, not original message bodies");
  assert(!JSON.stringify(read).includes("undefined"));
 }finally{await worker.close();await rm(fixture.directory,{recursive:true,force:true});}
});

test("three-model specialist runs share one criteria task and return all three real pair references", { timeout: 30000 }, async () => {
 const fixture = await fixtureConfig();
 const third = { ...fixture.config.inputs.versions.find(version => version.id === "a_fast")!,
  id: "c_fast", name: "C组Fast", sources: [{ kind: "file" as const, path: path.join(fixture.directory, "c_fast.jsonl") }] };
 fixture.config.inputs.versions.push(third);
 fixture.config.comparisons = [["a_fast", "b_fast", "c_fast"]];
 await writeJsonl(third.sources[0].path, [raw()]);
 const stages: string[] = [], standards: TaskAnalysis[] = [];
 const worker = await startWorker({ identity: fakeIdentity, async createSession(options) { return {
  async run() {
   const stage = options.spec.evaluation.id; stages.push(stage);
   const material = parsedMaterial(options.spec) as { task_analysis?: TaskAnalysis; candidates?: { instructions: { role: string }[]; context: { role: string }[] }[] };
   if (stage === "criteria") {
    assert(!("task_analysis" in material));
    assert(material.candidates!.every(candidate => candidate.context.every(message => message.role === "user")));
   } else standards.push(material.task_analysis!);
   const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
   assert.equal(result.isError, undefined, JSON.stringify(result));
  }, async abort() {}, async dispose() {},
 }; } }, path.join(fixture.directory, "worker"));
 try {
  const config = await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "http://127.0.0.1:1/v1" });
  config.evaluation = fixture.config; config.models = fixture.models;
  const plan = await buildPlan(fixture.config);
  await runEvaluation({ ...services, plan: { ...plan, tasks: [] }, runId: "source", output: fixture.config.output,
   engine: "pi", evaluatorVersion: config.evaluatorVersion, config: fixture.config, policy: fixture.config.execution,
   modelForStage: fixture.modelForStage, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], concurrency: 1 });
  const inputIds = Object.values(plan.tasks.find(task => task.stage === "criteria")!.inputIds);
  assert.equal(inputIds.length, 3);
  const gateway = new LocalSpecialists(path.join(fixture.directory, "assistant"), new LocalAnalysisData(fixture.config.output.path), config, false,
   { workerUrls: [worker.url], identity: fakeIdentity });
  const scope = { userId: "alice", sessionId: randomUUID() }, signal = new AbortController().signal;
  const operationId = randomUUID(), request = { operationId, kind: "comparison" as const,
   inputs: inputIds.map(inputId => ({ runId: "source", inputId })) };
  const accepted = await gateway.invoke(scope, request, signal);
  assert.equal(accepted.state, "succeeded", JSON.stringify(accepted));
  assert.deepEqual(stages.sort(), ["attribution", "attribution", "attribution", "comparison", "comparison", "comparison", "criteria"]);
  assert(standards.every(analysis => JSON.stringify(analysis) === JSON.stringify(standards[0])));
  const comparisons = (accepted.result as { comparisons: { reference: AnalysisReference; result: { models: Record<string, unknown> } }[] }).comparisons;
  assert.equal(comparisons.length, 3);
  assert.equal(new Set(comparisons.map(item => item.reference.taskId)).size, 3);
  const formal = new LocalAnalysisData(path.join(fixture.directory, "assistant/users/alice/sessions", scope.sessionId, "operations", operationId, "execution"));
  const pairs: string[] = [];
  for (const item of comparisons) {
   assert.equal(item.reference.runId, operationId);
   assert.deepEqual((await formal.read(item.reference)).result, item.result);
   const versions = Object.keys(item.result.models).sort();
   assert.equal(versions.length, 2);
   pairs.push(versions.join("/"));
  }
  assert.deepEqual(pairs.sort(), ["a_fast/b_fast", "a_fast/c_fast", "b_fast/c_fast"]);
  const before = stages.length;
  assert.deepEqual(await gateway.read(scope, operationId), accepted);
  assert.deepEqual(await gateway.invoke(scope, request, signal), accepted);
  assert.equal(stages.length, before);
  await assert.rejects(gateway.invoke(scope, { ...request, operationId: randomUUID(), inputs: [...request.inputs, request.inputs[0]] }, signal), /Invalid specialist inputs/);
 } finally { await worker.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("incompatible accepted attributions are independently reassessed without changing their receipts", { timeout: 30000 }, async () => {
 const fixture = await fixtureConfig();
 let revised = false;
 const stages: string[] = [];
 const worker = await startWorker({ identity: fakeIdentity, async createSession(options) { return {
  async run() {
   stages.push(options.spec.evaluation.id);
   const output = taskResult(options.spec);
   if (revised && options.spec.evaluation.id === "criteria")
    (output as TaskAnalysis).requirements[0]!.acceptance_rule = "明确给出题目2与2相加的完整结果4。";
   if (revised && options.spec.evaluation.id === "attribution")
    assert.deepEqual((parsedMaterial(options.spec) as { review_context: { reasons: string[] } }).review_context.reasons,
     ["已有归因与本次共享判据、标准答案或当前验证要求不一致，按本次判据独立重新核验。"]);
   const result = await options.execute("submit_evaluation", draftFor(options.spec, output));
   assert.equal(result.isError, undefined, JSON.stringify(result));
  }, async abort() {}, async dispose() {},
 }; } }, path.join(fixture.directory, "worker"));
 try {
  const config = await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "http://127.0.0.1:1/v1" });
  config.evaluation = fixture.config; config.models = fixture.models;
  const plan = await buildPlan(fixture.config);
  await runEvaluation({ ...services, plan: { ...plan, tasks: [] }, runId: "source", output: fixture.config.output,
   engine: "pi", evaluatorVersion: config.evaluatorVersion, config: fixture.config, policy: fixture.config.execution,
   modelForStage: fixture.modelForStage, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], concurrency: 1 });
  const gateway = new LocalSpecialists(path.join(fixture.directory, "assistant"), new LocalAnalysisData(fixture.config.output.path), config, false,
   { workerUrls: [worker.url], identity: fakeIdentity });
  const inputs = Object.values(plan.tasks.find(task => task.stage === "comparison")!.inputIds).map(inputId => ({ runId: "source", inputId }));
  const scope = { userId: "alice", sessionId: randomUUID() }, signal = new AbortController().signal;
  const originals = [];
  for (const input of inputs) {
   const operationId = randomUUID();
   const result = await gateway.invoke(scope, { kind: "attribution", operationId, inputs: [input] }, signal);
   assert.equal(result.state, "succeeded", JSON.stringify(result));
   originals.push({ inputId: input.inputId, operationId, result });
  }
  revised = true; stages.length = 0;
  const operationId = randomUUID();
  const result = await gateway.invoke(scope, { kind: "comparison", operationId, inputs,
   attributions: originals.map(({ inputId, operationId }) => ({ inputId, operationId })) }, signal);
  assert.equal(result.state, "succeeded", JSON.stringify(result));
  assert.deepEqual(stages.sort(), ["attribution", "attribution", "comparison", "criteria"]);
  for (const original of originals) assert.deepEqual(await gateway.read(scope, original.operationId), original.result);
  const before = stages.length;
  await assert.rejects(gateway.invoke(scope, { kind: "comparison", operationId: randomUUID(), inputs,
   attributions: [{ inputId: inputs[1].inputId, operationId: originals[0].operationId }] }, signal), /not an accepted result for this input/);
  assert.equal(stages.length, before);
  await assert.rejects(gateway.invoke(scope, { kind: "attribution", operationId: randomUUID(), inputs: [inputs[0]], attributions: [] }, signal), /does not accept attribution references/);
 } finally { await worker.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});
