import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreProfile} from './index.js';
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
