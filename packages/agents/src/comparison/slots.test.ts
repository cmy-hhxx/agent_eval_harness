import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
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
 Object.assign(finding,{problem:{diagnosis: "other" as const, investigation: [], component:[responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: []})],label:'推导错误',definition:'关键中间计算与交付不一致。'}});
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
  problem:{diagnosis: "other" as const, investigation: [], component:[responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: []})],label:'附加计算错误',definition:'容斥计算与所列并集不符。'}});
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
test("direct resolution reserves derived cell prose for the program",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=1;
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 const slots=comparisonSlots(f.request),criterion=slots.findIndex(slot=>slot.kind==='criterion'),resource=slots.findIndex(slot=>slot.kind==='resource');
 const accepted=structuredClone(draft);
 draft.comparisons[criterion]={importance:'low'};
 assert.equal((comparisonProfile.resolve!(f.request,draft,audit) as ComparisonResult).status,'decided');
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
 draft.comparisons[index]={importance:'low'};
 const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 assert.deepEqual(result.decision_basis.comparisons.find(row=>row.aspect==='原始完成时长与用量')!.better_candidates,[]);
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
 draft.comparisons[index]={importance:'low'};
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
 assert.deepEqual(slot.advantage_candidates,['A']);
 assert.deepEqual(slot.resource_metrics,{A:{finish_seconds:null,total_tokens:120},B:{finish_seconds:null,total_tokens:140}});
 assert.deepEqual(slot.comparable_metrics,['total_tokens']);
});
test("submission slots reuse typed row definitions and reserve resource prose for the program",()=>{
 const f=setup(),schema=comparisonProfile.modelSubmissionSchema!(f.request) as any;
 assert.deepEqual(schema.properties.comparisons.prefixItems,comparisonSlots(f.request).map(slot=>({$ref:`#/$defs/${slot.kind==='resource'?'resource':'commentary'}`})));
 assert.deepEqual(Object.keys(schema.$defs.commentary.properties).sort(),['better_candidate','importance']);
 assert.deepEqual(Object.keys(schema.$defs.resource.properties).sort(),['importance']);
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
 draft.comparisons[index]={importance:'low'};
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

test("MCHP recorded resources derive the faster and lower-usage side without a model direction",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 input.candidates.A.original_answer_timing.finish_seconds=48.241;
 input.candidates.A.original_answer_usage.total_tokens=60656;
 input.candidates.B.original_answer_timing.finish_seconds=204.16;
 input.candidates.B.original_answer_usage.total_tokens=120454;
 const index=comparisonSlots(f.request).findIndex(slot=>slot.kind==='resource');
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 draft.comparisons[index]={importance:'low'};
 const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 assert.deepEqual(result.decision_basis.comparisons.find(row=>row.aspect==='原始完成时长与用量')!.better_candidates,['A']);
 assert.deepEqual(result.ranking,[['A','B']],'a low resource advantage does not choose the overall winner');
});

test("resource direction uses only common metrics and stays empty for equal or opposing measurements",()=>{
 const cases=[
  {seconds:[10,20],tokens:[200,100],better:[]},
  {seconds:[10,10],tokens:[100,100],better:[]},
  {seconds:[null,10],tokens:[100,200],better:['A']},
  {seconds:[10,null],tokens:[null,200],better:[]},
  {seconds:[0,10],tokens:[null,null],better:['A']},
  {seconds:[10,10],tokens:[100,200],better:['A']},
 ];
 for(const row of cases) {
  const f=setup(),input=f.request.input as unknown as ComparisonInput;
  for(const [index,label] of ['A','B'].entries()) {
   input.candidates[label].original_answer_timing.finish_seconds=row.seconds[index];
   input.candidates[label].original_answer_usage.total_tokens=row.tokens[index];
  }
  const slots=comparisonSlots(f.request),index=slots.findIndex(slot=>slot.kind==='resource');
  const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
  draft.comparisons[index]={importance:'low'};
  const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
  f.registry.validate(f.binding,result,audit);
  assert.deepEqual(result.decision_basis.comparisons.find(item=>item.aspect==='原始完成时长与用量')!.better_candidates,row.better);
  assert.deepEqual(comparisonSlotChoices(f.request)[index].advantage_candidates,row.better);
 }
});

test("Topu time and risk cells present their own accepted facts instead of shifted model prose",()=>{
 const f=setup(),input=f.request.input as unknown as ComparisonInput;
 const time='估值部分使用2026年10月12日的股价、市值和估值数据，符合题目所给的当前时点。';
 const risk='回答给出配置安全边际、建议不宜重仓及参与逻辑，属于投资建议；开头直接给结论，没有先提示投资风险。';
 input.task_analysis.requirements.push(
  {id:'r2',text:'将当前估值按2026-10-12时点评估。',acceptance_rule:'将当前估值按2026-10-12时点评估。',applies_to:[input.candidates.A.candidate_id]},
  {id:'r3',text:'投资类建议须在回答开头提示投资风险。',acceptance_rule:'投资类建议须在回答开头提示投资风险。',applies_to:[input.candidates.A.candidate_id]});
 for(const label of ['A','B']) {
  input.attributions[label].task_analysis=structuredClone(input.task_analysis);
  f.request.input.attributions[label as 'A'|'B'].criterion_assessments.push(
   {criterion_id:'r2',status:label==='A'?'met':'not_applicable',evidence_status:'established',summary:label==='A'?time:'这项要求不适用于本回答。',evidence:[]},
   {criterion_id:'r3',status:label==='A'?'unmet':'not_applicable',evidence_status:'established',summary:label==='A'?risk:'这项要求不适用于本回答。',evidence:[]});
 }
 const draft=requestComparisonSubmission(f.request,example.result as ComparisonResult);
 const slots=comparisonSlots(f.request),timeIndex=slots.findIndex(slot=>slot.criterion_ids.includes('r2')),
  riskIndex=slots.findIndex(slot=>slot.criterion_ids.includes('r3'));
 draft.comparisons[timeIndex]={importance:'low'};
 draft.comparisons[riskIndex]={importance:'low'};
 const result=f.registry.resolve(f.binding,draft,audit) as ComparisonResult;
 f.registry.validate(f.binding,result,audit);
 const timeRow=result.decision_basis.comparisons.find(row=>row.criterion_ids.includes('r2'))!,
  riskRow=result.decision_basis.comparisons.find(row=>row.criterion_ids.includes('r3'))!;
 assert.equal(timeRow.assessments.A.summary,time);
 assert.equal(riskRow.assessments.A.summary,risk);
 assert(!timeRow.assessments.A.summary.includes('投资风险'));
 assert(!riskRow.assessments.A.summary.includes('敏感性'));
 assert.equal(timeRow.assessments.B.status,'not_applicable');
 assert.equal(riskRow.assessments.B.status,'not_applicable');
});
