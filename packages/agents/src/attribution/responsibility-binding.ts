import type { AgentRequest, ToolAudit, ValidationIssue } from '@eval/contracts';
import { responsibilityDisplay, transferChanged, type ResponsibilityMaterial } from './responsibility.js';
import type { Evidence } from './types.js';

/** Validate identities only; the reviewer decides which real call formed the defect. */
export function responsibilityBindingIssues(request:AgentRequest,index:number|null,_proof:Evidence[],_audit:ToolAudit,path:string):ValidationIssue[]{
  const answer=request.input.answer as unknown as ResponsibilityMaterial;
  const edge=answer.transitions.find(t=>t.transition_index===index);
  const raw=request.sources.answer.value as {messages:Record<string,unknown>[]};
  if(edge?.kind==='delivery')return [{category:'decision',code:'responsibility_binding',path,message:'交付位置不是形成调用。复制责任选项的 boundary 标识，不能用节点编号代替。'}];
  if(edge?.kind==='transfer'&&!transferChanged(answer,raw,edge))return [{category:'decision',code:'responsibility_transfer_unobserved',path,message:'只能在实际观察到材料缺失、截断或改写时选择上下文组装与传递；正常传递不是责任主体。'}];
  if(index===null||responsibilityDisplay(request,index).component==='责任主体未确定')return [{category:'decision',code:'responsibility_unresolved',path,message:'缺少真实形成主体，保留问题草稿为未完成；不能删除缺陷或编造组件。'}];
  return [];
}
