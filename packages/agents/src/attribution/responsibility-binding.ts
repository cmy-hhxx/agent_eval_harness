import { parseEvidenceCoordinates, ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue, type JsonObject, type TraceRead } from '@eval/contracts';
import { evidenceCovers, evidenceSources, type EvidenceSelectionCache } from '@eval/tools';
import { responsibilityDisplay, type ResponsibilityMaterial } from './responsibility.js';
import type { Evidence, AttributionSubmission, AttributionResult } from './types.js';

/** Validate identities only; the reviewer decides which real call formed the defect. */
export function responsibilityBindingIssues(request:AgentRequest,index:number|null,_proof:Evidence[],_audit:ToolAudit,path:string):ValidationIssue[]{
  const answer=request.input.answer as unknown as ResponsibilityMaterial;
  const edge=answer.transitions.find(t=>t.transition_index===index);
  if(edge?.kind==='delivery')return [{category:'decision',code:'responsibility_binding',path,message:'交付位置不是形成调用。复制责任选项的 boundary 标识，不能用节点编号代替。'}];
  if(index===null||responsibilityDisplay(request,index).component==='责任主体未确定')return [{category:'decision',code:'responsibility_unresolved',path,message:'缺少真实形成主体，保留问题草稿为未完成；不能删除缺陷或编造组件。'}];
  return [];
}

