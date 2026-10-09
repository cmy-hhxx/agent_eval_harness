import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError } from "@eval/contracts";
import { comparisonAgent,comparisonProfile,comparisonSlots,type ComparisonResult,type ComparisonInput } from "./index.js";
import { comparisonSlotCellState,comparisonSlotChoices } from "./slots.js";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import example from "./fixtures/example.json" with { type:"json" };
const audit={calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[]};
function setup(){const request=structuredClone(example.request),registry=new AgentRegistry([comparisonAgent]);return {request,registry,binding:{agent:"comparison",profile:"default",request},draft:requestComparisonSubmission(request,example.result as ComparisonResult)};}

test("independent strengths preserve confirmed cells without blocking a comparison or becoming an advantage",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.attributions.A.findings[0].assessment.requirement_index=null;
 const slots=comparisonSlots(f.request),row=slots.find(row=>row.kind==='criterion')!;
 assert(slots.every(row=>row.kind==='criterion'||row.kind==='resource'));
 assert.equal(comparisonSlotCellState(input,'B',row).status,'met');
 const result=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 assert.equal(result.status,'decided');
 assert.deepEqual(result.review_requests,[]);
 assert(!result.decision_basis.decisive_findings.some(item=>item.candidate==='A'&&item.finding_index===0));
 assert(input.attributions.A.findings[0],"the source observation remains intact");
 const finding=input.attributions.A.findings[0];finding.type='problem';finding.importance='high';
 Object.assign(finding,{problem:{component:['模型自身推理'],label:'推导错误',definition:'关键中间计算与交付不一致。'}});
 const pending=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 assert.equal(pending.status,'needs_review');
 assert(pending.review_requests.some(item=>item.candidate==='A'&&item.finding_indices.includes(0)));
});
test("aligned source facts permit a decision without requiring matching finding labels",()=>{
 const f=setup(); f.request.input.attributions.B.findings[0].text='已经交付4。';
 const value=f.registry.resolve(f.binding,f.draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,value,audit);assert.equal(value.status,'decided');
 assert(value.decision_basis.comparisons.every(row=>Object.values(row.assessments).every(cell=>cell.status!=='unknown')));
});
test("low-impact independent observations remain in attribution without manufacturing peer cells",()=>{
 const f=setup(),finding=(f.request.input as unknown as ComparisonInput).attributions.A.findings[0];
 finding.assessment.requirement_index=null;finding.importance='low';
 const result=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 assert.equal(result.status,'decided');assert(comparisonSlots(f.request).every(row=>row.kind==='criterion'||row.kind==='resource'));
});
test("an additional unmapped error cannot erase already established failures on both sides",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 for(const attribution of Object.values(input.attributions)) {
  attribution.core_assessment.meets_core=false;
  attribution.core_assessment.reason='所求结果已确认错误。';
  attribution.criterion_assessments[0].status='unmet';
  attribution.criterion_assessments[0].evidence_status='established';
 }
 const finding=input.attributions.A.findings[0];
 Object.assign(finding,{type:'problem',importance:'medium',text:'附加交集表的并集计算错误。',
  problem:{component:['模型自身推理'],label:'附加计算错误',definition:'容斥计算与所列并集不符。'}});
 finding.assessment.requirement_index=null;
 const result=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 assert.equal(result.status,'decided');
 assert.deepEqual(result.ranking,[['A','B']]);
 assert.deepEqual(result.review_requests,[]);
 assert.equal(result.assessments.A.meets_core,false);
 assert.equal(input.attributions.A.findings[0].text,finding.text);
 input.source_review={A:[{kind:'unresolved_conflict',reason:'核心来源仍有未解决冲突。',requires_review:true}]};
 const conflict=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 assert.equal(conflict.status,'needs_review','known source conflicts must remain pending even when both cores failed');
 delete input.source_review;
 input.attributions.A.core_assessment.meets_core=null;
 const pending=f.registry.resolve(f.binding,requestComparisonSubmission(f.request,example.result as ComparisonResult),audit) as ComparisonResult;
 assert.equal(pending.status,'needs_review','actual core uncertainty must remain pending');
});
test("fixed rows reject missing or extra positions and do not accept program-owned state",()=>{
 const f=setup();f.draft.comparisons=[];assert.throws(()=>f.registry.resolve(f.binding,f.draft,audit));
 const fresh=setup();Object.assign(fresh.draft.comparisons[0]!,{status:'met'});
 assert.throws(()=>fresh.registry.resolve(fresh.binding,fresh.draft,audit),/additional properties/);
});
test("direct resolution enforces the same row ownership as the model submission",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=1;
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 const slots=comparisonSlots(f.request),criterion=slots.findIndex(slot=>slot.kind==='criterion'),resource=slots.findIndex(slot=>slot.kind==='resource');
 const accepted=structuredClone(draft);
 draft.comparisons[criterion]={importance:'medium'};
 assert.throws(()=>comparisonProfile.resolve!(f.request,draft,audit),error=>error instanceof ValidationError&&
  error.issues!.some(issue=>issue.path===`/comparisons/${criterion}/a_summary`));
 Object.assign(accepted.comparisons[resource]!,{a_summary:'这不是资源数据。',b_summary:'这不是资源数据。'});
 assert.throws(()=>comparisonProfile.resolve!(f.request,accepted,audit),/additional properties/);
});
test("source uncertainty cannot become a comparative advantage",()=>{
 const f=setup();f.request.input.attributions.B.criterion_assessments[0].evidence_status='uncertain';
 f.draft.comparisons[0]!.better_candidate='A';
 assert.throws(()=>f.registry.resolve(f.binding,f.draft,audit),error=>error instanceof ValidationError&&
  error.issues!.some(issue=>issue.code==="comparison_advantage_unproven"&&issue.path==="/comparisons/0/better_candidate"));
});
test("only shared metrics can support a resource advantage",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=2; input.candidates.B.original_answer_timing.finish_seconds=null;
 for(const candidate of Object.values(input.candidates))candidate.original_answer_usage.total_tokens=null;
 const slots=comparisonSlots(f.request),index=slots.findIndex(slot=>slot.kind==='resource');
 assert(index>=0);assert.deepEqual(comparisonSlotChoices(f.request)[index].advantage_candidates,[]);
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 draft.comparisons[index]={importance:'medium',better_candidate:'A'};
 assert.throws(()=>f.registry.resolve(f.binding,draft,audit),/双方同种有效指标/);
});
test("recorded resource metrics require a row even when both candidates use the same amount",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 for(const candidate of Object.values(input.candidates)) {
  candidate.original_answer_timing.finish_seconds=0; candidate.original_answer_usage.total_tokens=0;
 }
 const slots=comparisonSlots(f.request),index=slots.findIndex(slot=>slot.kind==='resource');
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 draft.comparisons[index]=null;
 assert.throws(()=>f.registry.resolve(f.binding,draft,audit));
 draft.comparisons[index]={importance:'low',better_candidate:null};
 const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 assert(result.decision_basis.comparisons.some(row=>row.aspect==='原始完成时长与用量'));
});
test("a cache anomaly does not hide valid total tokens or make their reporting methods incomparable",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 for(const candidate of Object.values(input.candidates)) candidate.original_answer_timing.finish_seconds=null;
 Object.assign(input.candidates.A.original_answer_usage,{total_tokens:120,total_tokens_basis:'reported',issues:['缓存输入 token 超过输入 token，不能比较缓存量']});
 Object.assign(input.candidates.B.original_answer_usage,{total_tokens:140,total_tokens_basis:'input_plus_output'});
 const slot=comparisonSlotChoices(f.request).find(slot=>slot.kind==='resource')!;
 assert.deepEqual(slot.advantage_candidates,['A','B']);
 assert.deepEqual(slot.resource_metrics,{A:{finish_seconds:null,total_tokens:120},B:{finish_seconds:null,total_tokens:140}});
 assert.deepEqual(slot.comparable_metrics,['total_tokens']);
});
test("submission slots reuse typed row definitions and reserve resource prose for the program",()=>{
 const f=setup(),schema=comparisonProfile.modelSubmissionSchema!(f.request) as any;
 assert.deepEqual(schema.properties.comparisons.prefixItems,comparisonSlots(f.request).map(slot=>({$ref:`#/$defs/${slot.kind==='resource'?'resource':'commentary'}`})));
 assert.deepEqual(Object.keys(schema.$defs.commentary.properties).sort(),['a_summary','b_summary','better_candidate','importance']);
 assert.deepEqual(Object.keys(schema.$defs.resource.properties).sort(),['better_candidate','importance']);
 assert.equal(schema.properties.comparisons.minItems,comparisonSlots(f.request).length);
});

