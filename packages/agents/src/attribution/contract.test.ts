import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ValidationError,type ToolAudit} from '@eval/contracts';
import {AgentRegistry} from '@eval/host';
import {bindAttributionMaterial} from '@eval/workflows/review';
import type {Candidate} from '@eval/workflows/inputs';
import {attributionAgent,type AttributionResult} from './index.js';
import {attributionSubmissionSchema} from './submission-schema.js';
import {resolveModelSubmission} from './submission.js';
import {responsibilityDisplay} from './responsibility.js';
import {validateEvaluation} from './validate.js';
import {attributionSubmission} from '../../../../tests/fixtures/attribution-submission.js';
import {businessChainFixture} from '../../../../tests/fixtures/business-chain.js';
function plain(reference:unknown=null){
 const id=randomUUID(),question='计算2+2',answer='2+2=4';
 const candidate={input_id:id,version:'test',name:'test',question,final_index:1,reference,llm:null,trace_id:null,answer_timing:{finish_seconds:null}} as Candidate;
 const binding=bindAttributionMaterial(candidate,{messages:[{role:'user',content:question},{role:'assistant',content:answer}]});
 const registry=new AgentRegistry([attributionAgent]),prepared=registry.prepare(binding);
 const audit:ToolAudit={calls:0,requiredReadCalls:0,traceReads:[{candidate:'answer',message_index:1,kind:'text',path:'/content',start:0,end:answer.length}],viewedImages:[],calculations:[],artifacts:[],evidenceBank:prepared.evidenceBank};
 return {binding,registry,audit};
}
test('model contract omits program identity, correctness availability and all removed forms',()=>{
 const f=plain(),schema=attributionSubmissionSchema(f.binding.request);
 assert.deepEqual(Object.keys(schema.properties).sort(),['Problem','summary']);
 assert.deepEqual(Object.keys(schema.properties.Problem.items.properties).sort(),['attribution_reason','calculations','evidence','evidence_status','reason','related_responsibilities','responsibility_boundary','text','uncertainties']);
 for(const extra of [{meta:{}},{has_standard_answer:true}])assert.throws(()=>f.registry.resolve(f.binding,{summary:'实际加法结果正确。',Problem:[],...extra},f.audit),ValidationError);
});
test('evidence-backed completed no-problem review has exactly six formal fields and nullable correctness',()=>{
 const f=plain(),r=f.registry.resolve(f.binding,{summary:'已核对实际交付，2+2结果4成立。',Problem:[]},f.audit) as AttributionResult;
 f.registry.validate(f.binding,r,f.audit);
 assert.deepEqual(Object.keys(r).sort(),['Problem','correct_reason','has_standard_answer','is_correct','meta','summary']);
 assert.equal(r.meta.input_id,f.binding.request.sources.answer.id);assert.equal(r.is_correct,null);assert.equal(r.correct_reason,null);
});
test('no standard answer still preserves an established defect and actual generation identity',()=>{
 const f=businessChainFixture(),draft=attributionSubmission(f.binding.request,f.result,f.audit);
 const r=resolveModelSubmission(f.binding.request,draft,f.audit);
 assert.equal(r.Problem.length,1);assert(!Object.hasOwn(r.Problem[0],'responsibility_boundary'));
 assert.equal(r.Problem[0].component,f.problem.component);assert.equal(r.is_correct,null);assert.equal(r.correct_reason,null);
});
test('reference agreement and independent attribution remain separate judgments',()=>{
 const f=businessChainFixture();f.binding.request.input.ground_truth={available:true,value:'3690'};
 f.result.has_standard_answer=true;f.result.is_correct=true;f.result.correct_reason='回答报价3690与给定标准3690一致；标的口径缺陷独立记录。';
 const r=resolveModelSubmission(f.binding.request,attributionSubmission(f.binding.request,f.result,f.audit),f.audit);
 assert.equal(r.is_correct,true);assert.equal(r.Problem.length,1);
 for(const value of [false,null]){const p=plain('4');const r=p.registry.resolve(p.binding,{summary:'已比较实际结果与标准。',Problem:[],is_correct:value,correct_reason:value===null?'标准对象未明确，无法确认比较口径。':'本次结果与标准不一致。'},p.audit) as AttributionResult;assert.equal(r.is_correct,value);}
});
test('established defect survives unknown responsibility with a real evidence gap',()=>{
 const f=businessChainFixture();Object.assign(f.result.Problem[0],responsibilityDisplay(f.binding.request,null));
 f.result.Problem[0].uncertainties=['可见交付缺陷，但形成记录未采集。'];
 const r=resolveModelSubmission(f.binding.request,attributionSubmission(f.binding.request,f.result,f.audit),f.audit);
 assert.equal(r.Problem[0].evidence_status,'已确认');assert.equal(r.Problem[0].component,'责任主体未确定');
});
test('structural repair preserves the defect and rechecks identity despite disabled evidence gates',()=>{
 const f=businessChainFixture(),draft=attributionSubmission(f.binding.request,f.result,f.audit),original=structuredClone(draft.Problem);
 assert.throws(()=>resolveModelSubmission(f.binding.request,{...draft,extra:'bad'},f.audit),ValidationError);
 draft.Problem[0].evidence=draft.Problem[0].evidence.map(e=>({...e,purposes:['问题']}));
 assert.equal(resolveModelSubmission(f.binding.request,draft,f.audit).Problem[0].text,original[0].text);
 draft.Problem=original;const r=resolveModelSubmission(f.binding.request,draft,f.audit);assert.equal(r.Problem[0].text,original[0].text);
 const changed=structuredClone(r);changed.Problem[0].component='编造主体';assert.throws(()=>validateEvaluation(f.binding.request,changed,f.audit),ValidationError);
});
test('unread evidence and missing boundary proof no longer trigger content repair',()=>{
 const f=businessChainFixture(),draft=attributionSubmission(f.binding.request,f.result,f.audit);
 draft.Problem[0].evidence=draft.Problem[0].evidence.slice(-1);
 assert.equal(resolveModelSubmission(f.binding.request,draft,{...f.audit,traceReads:[]}).Problem.length,1);
});

