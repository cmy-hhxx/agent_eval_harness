import { canonical, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { traceComponentIdentities, type TraceComponentIdentity } from '@eval/tools';
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
export function responsibilityLabels(problem: Pick<ProblemProposal, 'component' | 'related_responsibilities'>): string[] {
  return [...new Set([problem.component,...(problem.related_responsibilities??[]).map(row=>row.component)].filter((name):name is string=>name!==null))];
}
/** Identity is resolved from registered boundaries; mechanisms are model judgments. */
export function responsibilityIssues(request:AgentRequest,problem:unknown,selected:readonly (Evidence|undefined)[],path:string):ValidationIssue[]{
  const value=problem as ProblemProposal,issues:ValidationIssue[]=[];
  const actors=responsibilityIdentities(request);
  const transitions=(request.input.answer as {transitions:{transition_index:number;actor_index:number|null}[]}).transitions;
  const add=(code:string,at:string,message:string)=>issues.push({category:'evidence',code,path:at,message});
  const gap=(items:string[]|undefined)=>!!items?.some(item=>item.trim());
  if((value.evidence_status==='待核实'||value.component===null)&&!gap(value.uncertainties))
    add('responsibility_unresolved_required',path+'/uncertainties','缺陷待核实或责任未知时说明真实缺口；缺少内部推理不等于实际调用未知。');
  const rows=[value,...value.related_responsibilities??[]];
  const seen=new Set<number>();
  rows.forEach((r,i)=>{
    const at=i?path+'/related_responsibilities/'+(i-1):path;
    if(r.responsibility_boundary===null){if(r.component!==null)add('responsibility_actor',at,'未定位边界时不能填写主体。');return;}
    const boundary=transitions.find(t=>t.transition_index===r.responsibility_boundary);
    if(!boundary){add('responsibility_transition',at,'选择本次真实边界编号。');return;}
    const actual=boundary.actor_index===null?null:responsibilityComponentName(actors[boundary.actor_index-1]);
    if(r.component!==actual)add('responsibility_actor',at,'主体完全由所选实际边界解析，已知参数生成者不能写为未知。');
    if(seen.has(r.responsibility_boundary))add('responsibility_duplicate',at,'同一问题的同一责任边界只登记一次。');
    seen.add(r.responsibility_boundary);
    if(i){const r=value.related_responsibilities![i-1];
      if(r.evidence_ids.some(id=>!selected.some(e=>e?.evidence_id===id)))add('responsibility_evidence',at,'关联责任须引用本问题证据。');
      if(r.component===null&&!gap(r.uncertainties))add('responsibility_unresolved_required',at,'关联主体未知须说明真实断点。');
    }
  });
  return issues;
}