test("resource summaries preserve measured values and missing data independently of authored commentary",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=16.652;
 input.candidates.A.original_answer_usage.total_tokens=22264;
 input.candidates.B.original_answer_timing.finish_seconds=10.706;
 input.candidates.B.original_answer_usage.total_tokens=11599;
 const index=comparisonSlots(f.request).findIndex(slot=>slot.kind==='resource');
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 draft.comparisons[index]={importance:'low',better_candidate:'B'};
 const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 const row=result.decision_basis.comparisons.find(row=>!row.criterion_ids.length)!;
 assert.equal(row.assessments.A.summary,'完成耗时：16.652 秒；总 token：22264。');
 assert.equal(row.assessments.B.summary,'完成耗时：10.706 秒；总 token：11599。');
 assert.equal(row.importance,'low'); assert.deepEqual(row.better_candidates,['B']);
 Object.assign(draft.comparisons[index]!,{a_summary:'盘中报价并非当日收盘价。',b_summary:'节省91.9%。'});
 assert.throws(()=>f.registry.resolve(f.binding,draft,audit),/additional properties/);
 draft.comparisons[index]={importance:'low'};
 input.candidates.B.original_answer_timing.finish_seconds=null;
 input.candidates.B.original_answer_usage.total_tokens=null;
 const missing=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 assert.equal(missing.decision_basis.comparisons.find(row=>!row.criterion_ids.length)!.assessments.B.summary,'完成耗时：无有效记录；总 token：无有效记录。');
});
