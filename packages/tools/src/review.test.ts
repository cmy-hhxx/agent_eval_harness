import test from 'node:test';
import assert from 'node:assert/strict';
import type {ToolContext,ReviewAudit} from '@eval/contracts';
import {reviewTools,reviewAudit} from './review.js';
const seed=():ReviewAudit=>({quotes:[],sources:[],actions:[],viewed:[],searches:[]});
const context=(review_seed=seed())=>({inputs:new Map([['case',{case_id:'case',evidence:{Q:'原题',A:'回答🧪'},review_seed}]]),audit:{calls:0,requiredReadCalls:0,viewedImages:[],traceReads:[],calculations:[],artifacts:[]}} as unknown as ToolContext);
test('proof is cloned per axis, quotes keep Unicode spans, and identical text reuses evidence',async()=>{
  const original=seed(),left=context(original),right=context(original),tool=reviewTools.find(t=>t.name==='review_material')!;
  const quote=await tool.execute(left,{action:'quote',source_id:'A',text:'🧪'},new AbortController().signal);
  assert.deepEqual(quote.details,{evidence_id:'EV_1',source_id:'A',start:2,end:3,quote:'🧪'});
  assert.deepEqual((await tool.execute(left,{action:'quote',source_id:'A',text:'🧪'},new AbortController().signal)).details,quote.details);
  assert.equal(reviewAudit(right).quotes.length,0);assert.equal(original.quotes.length,0);
});
test('review search reuses the Eris Serper contract and cumulative budget cannot reset on a second evidence pass',async()=>{
  const originalFetch=globalThis.fetch,oldKey=process.env.SEARCH_API_KEY;process.env.SEARCH_API_KEY='test-key';let requests=0;
  globalThis.fetch=(async(url,options)=>{requests++;assert.equal(String(url),'https://google.serper.dev/search');assert.equal((options!.headers as any)['X-API-KEY'],'test-key');
    return new Response(JSON.stringify({organic:[{title:'官方原文',link:'https://example.com/report',snippet:'实际取得的片段',position:1}]}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  try{
    const current=context(),tool=reviewTools.find(t=>t.name==='review_external')!,signal=new AbortController().signal;
    const base={claim:'实际主张',affected_item_ids:['E1'],verification_role:'as_of_information'};
    const result=await tool.execute(current,{...base,action:'search',query:'官方原文'},signal),id=(result.details as any).search_id;
    const admitted=await tool.execute(current,{...base,action:'admit_search',search_id:id,result_index:0},signal);
    assert.equal((admitted.details as any).record.scope,'search_snippet');assert.equal(requests,1);
    const proof=reviewAudit(current);while(proof.actions.length<6)proof.actions.push({kind:'search',args:{},at:'test'});
    await assert.rejects(tool.execute(context(proof),{...base,action:'search',query:'第七次'},signal));assert.equal(requests,1);
  }finally{globalThis.fetch=originalFetch;if(oldKey===undefined)delete process.env.SEARCH_API_KEY;else process.env.SEARCH_API_KEY=oldKey;}
});
test('critical calculations retain source inputs and reject numbers absent from the quoted material',async()=>{
  const current=context(),material=current.inputs.get('case') as any;material.evidence.Q='收入从100增加至120。';
  const tool=reviewTools.find(t=>t.name==='review_calculate')!,signal=new AbortController().signal;
  const row=(number_token:string)=>({evidence_id:'Q',quote:material.evidence.Q,number_token,role:'收入',unit:'元'});
  const args={operation:'arithmetic',inputs:{start:row('100'),finish:row('120')},expression:'(finish-start)/start*100',result_unit:'%'};
  const result=(await tool.execute(current,args,signal)).details as any;
  assert.equal(result.record.result.result,'20');assert.equal(result.record.spec.expression,args.expression);
  assert.equal(result.record.result_unit,'%');assert.match(result.source_id,/^V_CALC_/);
  await assert.rejects(tool.execute(current,{...args,inputs:{start:row('200'),finish:row('120')}},signal),/输入值/);
});