test('formal boundary is absent, report component names are program-owned and old fields are rejected',()=>{
 const f=businessChainFixture(),draft=attributionSubmission(f.binding.request,f.result,f.audit);
 draft.Problem[0].responsibility_boundary=f.transitions.find(t=>t.kind==='execution')!.transition_index;
 const r=resolveModelSubmission(f.binding.request,draft,f.audit),p=r.Problem[0];
 assert.equal(p.component,'finquery 取数服务');assert(!Object.hasOwn(p,'responsibility_boundary'));
 for(const extra of [{responsibility_boundary:1},{responsibility_boundary:null},{component:null},{component:''}]){
  const invalid=structuredClone(r);Object.assign(invalid.Problem[0],extra);
  assert.throws(()=>validateEvaluation(f.binding.request,invalid,f.audit),ValidationError);
 }
 draft.Problem[0].responsibility_boundary=null;delete draft.Problem[0].uncertainties;
 assert.throws(()=>resolveModelSubmission(f.binding.request,draft,f.audit),(e:unknown)=>e instanceof ValidationError&&e.issues!.some(i=>i.code==='responsibility_unresolved_required'));
});

test('same display component retains distinct internal call selections',()=>{
 const f=businessChainFixture(true),draft=attributionSubmission(f.binding.request,f.result,f.audit);
 const calls=f.transitions.filter(t=>responsibilityDisplay(f.binding.request,t.transition_index).component==='Expert 推理轮');
 assert.equal(calls.length,2);
 draft.Problem[0].responsibility_boundary=calls[0].transition_index;
 draft.Problem[0].related_responsibilities=[{responsibility_boundary:calls[1].transition_index,
   attribution_reason:'该次整理调用独立改变了字段，原文证据分别保留。',evidence_indices:draft.Problem[0].evidence.map(e=>e.index)}];
 const before=structuredClone(draft),result=resolveModelSubmission(f.binding.request,draft,f.audit);
 assert.equal(result.Problem[0].component,'Expert 推理轮');
 assert.equal(result.Problem[0].related_responsibilities![0].component,'Expert 推理轮');
 assert.deepEqual(draft,before,'the receipt retains exact submitted choices; display names never bind calls');
 draft.Problem[0].related_responsibilities[0].responsibility_boundary=calls[0].transition_index;
 assert.throws(()=>resolveModelSubmission(f.binding.request,draft,f.audit),ValidationError);
});
