import { canonical, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { traceComponentIdentities, traceComponentOwnsEvidence, type TraceComponentIdentity } from '@eval/tools';
import type { Evidence, ProblemProposal } from "./types.js";

/** Workflow supplies the directory; no taxonomy labels or raw call IDs become actors. */
export function responsibilityIdentities(request: AgentRequest): TraceComponentIdentity[] {
  return (request.input.answer as { component_catalog: TraceComponentIdentity[] }).component_catalog;
}
export function responsibilityChoices(request: AgentRequest): string[] {
  return responsibilityIdentities(request).map(actor => actor.component);
}
/** Display captured names; unnamed actors retain their real message coordinates. */
export function responsibilityComponentName(actor:TraceComponentIdentity|undefined){
  return actor ? actor.identity_status==='named' ? actor.component : `调用（消息 ${actor.message_indices.join('、')}）` : '主体未采集';
}
export function componentCatalogIssues(request: AgentRequest): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: unknown[] };
  const answer = request.input.answer as { final_message_index: number };
  return canonical(responsibilityIdentities(request)) === canonical(traceComponentIdentities(raw, request.sources.answer.id, answer.final_message_index)) ? [] :
    [{ category: 'evidence', code: 'component_catalog', path: '/answer/component_catalog', message: '主体目录必须对应真实调用及坐标。' }];
}
export function responsibilityLabels(problem: Pick<ProblemProposal, 'causes'>): string[] {
  return [...new Set(problem.causes.map(row=>row.component))];
}
/** Identity is program-owned; causal prose and certainty remain the model's judgment. */
export function responsibilityIssues(request:AgentRequest,problem:unknown,selected:readonly (Evidence|undefined)[],path:string):ValidationIssue[]{
  const value=problem as ProblemProposal|undefined;
  if(!value||!Array.isArray(value.causes))return [];
  const issues:ValidationIssue[]=[],actors=responsibilityIdentities(request),ids=new Set(selected.flatMap(e=>e?[e.evidence_id]:[]));
  const add=(code:string,at:string,message:string)=>issues.push({category:'evidence',code,path:at,message});
  const gap=(u:ProblemProposal['uncertainty'])=>!!u?.evidence_gap?.trim()&&Array.isArray(u.alternatives)&&u.alternatives.some(a=>a.trim());
  if(!value.causes.length&&!gap(value.uncertainty))add('responsibility_unresolved_required',path+'/uncertainty','责任未知仍须保留缺陷，并说明真实断点和替代解释。');
  if(value.evidence_status==='uncertain'&&!gap(value.uncertainty))add('problem_uncertainty_required',path+'/uncertainty','缺陷待核须说明证据缺口与替代解释。');
  const transitions=(request.input.answer as {transitions:{transition_index:number;kind:string;actor_index:number|null;relation:string}[]}).transitions;
  if(!value.causes.length&&value.checks.some(c=>c.outcome==='changed'&&transitions.some(t=>t.transition_index===c.transition_index&&t.kind==='request_formation'&&t.relation==='captured'&&t.actor_index!==null)))
    add('responsibility_unresolved_captured_formation',path+'/uncertainty','参数形成边界已发生偏离且形成主体已采集，不能将主体写成未知。');
  if(value.causes.length&&value.causes.filter(c=>c.role==='primary').length!==1)add('responsibility_primary',path+'/causes','实际形成责任恰有一个主责；关联责任须有独立作用。');
  value.causes.forEach((cause,i)=>{
    const at=path+'/causes/'+i,actor=cause.actor_index===null?undefined:actors[cause.actor_index-1];
    if(cause.actor_index!==null&&!actor||cause.component!==responsibilityComponentName(actor))add('responsibility_actor',at,'责任主体名称必须由真实边界解析。');
    if(cause.actor_index===null&&(cause.certainty!=='inferred'||cause.mechanism_source!=='boundary_comparison'))add('responsibility_unknown_actor',at,'未知主体只能保留边界推断。');
    if(cause.certainty==='inferred'&&!gap(cause.uncertainty))add('responsibility_inference',at+'/uncertainty','机制推断须说明关键缺口和替代解释。');
    if(cause.certainty==='confirmed'&&cause.uncertainty)add('responsibility_certainty',at,'存在因果关键缺口时机制只能标为推断，缺陷确定性独立判断。');
    if(!cause.evidence_ids.length||cause.evidence_ids.some(id=>!ids.has(id)))add('responsibility_evidence',at+'/evidence_ids','责任证据必须来自本问题所选真实边界。');
    if(cause.certainty==='confirmed'&&actor&&!selected.some(e=>e&&!e.source&&cause.evidence_ids.includes(e.evidence_id)&&traceComponentOwnsEvidence(request.sources.answer.value as {messages:unknown[]},actor,e.evidence_id)))add('responsibility_actor_evidence',at,'确证责任须有实际主体的直接过程证据。');
    if(value.causes.slice(0,i).some(c=>c.transition_index===cause.transition_index))add('responsibility_duplicate',at,'一个问题中同一边界只登记一次责任。');
  });
  return issues;
}
