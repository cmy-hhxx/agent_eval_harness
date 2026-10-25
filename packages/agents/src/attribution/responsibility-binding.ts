import type { AgentRequest, ToolAudit, ValidationIssue, JsonObject } from '@eval/contracts';
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

/** One quick recall from the complete current Problem and captured calls; no reinvestigation. */
export function finalResponsibilityReview(request:AgentRequest,draft:unknown,result:unknown,_audit:ToolAudit):JsonObject|undefined{
  const submitted=draft as AttributionSubmission,value=result as AttributionResult;
  const indices=value.Problem.flatMap((p,i)=>p.component==='终稿生成轮'||p.related_responsibilities?.some(r=>r.component==='终稿生成轮')?[i]:[]);
  if(!indices.length)return undefined;
  const answer=request.input.answer as unknown as ResponsibilityMaterial,raw=request.sources.answer.value as {messages:Record<string,unknown>[]};
  const choices=answer.transitions.filter(t=>t.execution_node_index!==null).flatMap(t=>{
    const component=responsibilityDisplay(request,t.transition_index).component;
    if(component==='责任主体未确定')return [];
    const node=answer.execution_nodes.find(n=>n.execution_node_index===t.execution_node_index)!;
    return [{responsibility_boundary:'boundary:'+t.transition_index,component,action:({generation:'生成正文',request_formation:'生成调用参数',execution:'执行请求',transfer:'传递材料',delivery:'交付'})[t.kind],message_index:node.message_index,call_name:String(raw.messages[node.message_index].name??'')}];
  });
  return {problems:indices.map(i=>({problem_index:i,current_component:value.Problem[i].component,Problem:submitted.Problem[i]})),choices} as unknown as JsonObject;
}
