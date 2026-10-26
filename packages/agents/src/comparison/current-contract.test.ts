import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError,type AgentRequest,type ToolAudit} from '@eval/contracts';
import {comparisonProfile} from './index.js';
import {requestComparisonSubmission} from '../../../../tests/fixtures/comparison-submission.js';
import type {ComparisonInput,ComparisonResult} from './types.js';
import example from './fixtures/example.json' with {type:'json'};
const audit:ToolAudit={calls:0,requiredReadCalls:0,traceReads:[],viewedImages:[],calculations:[],artifacts:[]};
function fixture(){const request=structuredClone(example.request) as AgentRequest;
 const input=request.input as unknown as ComparisonInput;
 const draft=requestComparisonSubmission(request,structuredClone(example.result) as ComparisonResult);
 return {request,input,draft};}
function accept(request:AgentRequest,draft:unknown){const result=comparisonProfile.resolve!(request,draft,audit) as ComparisonResult;
 comparisonProfile.validate!(request,result,audit);return result;}
function rejected(fn:()=>unknown,code:string){assert.throws(fn,(error:unknown)=>error instanceof ValidationError&&!!error.issues?.some(item=>item.code===code));}
function problem(input:ComparisonInput,candidate='A',status:'已确认'|'待核实'='已确认'){
 input.attributions[candidate].Problem=[{problem_id:'p1',text:'回答数值错误',reason:'原问题要求4，回答提供5。',evidence_status:status,
  evidence:[{evidence_id:`ev_${input.candidates[candidate].candidate_id}_1_text_0_5_/content`,message_index:1,quote:'2+2=5'}]}];
}
test('comparison accepts independent met judgments with evidence-backed no-problem attributions',()=>{
 const {request,input,draft}=fixture(),before=structuredClone(input.attributions);
 assert(new Ajv2020({strict:false}).compile(comparisonProfile.requestSchema!)(request.input));
 const result=accept(request,draft);assert.equal(result.status,'decided');assert.deepEqual(result.ranking,[['A','B']]);assert.deepEqual(input.attributions,before);
});
test('comparison resolves rows by slot_index and rejects duplicate candidate cells',()=>{
 const request=structuredClone(example.request) as AgentRequest,input=request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=4;input.candidates.B.original_answer_timing.finish_seconds=6;
 const source=structuredClone(example.result) as ComparisonResult;
 source.decision_basis.comparisons.push({aspect:'原始完成时长',criterion_ids:[],importance:'low',better_candidates:[],assessments:{
  A:{summary:'A用时4秒。',finding_indices:[],status:'met',evidence_status:'已确认'},
  B:{summary:'B用时6秒。',finding_indices:[],status:'met',evidence_status:'已确认'}}});
 const draft=requestComparisonSubmission(request,source);draft.comparisons.reverse();
 const result=accept(request,draft);
 assert.deepEqual(result.decision_basis.comparisons.map(row=>row.criterion_ids), [['sum'],[]]);
 const duplicate=structuredClone(draft);duplicate.comparisons.find(row=>row.slot_index===0)!.assessments![1]!.candidate='A';
 rejected(()=>accept(request,duplicate),'comparison_cell_duplicate');
});
test('comparison records existing defect as common core failure without an attribution core field',()=>{
 const {request,input,draft}=fixture();problem(input);
 const assessment=draft.assessments.find(item=>item.candidate==='A')!;
 Object.assign(assessment,{meets_core:false,core_failure_refs:['sum'],summary:'加法结果不可用。'});
 Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!,{status:'unmet',evidence_status:'已确认',finding_indices:[0],summary:'现有问题证明加法结果错误。'});
 draft.relative_preference='B';const result=accept(request,draft);assert.deepEqual(result.ranking,[['B'],['A']]);assert.deepEqual(result.assessments.A.core_failure_refs,['sum']);
});
test('comparison rejects confirmed failed requirement without a registered Problem',()=>{
 const {request,draft}=fixture();draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.status='partial';
 rejected(()=>accept(request,draft),'comparison_defect_unregistered');
});
test('comparison core failure cannot rest on a low-importance requirement',()=>{
 const {request,input,draft}=fixture();problem(input);
 draft.comparisons[0]!.importance='low';
 Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!,{status:'unmet',evidence_status:'已确认',finding_indices:[0]});
 Object.assign(draft.assessments.find(item=>item.candidate==='A')!,{meets_core:false,core_failure_refs:['sum'],summary:'加法结果不可用。'});
 draft.relative_preference='B';
 rejected(()=>accept(request,draft),'core_failure_unproven');
});
test('uncertain attribution evidence cannot be promoted to established comparison evidence',()=>{
 const {request,input,draft}=fixture();problem(input,'A','待核实');draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.finding_indices=[0];
 rejected(()=>accept(request,draft),'finding_evidence_strengthened');
});
test('comparison cannot cite another or nonexistent problem position',()=>{
 const {request,draft}=fixture();draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.finding_indices=[19];
 rejected(()=>accept(request,draft),'finding_missing');
});
test('source disagreement remains needs_review without ranking or rewriting accepted judgments',()=>{
 const {request,input,draft}=fixture(),before=structuredClone(input.attributions);
 draft.source_reviews=[{slot_index:0,candidate:'A',reason:'原文交付与归因结论存在具体冲突，需要来源核验。'}];draft.relative_preference=null;draft.quality_winner=null;
 const result=accept(request,draft);assert.equal(result.status,'needs_review');assert.deepEqual(result.ranking,[]);assert.deepEqual(input.attributions,before);
});
test('unknown core remains pending and cannot become both_good',()=>{
 const {request,draft}=fixture(),assessment=draft.assessments.find(item=>item.candidate==='A')!;
 assessment.meets_core=null;assessment.summary='关键交付的必要来源尚不能核实。';draft.relative_preference=null;
 const result=accept(request,draft);assert.equal(result.status,'needs_review');assert.deepEqual(result.ranking,[]);
});
test('reference mismatch alone does not set whole-answer core failure',()=>{
 const {request,input,draft}=fixture();input.attributions.A.is_correct=false;input.attributions.A.correct_reason='给定标准与已核实交付口径不同。';
 assert.equal(accept(request,draft).assessments.A.meets_core,true);
});
test('private requirement cannot support cross-candidate advantage',()=>{
 const {request,input,draft}=fixture();input.task_analysis.requirements[0].applies_to=[input.candidates.A.candidate_id];
 draft.comparisons[0]!.better_candidate='A';draft.comparisons[0]!.assessments!.find(item=>item.candidate==='B')!.status='not_applicable';
 rejected(()=>accept(request,draft),'comparison_advantage_scope_mismatch');
});
test('comparison cannot name the candidate with the worse confirmed status as better',()=>{
 const {request,input,draft}=fixture();problem(input,'B');
 draft.comparisons[0]!.better_candidate='B';
 Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!,{status:'met',finding_indices:[]});
 Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate==='B')!,{status:'partial',finding_indices:[0]});
 rejected(()=>accept(request,draft),'comparison_advantage_unproven');
});
test('formal resource advantage must match measured dominance',()=>{
 const {request,input}=fixture();
 input.candidates.A.original_answer_timing.finish_seconds=10;
 input.candidates.B.original_answer_timing.finish_seconds=20;
 const result=comparisonProfile.resolve!(request,requestComparisonSubmission(request,structuredClone(example.result) as ComparisonResult),audit) as ComparisonResult;
 comparisonProfile.validate!(request,result,audit);
 const resource=result.decision_basis.comparisons.at(-1)!;
 resource.better_candidates=['B'];
 rejected(()=>comparisonProfile.validate!(request,result,audit),'comparison_resource_direction_invalid');
});
