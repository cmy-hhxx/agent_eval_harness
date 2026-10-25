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
export interface ResponsibilityMaterial {
  transitions: import('./transitions.js').AttributionTransition[];
  execution_nodes: import('./transitions.js').AttributionExecutionNode[];
  business_chains: import('./types.js').BusinessChain[];
}

/** Names describe captured actions, never the alleged defect or an invented agent. */
export function responsibilityComponent(answer: ResponsibilityMaterial, raw: { messages: Record<string, unknown>[] }, index: number | null): string {
  if (index === null) return UNKNOWN_COMPONENT;
  const boundary = answer.transitions.find(t => t.transition_index === index);
  if (!boundary) throw new Error('责任边界编号不存在');
  const node = answer.execution_nodes.find(n => n.execution_node_index === boundary.execution_node_index);
  if (!node) return UNKNOWN_COMPONENT;
  const message = raw.messages[node.message_index];
  const chain = answer.business_chains.find(c => c.chain_index === boundary.chain_index);
  const tool = chain?.tool_component ?? (node.kind === 'tool' && typeof message.name === 'string' ? message.name : undefined);
  if (boundary.kind === 'execution') {
    const labels: Record<string,string> = {finquery:'finquery 取数服务',shell:'shell 代码解释器',web_search:'web_search 网页检索',web_fetch:'web_fetch 网页抓取',read_file:'view_skill / read_file 技能加载',view_skill:'view_skill / read_file 技能加载',stock_ner_parse:'stock_ner_parse 实体识别',aime_memory_read:'记忆与用户上下文工具',query_user_positions:'记忆与用户上下文工具',runtime:'工具调用运行时',render:'输出后处理与渲染'};
    return tool ? labels[tool] ?? `工具（${tool}）` : UNKNOWN_COMPONENT;
  }
  if (boundary.kind === 'generation' || boundary.kind === 'request_formation') {
    if (message.name === 'planner-finquery') return 'planner-finquery 取数规划子模型';
    if (message.name === 'planner-search') return 'planner-search 检索规划子模型';
    if (boundary.kind === 'generation' && answer.transitions.some(t => t.kind === 'delivery' && t.source_node_index === node.execution_node_index)) return '终稿生成轮';
    return 'Expert 推理轮';
  }
  return UNKNOWN_COMPONENT;
}
export function responsibilityDisplay(request: AgentRequest, index: number | null) {
  return {component: responsibilityComponent(request.input.answer as unknown as ResponsibilityMaterial,
    request.sources.answer.value as {messages:Record<string,unknown>[]}, index)};
}

export function responsibilityIssues(request:AgentRequest,problem:unknown,_selected:readonly (Evidence|undefined)[],path:string):ValidationIssue[]{
  const value=problem as ProblemProposal,issues:ValidationIssue[]=[];
  const choices=new Set([UNKNOWN_COMPONENT,...(request.input.answer as unknown as ResponsibilityMaterial).transitions.filter(t=>t.execution_node_index!==null).map(t=>responsibilityDisplay(request,t.transition_index).component)]);
  for(const [i,r] of [value,...value.related_responsibilities??[]].entries()){
    const at=i?path+'/related_responsibilities/'+(i-1):path;
    if(!choices.has(r.component))issues.push({category:'decision',code:'responsibility_actor',path:at,message:'组件名称由本任务真实调用职责生成。'});
    if((r.component===UNKNOWN_COMPONENT||(!i&&value.evidence_status==='待核实'))&&!r.uncertainties?.some(text=>text.trim()))
      issues.push({category:'decision',code:'responsibility_unresolved_required',path:at+'/uncertainties',message:'责任未定位或缺陷待核实时须说明真实断点；没有隐藏推理不等于调用未知。'});
  }
  const answer=request.input.answer as unknown as ResponsibilityMaterial;
  for(const [i,item] of (value.responsibility_chain??[]).entries()){
    const at=path+'/responsibility_chain/'+i;
    const captured=item.component===null?item.message_index===null&&['input','transfer'].includes(item.stage):
      answer.transitions.some(t=>t.kind===item.stage&&responsibilityDisplay(request,t.transition_index).component===item.component&&
        answer.execution_nodes.some(n=>n.execution_node_index===t.execution_node_index&&n.message_index===item.message_index));
    if(!captured||item.role==='primary'&&item.component!==value.component||item.role==='related'&&!value.related_responsibilities?.some(r=>r.component===item.component))
      issues.push({category:'evidence',code:'responsibility_chain_identity',path:at,message:'责任链的调用身份和责任角色由程序解析，不能编造组件或把输入状态当作责任。'});
  }
  return issues;
}
