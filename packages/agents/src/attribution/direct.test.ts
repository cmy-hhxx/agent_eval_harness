import test from 'node:test';
import assert from 'node:assert/strict';
import {directAttributionProfile} from './direct.js';
import type {AgentRequest,ToolAudit} from '@eval/contracts';
const quote={evidence_id:'EV_1',source_id:'A',start:0,end:11,quote:'hello world'};
const request={input:{tool_names:[]},sources:{case:{id:'case',value:{case_id:'case',evidence:{A:quote.quote}}}}} as unknown as AgentRequest;
const audit={calls:1,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[],review:{quotes:[quote],sources:[],actions:[],viewed:[],searches:[]}} as ToolAudit;
const draft=()=>({summary:'回答使用了简短问候。',findings:[{type:'strength',dimension:'format',stage:'final_answer',importance:'low',text:'问候表达清楚。',reason:'原文直接给出了问候。',evidence_status:'established',evidence_ids:['EV_1'],component:[],label:null,definition:null}]});
test('flat attribution binds recorded evidence without model copying and rejects English commentary',()=>{
 const value=directAttributionProfile.resolve!(request,draft(),audit) as any;
 assert.deepEqual(value.evidence,[quote]);assert.equal(value.findings[0].finding_id,'f1');assert(!('problem' in value.findings[0]));
 const english=draft();english.summary='The answer is correct and complete.';
 assert.throws(()=>directAttributionProfile.resolve!(request,english,audit),/中文/);
 const unknown=draft();unknown.findings[0].evidence_ids=['EV_fake'];assert.throws(()=>directAttributionProfile.resolve!(request,unknown,audit),/不能编造/);
});
