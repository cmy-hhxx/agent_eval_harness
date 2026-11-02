import test from 'node:test';
import assert from 'node:assert/strict';
import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError,type AgentRequest,type ToolAudit} from '@eval/contracts';
import {comparisonProfile,comparisonSlotChoices} from './index.js';
import {requestComparisonSubmission,flatComparisonSubmission} from '../../../../tests/fixtures/comparison-submission.js';
import type {ComparisonInput,ComparisonResult,ComparisonSubmission} from './types.js';
import example from './fixtures/example.json' with {type:'json'};
const audit:ToolAudit={calls:0,requiredReadCalls:0,traceReads:[],viewedImages:[],calculations:[],artifacts:[]};
function fixture(){const request=structuredClone(example.request) as AgentRequest;
 const input=request.input as unknown as ComparisonInput;
 const draft=requestComparisonSubmission(request,structuredClone(example.result) as ComparisonResult);
 return {request,input,draft};}
function accept(request:AgentRequest,draft:ComparisonSubmission){const result=comparisonProfile.resolve!(request,flatComparisonSubmission(draft),audit) as ComparisonResult;
 comparisonProfile.validate!(request,result,audit);return result;}
function rejected(fn:()=>unknown,code:string){assert.throws(fn,(error:unknown)=>error instanceof ValidationError&&!!error.issues?.some(item=>item.code===code));}
function problem(input:ComparisonInput,candidate='A',status:'已确认'|'待核实'='已确认'){
 input.attributions[candidate].Problem=[{problem_path:'/turns/0/problem/0',text:'回答数值错误',reason:'原问题要求4，回答提供5。',evidence_status:status,
  evidence:[{evidence_id:`ev_${input.candidates[candidate].candidate_id}_1_text_0_5_/content`,message_index:1,quote:'2+2=5'}]}];
}
test('comparison accepts independent met judgments with evidence-backed no-problem attributions',()=>{
 const {request,input,draft}=fixture(),before=structuredClone(input.attributions);
 assert(new Ajv2020({strict:false}).compile(comparisonProfile.requestSchema!)(request.input));
 const result=accept(request,draft);assert.equal(result.status,'decided');assert.deepEqual(result.ranking,[['A','B']]);assert.deepEqual(input.attributions,before);
});
test('default comparison accepts attribution conclusions without reading deferred original delivery',()=>{
 const {request,input,draft}=fixture();
 input.candidates.A.deferred_final_material=[{message_index:1,path:'/content',total_chars:30000}];
 assert.deepEqual(comparisonProfile.toolNames,[]);
 assert.equal(comparisonProfile.requiredReads,undefined);
 assert.equal(accept(request,draft).status,'decided');
});
test('comparison resolves flat rows by slot_index and rejects nested candidate cells',()=>{
 const request=structuredClone(example.request) as AgentRequest,input=request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=4;input.candidates.B.original_answer_timing.finish_seconds=6;
 const source=structuredClone(example.result) as ComparisonResult;
 source.decision_basis.comparisons.push({aspect:'原始完成时长',criterion_ids:[],importance:'low',better_candidates:[],assessments:{
  A:{summary:'A用时4秒。',finding_indices:[],status:'met',evidence_status:'已确认'},
  B:{summary:'B用时6秒。',finding_indices:[],status:'met',evidence_status:'已确认'}}});
 const draft=requestComparisonSubmission(request,source);draft.comparisons.reverse();
 const result=accept(request,draft);
 assert.deepEqual(result.decision_basis.comparisons.map(row=>row.criterion_ids), [['sum'],[]]);
 assert.throws(()=>comparisonProfile.resolve!(request,draft,audit),ValidationError);
});
test('comparison schema groups row kinds while rejecting wrong kind and unknown slot',()=>{
 const {request,input,draft}=fixture();
 for(let i=0;i<20;i++) input.task_analysis.requirements.push({...input.task_analysis.requirements[0],id:`extra-${i}`});
 const schema=comparisonProfile.modelSubmissionSchema!(request) as any;
 assert.equal(schema.properties.comparisons.items.oneOf.length,1);
 const validate=new Ajv2020({strict:false}).compile(schema.properties.comparisons.items);
 const row:Record<string,unknown>=flatComparisonSubmission(draft).comparisons[0];
 const unknown={...row,slot_index:1000},nested={...row,kind:'resource'};
 assert(validate(row));
 assert(!validate(unknown));
 assert(!validate(nested));
});
test('comparison records existing defect as common core failure without an attribution core field',()=>{
 const {request,input,draft}=fixture();problem(input);
 const assessment=draft.assessments.find(item=>item.candidate==='A')!;
 Object.assign(assessment,{meets_core:false,core_failure_refs:['sum'],summary:'加法结果不可用。'});
 Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!,{status:'unmet',evidence_status:'已确认',finding_indices:[0],summary:'现有问题证明加法结果错误。'});
 draft.relative_preference='B';const result=accept(request,draft);assert.deepEqual(result.ranking,[['B'],['A']]);assert.deepEqual(result.assessments.A.core_failure_refs,['sum']);
});
test('confirmed unmet core requirements cannot coexist with usable core, while partial defects can',()=>{
 const {request,input,draft}=fixture();problem(input);
 const cell=draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!;
 Object.assign(cell,{status:'unmet',finding_indices:[0]});
 rejected(()=>accept(request,draft),'core_met_contradiction');
 cell.status='partial';
 assert.equal(accept(request,draft).assessments.A.meets_core,true);
});
test('one-sided material advantage must produce a winner but low-impact differences remain ties',()=>{
 const {request,draft}=fixture();
 draft.comparisons[0]!.importance='medium';draft.comparisons[0]!.better_candidate='B';
 rejected(()=>accept(request,draft),'ranking_advantage_ignored');
 draft.quality_winner='B';draft.relative_preference='B';
 assert.deepEqual(accept(request,draft).ranking,[['B'],['A']]);
 draft.comparisons[0]!.importance='low';
 rejected(()=>accept(request,draft),'quality_winner_unproven');
 draft.quality_winner=null;
 assert.deepEqual(accept(request,draft).ranking,[['A','B']]);
});
test('opposing material advantages may remain a tie after weighing the actual tradeoff',()=>{
 const {request,input,draft}=fixture();
 input.task_analysis.scoring_points.push({id:'clarity',text:'解释便于使用。',applies_to:[],acceptance_rule:'说明计算方法。'});
 draft.comparisons[0]!.better_candidate='A';
 draft.comparisons.push({...structuredClone(draft.comparisons[0]!),slot_index:1,better_candidate:'B'});
 draft.quality_winner=null;draft.relative_preference=null;
 draft.tradeoff='两方答案均可用；一方核算更充分，另一方步骤更清楚，两项交付优势相当。';
 assert.deepEqual(accept(request,draft).ranking,[['A','B']]);
});
test('both failed answers can have a relative winner without citing their shared failure as a winning difference',()=>{
 for(const winner of ['A','B'] as const){
  const {request,input,draft}=fixture(),loser=winner==='A'?'B':'A';
  for(const candidate of ['A','B']){
   problem(input,candidate);
   Object.assign(draft.assessments.find(item=>item.candidate===candidate)!,{meets_core:false,core_failure_refs:['sum'],summary:'未给出所求结果。'});
   Object.assign(draft.comparisons[0]!.assessments!.find(item=>item.candidate===candidate)!,{status:'unmet',finding_indices:[0]});
  }
  input.attributions[loser].Problem.push({...structuredClone(input.attributions[loser].Problem[0]!),problem_path:'/turns/0/problem/1',text:'无来源却编造结果',reason:'未查询到所求结果，却给出无来源数字。'});
  input.task_analysis.scoring_points.push({id:'reliability',text:'如实说明数据缺口。',applies_to:[],acceptance_rule:'不把无依据的数值当事实。'});
  draft.comparisons.push({slot_index:1,kind:'criterion',importance:'medium',better_candidate:winner,assessments:[
   {candidate:winner,status:'met',evidence_status:'已确认',finding_indices:[],summary:'如实说明未查询到结果。'},
   {candidate:loser,status:'partial',evidence_status:'已确认',finding_indices:[1],summary:'额外编造了结果数字。'},
  ]});
  const before=structuredClone(input.attributions);
  rejected(()=>accept(request,draft),'ranking_advantage_ignored');
  draft.quality_winner=winner;draft.relative_preference=winner;
  draft.tradeoff=`双方都未给出可核实结果；【候选${winner}】如实说明缺口，【候选${loser}】编造数字会误导使用，因此前者相对更好。`;
  const result=accept(request,draft);
  assert.deepEqual(result.ranking,[[winner],[loser]]);
  assert(Object.values(result.assessments).every(item=>item.meets_core===false));
  assert.deepEqual(result.decision_basis.decisive_findings,[{candidate:loser,finding_index:1}]);
  assert.deepEqual(input.attributions,before);
  draft.comparisons[1]!.better_candidate=null;
  rejected(()=>accept(request,draft),'quality_winner_unproven');
  draft.quality_winner=null;draft.relative_preference=null;
  assert.deepEqual(accept(request,draft).ranking,[['A','B']]);
 }
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
test('comparison derives uncertainty from accepted findings without asking the model to repeat it',()=>{
 const {request,input,draft}=fixture();problem(input,'A','待核实');draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.finding_indices=[0];
 const before=structuredClone(input.attributions),result=accept(request,draft);
 assert.equal(result.decision_basis.comparisons[0].assessments.A.evidence_status,'待核实');
 assert.deepEqual(input.attributions,before);
});
test('unknown comparison status mechanically stays unverified and cannot support an advantage',()=>{
 const {request,draft}=fixture();draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.status='unknown';
 const flat=flatComparisonSubmission(draft);
 assert(!Object.hasOwn(flat.comparisons[0],'a_evidence'));
 assert(!Object.hasOwn(flat.comparisons[0],'b_evidence'));
 assert.equal(accept(request,draft).decision_basis.comparisons[0].assessments.A.evidence_status,'待核实');
 draft.comparisons[0]!.better_candidate='B';
 rejected(()=>accept(request,draft),'comparison_advantage_unproven');
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
test('local uncertainty and small resource differences do not require a preference or source review',()=>{
 const {request,input,draft}=fixture();
 draft.comparisons[0]!.assessments!.find(item=>item.candidate==='A')!.status='unknown';
 draft.relative_preference=null;draft.quality_winner=null;
 const result=accept(request,draft);
 assert.equal(result.status,'decided');assert.deepEqual(result.review_requests,[]);
 assert.deepEqual(result.ranking,[['A','B']]);
 input.candidates.A.original_answer_timing.finish_seconds=1.885;
 input.candidates.B.original_answer_timing.finish_seconds=1.846;
 const resourceDraft=requestComparisonSubmission(request,structuredClone(example.result) as ComparisonResult);
 resourceDraft.relative_preference=null;resourceDraft.quality_winner=null;
 assert.equal(accept(request,resourceDraft).status,'decided');
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
 const result=comparisonProfile.resolve!(request,flatComparisonSubmission(requestComparisonSubmission(request,structuredClone(example.result) as ComparisonResult)),audit) as ComparisonResult;
 comparisonProfile.validate!(request,result,audit);
 const resource=result.decision_basis.comparisons.at(-1)!;
 resource.better_candidates=['B'];
 rejected(()=>comparisonProfile.validate!(request,result,audit),'comparison_resource_direction_invalid');
});

test('comparison slot payload does not multiply accepted findings by criterion count',()=>{
 const {request,input}=fixture();problem(input);
 const before=JSON.stringify(comparisonSlotChoices(request));
 input.attributions.A.Problem[0]!.reason='完整归因证据'.repeat(10000);
 assert.equal(JSON.stringify(comparisonSlotChoices(request)),before);
 assert.equal(input.attributions.A.Problem[0]!.reason.length,60000);
});
