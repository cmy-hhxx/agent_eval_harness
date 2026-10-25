import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreAgent,scoreProfile} from './index.js';
import {AgentRegistry} from '@eval/host';
import type {AgentRequest} from '@eval/contracts';
import exampleCase from './fixtures/example-case.json' with {type:'json'};
import exampleOutput from './fixtures/example-output.json' with {type:'json'};
const audit={calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[]};
const request={input:{},sources:{case:{id:'11111111-1111-4111-8111-111111111111',value:exampleCase}}} as unknown as AgentRequest;
test('original skill example passes without regrading or averaging its supplied scores',()=>{
 const value=structuredClone(exampleOutput),before=structuredClone(value);scoreProfile.validate!(request,value,audit);assert.deepEqual(value,before);
 assert.equal(value.final_answer_score.score,9);
});
test('unknown ranges, violated full marks and source spans are mechanically distinguished',()=>{
 for(const change of [
  (v:any)=>{v.final_answer_score.score=10;},
  (v:any)=>{v.evaluations[0].status='unverified';v.evaluations[0].score=2;},
  (v:any)=>{v.evidence[0].start++;},
  (v:any)=>{v.evaluations.pop();},
 ]){const value=structuredClone(exampleOutput);change(value);assert.throws(()=>scoreProfile.validate!(request,value,audit));}
});
test('the initial joint judgment preserves genuine empty-answer exceptions without inventing axes',()=>{
 const material={...structuredClone(exampleCase),evidence:{...exampleCase.evidence,[exampleCase.candidate_output_id]:''}};
 const binding={agent:'score',profile:'dimensions',request:{input:{case_id:material.case_id,task_question:material.task_question,availability:material.availability,score_axes:['T','E','L','A','U','D']},sources:{case:{id:'11111111-1111-4111-8111-111111111111',value:material},score:{id:'initial',value:{axis_ids:['T','E','L','A','U','D']}}}}} as unknown as Parameters<AgentRegistry['resolve']>[0];
 const registry=new AgentRegistry([scoreAgent]),draft={assessment_status:'host_empty_response',reason:'完整采集到真实空答。',missing_material:[],affected_units:[]};
 const result=registry.resolve(binding,draft,structuredClone(audit)) as any;
 registry.validate(binding,result,structuredClone(audit));
 assert.equal(result.case_id,material.case_id);assert.equal(result.assessment_status,'host_empty_response');
 assert(!('evaluations' in result));
});
