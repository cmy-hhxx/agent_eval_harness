import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { emptyUsage, type RunState, type SubmissionReceipt, type WorkflowDefinition } from "@eval/contracts";
import { attributionResult, criteriaResult, emptyAudit, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";
import { comparisonWorkflow } from "./workflow.js";
import type { TaskData } from "./types.js";

for(const [modelCount,findingType] of [[2,"strength"],[2,"problem"],[3,"problem"]] as const)test(`each of ${modelCount} models owns one attribution despite unmatched ${findingType} findings`,async()=>{
 const fixture=await fixtureConfig([[raw()],[],[raw()],[]],false,true);
 try {
  if(modelCount===3){
   fixture.config.inputs.versions.push({...structuredClone(fixture.config.inputs.versions[0]),id:"third_fast",name:"第三方Fast"});
   fixture.config.comparisons=[["a_fast","b_fast","third_fast"]];
  }
  const plan=await buildPlan(fixture.config),criteria=plan.tasks.find(task=>task.stage==="criteria")!;
  const attributes=plan.tasks.filter(task=>task.stage==="attribution");
  const receipt=(taskId:string,evaluation:unknown,acceptedAt=1):SubmissionReceipt=>({taskId,evaluation,attemptId:taskId,submissionId:taskId,
   acceptedAt,status:"succeeded",evaluatorVersion:"fixture",judge:"fixture",audit:emptyAudit(),usage:emptyUsage()});
  const receipts:Record<string,SubmissionReceipt>={[criteria.id]:receipt(criteria.id,criteriaResult())};
  const state={manifest:{config:fixture.config,tasks:[...plan.tasks],states:Object.fromEntries(plan.tasks.map(task=>[task.id,{status:receipts[task.id]?"succeeded":"pending",attempts:0}]))},receipts} as unknown as RunState;
  const apply=(change:ReturnType<NonNullable<WorkflowDefinition["advance"]>>)=>{
   for(const replacement of change.replace??[])state.manifest.tasks[state.manifest.tasks.findIndex(task=>task.id===replacement.id)]=replacement;
   for(const added of change.tasks){state.manifest.tasks.push(added);state.manifest.states[added.id]={status:"pending",attempts:0};}
  };
  for(const task of attributes){
   const value=attributionResult(true,"2+2=4",true,task.inputIds.answer);value.findings[0].assessment.requirement_index=null;
   value.findings[0].type=findingType;
   if(findingType==="problem")value.findings[0].problem={component:[responsibilityFixture("回答模型", {evidence_ids: []})],label:"计算过程缺口",definition:"中间计算与最终结果的关系缺少说明。"};
   receipts[task.id]=receipt(task.id,value);state.manifest.states[task.id].status="succeeded";
   apply(comparisonWorkflow.advance!(task,receipts[task.id],state,plan.inputs));
  }
  const before=structuredClone(Object.fromEntries(attributes.map(task=>[task.id,receipts[task.id]])));
  assert.equal(state.manifest.tasks.filter(task=>task.stage==='attribution').length,modelCount);
  assert(!state.manifest.tasks.some(task=>(task.data as TaskData).reviewOf));
  for(const comparison of state.manifest.tasks.filter(task=>task.stage==='comparison'))
   for(const label of Object.keys((comparison.data as TaskData).candidates))
    assert(attributes.some(task=>task.id===comparison.dependencies[label]));
  for(const cluster of state.manifest.tasks.filter(task=>task.stage==='clustering')) {
   assert(comparisonWorkflow.canStart!(cluster,state.manifest));
   for(const [inputId,taskId]of Object.entries(cluster.dependencies))assert.equal(taskId,attributes.find(task=>task.inputIds.answer===inputId)!.id);
  }
  for(const task of attributes)assert.deepEqual(comparisonWorkflow.advance!(task,receipts[task.id],state,plan.inputs),{tasks:[]});
  assert.deepEqual(Object.fromEntries(attributes.map(task=>[task.id,receipts[task.id]])),before);
 }finally{await rm(fixture.directory,{recursive:true,force:true});}
});
