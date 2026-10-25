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
  return [...new Set([problem.component,...(problem.related_responsibilities??[]).map(row=>row.component)].filter(name=>name!==UNKNOWN_COMPONENT))];
}
export const UNKNOWN_COMPONENT = '责任主体未确定';
export const UNKNOWN_BOUNDARY = '问题形成过程未定位';

/** Describe captured process only. Defects and causal judgments remain model-owned. */
export function responsibilityDisplay(request: AgentRequest, index: number | null) {
  if (index === null) return { responsibility_boundary: UNKNOWN_BOUNDARY, component: UNKNOWN_COMPONENT };
  const answer = request.input.answer as { transitions: import('./transitions.js').AttributionTransition[];
    execution_nodes: import('./transitions.js').AttributionExecutionNode[]; business_chains: import('./types.js').BusinessChain[] };
  const boundary = answer.transitions.find(t => t.transition_index === index);
  if (!boundary) throw new Error('责任边界编号不存在');
  const actor = boundary.actor_index === null ? undefined : responsibilityIdentities(request)[boundary.actor_index - 1];
  const node = answer.execution_nodes.find(n => n.execution_node_index === boundary.execution_node_index);
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const message = node ? raw.messages[node.message_index] : undefined;
  const chain = answer.business_chains.find(c => c.chain_index === boundary.chain_index);
  const target = chain?.tool_component ?? '工具';
  const actions = { request_formation: `生成 ${target} 调用参数`, execution: '执行请求', generation: '生成回答正文',
    transfer: '传递上下文', delivery: '交付最终回答' };
  const input = chain ? raw.messages[chain.request_index]?.input : undefined;
  const query = input && typeof input === 'object' && 'query' in input && typeof input.query === 'string' ? input.query : undefined;
  const task = query ? `；查询“${query.length>70?query.slice(0,70)+'…':query}”` : '';
  const action = actions[boundary.kind] + task;
  const model = typeof message?.model === 'string' ? message.model : typeof message?.model_name === 'string' ? message.model_name : undefined;
  const name = actor?.identity_status === 'named' ? actor.component : model ?? (typeof message?.name === 'string' && message.name.trim() ? message.name : UNKNOWN_COMPONENT);
  const same = answer.execution_nodes.filter(n => n.kind === node?.kind && n.actor_index === node?.actor_index);
  const call = typeof message?.name === 'string' && message.name !== name ? message.name
    : node ? `第${same.findIndex(n => n.execution_node_index === node.execution_node_index) + 1}次调用` : undefined;
  const component = actor && name!==UNKNOWN_COMPONENT ? `${name}（${call ? call + '；' : ''}${action}）` : UNKNOWN_COMPONENT;
  const process = boundary.kind === 'request_formation' ? `根据本次实际输入形成 ${target} 请求参数`
    : boundary.kind === 'execution' ? '接收本次请求参数，返回执行结果'
    : boundary.kind === 'generation' ? '根据本次实际输入生成回答正文'
    : boundary.kind === 'transfer' ? '将上游返回或已生成内容传入下游实际输入'
    : '将生成内容作为最终回答交付';
  const ends = !boundary.before.length ? '；输入过程未采集' : !boundary.after.length ? '；输出过程未采集' : '';
  // The real invocation locator disambiguates otherwise identical captured calls.
  const occurrence = !node ? `（原始消息 ${boundary.after[0]?.message_index ?? boundary.before[0]?.message_index ?? '未采集'}）` : '';
  return { component, responsibility_boundary: `${component}：${process}${ends}${occurrence}。` };
}

export function responsibilityTransition(request: AgentRequest, description: string) {
  const transitions = (request.input.answer as { transitions: import('./transitions.js').AttributionTransition[] }).transitions;
  return transitions.find(t => responsibilityDisplay(request, t.transition_index).responsibility_boundary === description);
}

export function responsibilityIssues(request:AgentRequest,problem:unknown,_selected:readonly (Evidence|undefined)[],path:string):ValidationIssue[]{
  const value=problem as ProblemProposal,issues:ValidationIssue[]=[];
  const add=(code:string,at:string,message:string)=>issues.push({category:'decision',code,path:at,message});
  const seen=new Set<string>();
  for(const [i,r] of [value,...value.related_responsibilities??[]].entries()){
    const at=i?path+'/related_responsibilities/'+(i-1):path;
    const boundary=responsibilityTransition(request,r.responsibility_boundary);
    const expected=responsibilityDisplay(request,boundary?.transition_index??null);
    if(r.component!==expected.component||r.responsibility_boundary!==expected.responsibility_boundary)
      add('responsibility_actor',at,'主体与边界说明由程序解析本次真实调用，不由模型改写。');
    if((r.component===UNKNOWN_COMPONENT||(!i&&value.evidence_status==='待核实'))&&!r.uncertainties?.some(text=>text.trim()))
      add('responsibility_unresolved_required',at+'/uncertainties','责任未定位或缺陷待核实时须说明真实断点；没有隐藏推理不等于调用未知。');
    if(seen.has(r.responsibility_boundary))add('responsibility_duplicate',at,'同一问题的同一责任边界只登记一次。');
    seen.add(r.responsibility_boundary);
  }
  return issues;
}
