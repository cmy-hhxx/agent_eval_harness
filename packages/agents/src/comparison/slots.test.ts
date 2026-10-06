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
test("fixed rows reject missing or extra positions and do not accept program-owned state",()=>{
 const f=setup();f.draft.comparisons=[];assert.throws(()=>f.registry.resolve(f.binding,f.draft,audit));
 const fresh=setup();Object.assign(fresh.draft.comparisons[0]!,{status:'met'});
 assert.throws(()=>fresh.registry.resolve(fresh.binding,fresh.draft,audit),/additional properties/);
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
 draft.comparisons[index]={importance:'medium',better_candidate:'A',a_summary:'完成用时2秒。',b_summary:'没有耗时数据。'};
 assert.throws(()=>f.registry.resolve(f.binding,draft,audit),/双方同种有效指标/);
});
test("submission rows are flat and bounded without repeating full schemas for each slot",()=>{
 const f=setup(),schema=comparisonProfile.modelSubmissionSchema!(f.request) as any;
 assert(!schema.properties.comparisons.prefixItems);
 assert.deepEqual(Object.keys(schema.properties.comparisons.items.properties).sort(),['a_summary','b_summary','better_candidate','importance']);
 assert.equal(schema.properties.comparisons.minItems,comparisonSlots(f.request).length);
});
