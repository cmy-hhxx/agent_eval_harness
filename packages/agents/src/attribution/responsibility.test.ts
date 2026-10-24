import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest } from "@eval/contracts";
import { cite, evidenceSources, traceComponentIdentities } from "@eval/tools";
import { componentCatalogIssues, resolveProblemSubmission, responsibilityChoices, responsibilityIdentities, responsibilityIssues, responsibilityLabels } from "./responsibility.js";
import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
const id="11111111-1111-4111-8111-111111111111";
function fixture(){
 const messages=[{role:"user",content:"分析黄金价格。"},{type:"tool_result",name:"finquery",output:"SPDR Gold Shares，收盘369。"},
  {type:"llm_turn",name:"llm-call-0",input_messages:[{role:"tool",content:"SPDR Gold Shares，收盘369。"}],output:[{role:"assistant",content:"现货黄金3690。"}]},
  {role:"assistant",content:"现货黄金3690。"}];
 const request={input:{answer:{final_message_index:3,component_catalog:traceComponentIdentities({messages},id,3)}},sources:{answer:{id,value:{messages}}}} as unknown as AgentRequest;
 const quote=(index:number,path:string)=>{const leaf=evidenceSources(messages[index]).find(s=>s.kind==='text'&&s.path===path)!;return cite(id,index,leaf,0,leaf.text.length);};
 return {request,tool:quote(1,'/output'),input:quote(2,'/input_messages/0/content'),final:quote(3,'/content')};
}
test('each problem requires exactly one primary cause and valid function taxonomy',()=>{
 const f=fixture(),cause=responsibilityFixture('最终作答节点（原始名称未提供）',{evidence_ids:[f.final.evidence_id]});
 const check=(component:unknown[])=>responsibilityIssues(f.request,{component},[f.final],'/problem');
 assert.deepEqual(check([cause]),[]);assert(check([]).some(x=>x.code==='responsibility_primary'));
 assert(check([cause,{...cause,mechanism:'另一失误。'}]).some(x=>x.code==='responsibility_primary'));
 assert(check([{...cause,functional_component:'网络'}]).some(x=>x.code==='responsibility_taxonomy'));
 assert.deepEqual(responsibilityLabels({component:[cause]}),['模型推断与生成/事实关系推导']);
});
test('inference needs explicit missing evidence and alternative explanations, while the defect can stay established',()=>{
 const f=fixture(),cause=responsibilityFixture('最终作答节点（原始名称未提供）',{evidence_ids:[f.final.evidence_id]});
 for(const patch of [{evidence_gap:null},{alternatives:[]}])assert(responsibilityIssues(f.request,{component:[{...cause,...patch}]},[f.final],'/problem').some(x=>x.code==='responsibility_inference'));
 assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.final],'/problem'),[]);
});
test('confirmed tool responsibility needs that tool process, and a model node is not tool proof',()=>{
 const f=fixture(),cause=responsibilityFixture('finquery',{certainty:'confirmed',evidence_gap:null,alternatives:[],evidence_ids:[f.tool.evidence_id]});
 assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.tool,f.final],'/problem'),[]);
 const wrong={...cause,component:'llm-call-0',evidence_ids:[f.input.evidence_id]};
 assert(responsibilityIssues(f.request,{component:[wrong]},[f.input],'/problem').some(x=>x.code==='responsibility_process_missing'));
 assert(responsibilityIssues(f.request,{component:[wrong]},[f.input],'/problem').some(x=>x.code==='responsibility_actor_locator'));
 assert(!responsibilityChoices(f.request).includes('llm-call-0'));
 const mislabeled={...wrong,component:'最终作答节点（原始名称未提供）',certainty:'inferred'};
 assert(responsibilityIssues(f.request,{component:[mislabeled]},[f.input],'/problem').some(x=>x.code==='responsibility_actor_domain'));
});
test('confirmed context loss needs the actual model input, not just an original tool return',()=>{
 const f=fixture(),cause=responsibilityFixture('最终作答节点（原始名称未提供）',{technical_domain:'上下文工程',functional_component:'实际输入传递',certainty:'confirmed',evidence_gap:null,alternatives:[],evidence_ids:[f.tool.evidence_id]});
 assert(responsibilityIssues(f.request,{component:[cause]},[f.tool],'/problem').some(x=>x.code==='responsibility_process_missing'));
 cause.evidence_ids=[f.input.evidence_id];assert.deepEqual(responsibilityIssues(f.request,{component:[cause]},[f.input,f.final],'/problem'),[]);
});
test('selected actor names retain their source coordinates and forged identities or node links are rejected',()=>{
 const f=fixture(),cause=responsibilityFixture(undefined,{evidence_ids:[f.final.evidence_id]});
 const problem=resolveProblemSubmission(f.request,{diagnosis:"other",investigation:[],component:[cause],label:'价格口径错误',definition:'ETF份额价混作现货价。'},[f.final],'/problem');
 const actor=responsibilityIdentities(f.request).find(actor=>actor.component===problem.component[0].component)!;
 assert.deepEqual(actor.message_indices,[2,3]);
 assert.deepEqual(responsibilityIssues(f.request,problem,[f.final],'/problem'),[]);
 actor.message_indices=[1];
 assert(componentCatalogIssues(f.request).length);
 actor.message_indices=[2,3];
 (f.request.input.answer as {component_catalog:{component:string}[]}).component_catalog[0].component='编造的服务';
 assert(componentCatalogIssues(f.request).length);
});
test('a contributing cause cannot borrow absent evidence or duplicate the primary mechanism',()=>{
 const f=fixture(),cause=responsibilityFixture('最终作答节点（原始名称未提供）',{evidence_ids:[f.final.evidence_id]});
 assert(responsibilityIssues(f.request,{component:[cause,{...cause,role:'contributing'}]},[f.final],'/problem').some(x=>x.code==='responsibility_duplicate'));
 assert(responsibilityIssues(f.request,{component:[{...cause,evidence_ids:[f.tool.evidence_id]}]},[f.final],'/problem').some(x=>x.code==='responsibility_evidence'));
});