/** Direct source/input/output comparison; never follow the transitive ancestor graph. */
export function finalResponsibilityReview(request:AgentRequest,draft:unknown,result:unknown,_audit:ToolAudit):JsonObject|undefined{
  const submitted=draft as AttributionSubmission,value=result as AttributionResult;
  const answer=request.input.answer as unknown as ResponsibilityMaterial,raw=request.sources.answer.value as {messages:Record<string,unknown>[]};
  const choices=answer.transitions.filter(t=>t.execution_node_index!==null).flatMap(t=>{
    const component=responsibilityDisplay(request,t.transition_index).component;
    if(component==='责任主体未确定')return [];
    const node=answer.execution_nodes.find(n=>n.execution_node_index===t.execution_node_index)!;
    return [{responsibility_boundary:'boundary:'+t.transition_index,component,action:({generation:'生成正文',request_formation:'生成调用参数',execution:'执行请求',transfer:'传递材料',delivery:'交付'})[t.kind],message_index:node.message_index,call_name:String(raw.messages[node.message_index].name??'')}];
  });
  const reads=new Map<string,TraceRead>();
  const add=(items:{evidence_id:string}[])=>items.flatMap(item=>{
    const p=parseEvidenceCoordinates(item.evidence_id);
    if(!p||p.input_id!==request.sources.answer.id||p.kind==='image'||p.end<=p.start)return [];
    const read:TraceRead={candidate:'answer',message_index:p.message_index,kind:p.kind,path:p.path,start:p.start,end:p.end};
    reads.set(item.evidence_id,read);return [item.evidence_id];
  });
  const sources=new Map<number,ReturnType<typeof evidenceSources>>(),selectionCache:EvidenceSelectionCache=new WeakMap();
  const covers=(outer:{evidence_id:string},inner:{evidence_id:string})=>{
    const a=parseEvidenceCoordinates(outer.evidence_id),b=parseEvidenceCoordinates(inner.evidence_id);
    if(!a||!b||a.message_index!==b.message_index||a.input_id!==b.input_id)return false;
    if(a.kind===b.kind&&a.kind!=='image'&&b.kind!=='image')return a.path===b.path&&a.start<=b.start&&a.end>=b.end;
    if(!sources.has(a.message_index))sources.set(a.message_index,evidenceSources(raw.messages[a.message_index]));
    return evidenceCovers(raw,request.sources.answer.id,outer.evidence_id,inner.evidence_id,sources.get(a.message_index),selectionCache);
  };
  const problems=submitted.Problem.map((problem,i)=>{
    const proof=value.Problem[i].evidence??[];
    const selected=[problem,...problem.related_responsibilities??[]].flatMap(r=>{
      const t=answer.transitions.find(t=>'boundary:'+t.transition_index===r.responsibility_boundary);return t?[t]:[];
    });
    // A broad reference to the entire input must not select every historical chain.
    const directChains=answer.business_chains.filter(c=>selected.some(t=>t.kind!=='generation'&&t.chain_indices.includes(c.chain_index))||
      proof.some(e=>[c.request_index,...c.return_indices].includes(e.message_index)||
        c.checkpoints[5].evidence.some(entry=>covers(entry,e))));
    const generations=selected.filter(t=>t.kind==='generation'||t.kind==='request_formation');
    const generationMessages=generations.filter(t=>responsibilityDisplay(request,t.transition_index).component==='终稿生成轮').flatMap(t=>answer.execution_nodes.filter(n=>n.execution_node_index===t.execution_node_index).map(n=>n.message_index));
    // If the selected return has no captured propagation, disambiguate it from
    // same-tool records actually present in this input. Do not follow ancestors
    // or claim that one invocation's empty result belongs to another invocation.
    const missingTools=new Set(directChains.filter(c=>!c.context_indices.some(i=>generationMessages.includes(i))).map(c=>c.tool_component));
    const chains=answer.business_chains.filter(c=>directChains.includes(c)||missingTools.has(c.tool_component)&&c.context_indices.some(i=>generationMessages.includes(i)));
    const inputs=chains.flatMap(c=>c.checkpoints[5].evidence).filter(e=>generations.some(t=>t.before.some(b=>covers(b,e))));
    const selectedInputs=proof.filter(e=>generations.some(t=>t.before.some(b=>covers(b,e))));
    // For an unsupported assertion with no linked source, the captured input of
    // this invocation is the boundary. It is never expanded to its ancestors.
    const actualInputs=inputs.length||selectedInputs.length?[...inputs,...selectedInputs]:generations.flatMap(t=>t.before);
    return {problem_index:i,
      source_comparison:{
        calls:chains.map(c=>({tool:c.tool_component,request:add(c.checkpoints[2].evidence),
          original_return:add(c.checkpoints[3].evidence),
          actual_input:add(c.checkpoints[5].evidence.filter(e=>generations.some(t=>t.before.some(b=>covers(b,e))))),
          // An observed difference is not an observed material processor.
          transfer_actor_captured:answer.transitions.some(t=>t.kind==='transfer'&&t.chain_indices.includes(c.chain_index)&&t.execution_node_index!==null)})),
        actual_input:add(actualInputs),actual_output:add(generations.flatMap(t=>t.after)),existing_evidence:add(proof),
      }};
  });
  const emptyReview=value.Problem.length?undefined:answer.transitions.filter(t=>t.kind==='generation'&&
    responsibilityDisplay(request,t.transition_index).component==='终稿生成轮').map(t=>({
      actual_input:add(t.before),actual_output:add(t.after),
    }));
  // Remove only ranges fully represented by a wider range in the same source.
  const required=[...reads.values()].filter((r,i,all)=>!all.some((other,j)=>j!==i&&other.message_index===r.message_index&&other.kind===r.kind&&other.path===r.path&&other.start<=r.start&&other.end>=r.end));
  if(required.reduce((n,r)=>n+r.end-r.start,0)>240000)throw new ValidationError([{category:'decision',code:'completion_review_incomplete',path:'/Problem',
    message:'本问题相关原文超过单轮复核材料预算，不能截断证据或直接确认；保留草稿为未完成。'}]);
  const originals=required.map(read=>{
    const source=evidenceSources(raw.messages[read.message_index]).find(s=>s.kind===read.kind&&s.path===read.path);
    if(!source)throw new Error('复核原始材料不存在');
    const id=[...reads].find(([,r])=>r===read)![0];
    return {reference:{evidence_id:id},message_index:read.message_index,path:read.path,quote:source.text.slice(read.start,read.end)};
  });
  return {question:(request.input.answer as JsonObject).question,
    answer:(request.input.answer as JsonObject).final_answer,
    originals,problems,choices,...(emptyReview?{empty_review:emptyReview}:{}),read_requests:required,
    initial_result:value,
    submission_bindings:submitted.Problem.map((p,i)=>({problem_id:value.Problem[i].problem_id,
      responsibility_boundary:p.responsibility_boundary,evidence:p.evidence,
      ...(p.related_responsibilities?{related_responsibilities:p.related_responsibilities}:{}),
      ...(p.calculations?{calculations:p.calculations}:{})})),
  } as unknown as JsonObject;
}
