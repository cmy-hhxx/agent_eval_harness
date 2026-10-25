import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest } from "@eval/contracts";
import { cite, evidenceSources, traceComponentIdentities } from "@eval/tools";
import { componentCatalogIssues, resolveProblemSubmission, responsibilityChoices, responsibilityComponentName, responsibilityIdentities, responsibilityIssues, responsibilityLabels } from "./responsibility.js";
import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
const id="11111111-1111-4111-8111-111111111111";
test('anonymous responsibility keeps a distinct physical node instead of borrowing the business issue name',()=>{
 const actors=traceComponentIdentities({messages:[{type:'llm_turn',name:'llm-call-1'},{type:'llm_turn',name:'planner-finquery'}]},id,9);
 assert.equal(responsibilityComponentName(actors[0]),'未命名模型调用（消息 0）');
 assert.equal(responsibilityComponentName(actors[1]),'planner-finquery');
});
test('generic model labels cannot terminate a responsibility mechanism',()=>{
 const f=fixture();
 for(const mechanism of ['模型推理问题','模型能力不足','模型推断与生成','模型理解错误']){
  const cause=f.cause('最终回答组织',{mechanism,evidence_ids:[f.final.evidence_id]});
  assert(responsibilityIssues(f.request,{component:[cause]},[f.final],'/problem')
   .some(issue=>issue.code==='responsibility_mechanism_generic'));
 }
});
test('anonymous calls with different physical coordinates remain distinct responsibility components',()=>{
 const actors=traceComponentIdentities({messages:[{type:'llm_turn',name:'llm-call-0'},
  {type:'llm_turn',name:'llm-call-1'},{role:'assistant',content:'结果'}]},id,2);
 const names=actors.map(responsibilityComponentName);
 assert.equal(names.length,new Set(names).size);
 assert(names.every(name=>name.includes('未命名')&&name.includes('消息')));
});
function causalFixture(recovered=false){
 const messages=[{type:'llm_turn',name:'llm-call-0',input_messages:[],output:[{role:'assistant',reasoning_content:'工具给18.18%/22.81%，另写18.15%/22.75%。',content:recovered?'已修正为18.18%/22.81%。':'18.15%/22.75%，在±1%容差内一致。'}]},
 {type:'final_answer',content:recovered?'已修正为18.18%/22.81%。':'18.15%/22.75%，在±1%容差内一致。'}];
 const request={input:{answer:{final_message_index:1,component_catalog:traceComponentIdentities({messages},id,1)}},sources:{answer:{id,value:{messages}}}} as unknown as AgentRequest;
 const quote=(index:number,path:string)=>{const source=evidenceSources(messages[index]).find(s=>s.kind==='text'&&s.path===path)!;return cite(id,index,source,0,Array.from(source.text).length);};
 const origin=quote(0,'/output/0/reasoning_content'),final=quote(1,'/content');
 const source=responsibilityFixture('中间推理处理',{actor_index:1,technical_domain:'模型推断与生成',functional_component:'事实关系推导',chain_step:'数据解释与计算',failure_stage:'推理与计算',mechanism_source:'explicit_process',certainty:'confirmed',evidence_gap:null,alternatives:[],mechanism:'推理记录首次引入无依据数字。',evidence_ids:[origin.evidence_id]});
 const delivery=responsibilityFixture('最终回答组织',{actor_index:2,role:'contributing',mechanism:'最终交付继续沿用错误数字并错误解释容差。',evidence_ids:[origin.evidence_id,final.evidence_id]});
 source.component=responsibilityComponentName(responsibilityIdentities(request)[0]);
 delivery.component=responsibilityComponentName(responsibilityIdentities(request)[1]);
 return{request,origin,final,source,delivery};
}
test('upstream introduction and downstream propagation use their own stage evidence',()=>{
 const f=causalFixture();assert.deepEqual(responsibilityIssues(f.request,{component:[f.source,f.delivery]},[f.origin,f.final],'/problem'),[]);
 assert(responsibilityIssues(f.request,{component:[{...f.source,evidence_ids:[f.final.evidence_id]},f.delivery]},[f.origin,f.final],'/problem').some(issue=>issue.code==='responsibility_actor_evidence'));
});
test('a recovered upstream error retains its origin without inventing downstream propagation',()=>{
 const f=causalFixture(true);assert.deepEqual(responsibilityIssues(f.request,{component:[f.source]},[f.origin,f.final],'/problem'),[]);
 assert.equal(f.final.quote,'已修正为18.18%/22.81%。');assert.equal(f.source.chain_step,'数据解释与计算');
});
function fixture(){
 const messages=[{role:"user",content:"分析黄金价格。"},{type:"tool_result",name:"finquery",output:"SPDR Gold Shares，收盘369。"},
  {type:"llm_turn",name:"llm-call-0",input_messages:[{role:"tool",content:"SPDR Gold Shares，收盘369。"}],output:[{role:"assistant",content:"现货黄金3690。"}]},
  {role:"assistant",content:"现货黄金3690。"}];
 const request={input:{answer:{final_message_index:3,component_catalog:traceComponentIdentities({messages},id,3)}},sources:{answer:{id,value:{messages}}}} as unknown as AgentRequest;
 const quote=(index:number,path:string)=>{const leaf=evidenceSources(messages[index]).find(s=>s.kind==='text'&&s.path===path)!;return cite(id,index,leaf,0,leaf.text.length);};
 const cause=(component='最终回答组织',patch:Parameters<typeof responsibilityFixture>[1]={})=>{
  const actors=responsibilityIdentities(request),actor_index=patch.actor_index??actors.findIndex(actor=>actor.component===component)+1;
  return responsibilityFixture(component,{...patch,actor_index,component:responsibilityComponentName(actors[actor_index-1])});
 };
 return {request,cause,tool:quote(1,'/output'),input:quote(2,'/input_messages/0/content'),final:quote(3,'/content')};
}
test('each problem requires exactly one primary cause and valid function taxonomy',()=>{
 const f=fixture(),cause=f.cause('最终回答组织',{actor_index:2,evidence_ids:[f.final.evidence_id]});
 const check=(component:unknown[])=>responsibilityIssues(f.request,{component},[f.final],'/problem');
 assert.deepEqual(check([cause]),[]);assert(check([]).some(x=>x.code==='responsibility_primary'));
 assert(check([cause,{...cause,mechanism:'另一失误。'}]).some(x=>x.code==='responsibility_primary'));
 assert(check([{...cause,functional_component:'网络'}]).some(x=>x.code==='responsibility_taxonomy'));
 assert.deepEqual(responsibilityLabels({component:[cause]}),['未命名终稿生成调用（消息 2、3） / 数据解释与计算 / 事实关系推导']);
});
test('inference needs explicit missing evidence and alternative explanations, while the defect can stay established',()=>{
 const f=fixture(),cause=f.cause('最终回答组织',{actor_index:2,evidence_ids:[f.final.evidence_id]});
 for(const patch of [{evidence_gap:null},{alternatives:[]}])assert(responsibilityIssues(f.request,{component:[{...cause,...patch}]},[f.final],'/problem').some(x=>x.code==='responsibility_inference'));
 assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.final],'/problem'),[]);
});
test('confirmed tool responsibility needs that tool process, and a model node is not tool proof',()=>{
 const f=fixture(),cause=f.cause('finquery',{certainty:'confirmed',evidence_gap:null,alternatives:[],evidence_ids:[f.tool.evidence_id]});
 assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.tool,f.final],'/problem'),[]);
 const wrong={...cause,component:'llm-call-0',evidence_ids:[f.input.evidence_id]};
 assert(responsibilityIssues(f.request,{component:[wrong]},[f.input],'/problem').some(x=>x.code==='responsibility_process_missing'));
 assert(responsibilityIssues(f.request,{component:[wrong]},[f.input],'/problem').some(x=>x.code==='responsibility_actor_locator'));
 assert(!responsibilityChoices(f.request).includes('llm-call-0'));
 const mislabeled={...wrong,actor_index:2,component:'最终回答组织',certainty:'inferred'};
 assert(responsibilityIssues(f.request,{component:[mislabeled]},[f.input],'/problem').some(x=>x.code==='responsibility_actor_domain'));
});
test('confirmed context loss needs the actual model input, not just an original tool return',()=>{
 const f=fixture(),cause=f.cause('最终回答组织',{actor_index:2,technical_domain:'上下文工程',functional_component:'实际输入传递',certainty:'confirmed',evidence_gap:null,alternatives:[],evidence_ids:[f.tool.evidence_id]});
 assert(responsibilityIssues(f.request,{component:[cause]},[f.tool],'/problem').some(x=>x.code==='responsibility_process_missing'));
 cause.evidence_ids=[f.input.evidence_id];assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.input,f.final],'/problem'),[]);
});
test('selected actor names retain their source coordinates and forged identities or node links are rejected',()=>{
 const f=fixture(),cause=f.cause(undefined,{actor_index:2,evidence_ids:[f.final.evidence_id]});
 const problem=resolveProblemSubmission(f.request,{diagnosis:"other",investigation:[],component:[cause],label:'价格口径错误',definition:'ETF份额价混作现货价。'},[f.final],'/problem');
 const actor=responsibilityIdentities(f.request)[problem.component[0].actor_index-1];
 assert.deepEqual(actor.message_indices,[2,3]);
 assert.deepEqual(responsibilityIssues(f.request,problem,[f.final],'/problem'),[]);
 actor.message_indices=[1];
 assert(componentCatalogIssues(f.request).length);
 actor.message_indices=[2,3];
 (f.request.input.answer as {component_catalog:{component:string}[]}).component_catalog[0].component='编造的服务';
 assert(componentCatalogIssues(f.request).length);
});
test('a contributing cause cannot borrow absent evidence or duplicate the primary mechanism',()=>{
 const f=fixture(),cause=f.cause('最终回答组织',{actor_index:2,evidence_ids:[f.final.evidence_id]});
 assert(responsibilityIssues(f.request,{component:[cause,{...cause,role:'contributing'}]},[f.final],'/problem').some(x=>x.code==='responsibility_duplicate'));
 assert(responsibilityIssues(f.request,{component:[{...cause,evidence_ids:[f.tool.evidence_id]}]},[f.final],'/problem').some(x=>x.code==='responsibility_evidence'));
});
test('same-name actors keep their real name and cannot borrow another record to confirm responsibility',()=>{
 const raw={messages:[{type:'llm_turn',name:'Planner',output:[{role:'assistant',content:'选择ETF。'}]},
  {type:'llm_turn',name:'Planner',output:[{role:'assistant',content:'选择现货。'}]},{role:'assistant',content:'最终交付。'}]};
 const actors=traceComponentIdentities(raw,id,2);
 const request={input:{answer:{final_message_index:2,component_catalog:actors}},sources:{answer:{id,value:raw}}} as unknown as AgentRequest;
 const leaf=evidenceSources(raw.messages[0]).find(row=>row.path==='/output/0/content')!;
 const evidence=cite(id,0,leaf,0,leaf.text.length);
 const cause=responsibilityFixture('Planner',{actor_index:1,technical_domain:'模型推断与生成',functional_component:'事实关系推导',
  certainty:'confirmed',evidence_gap:null,alternatives:[],evidence_ids:[evidence.evidence_id]});
 assert.deepEqual(responsibilityIssues(request,{component:[cause]},[evidence],'/problem'),[]);
 cause.actor_index=2;
 assert(responsibilityIssues(request,{component:[cause]},[evidence],'/problem').some(issue=>issue.code==='responsibility_actor_evidence'));
 assert.deepEqual(actors.slice(0,2).map(actor=>actor.component),['Planner','Planner']);
});
