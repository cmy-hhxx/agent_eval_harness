import { canonical, parseEvidenceCoordinates, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy, type AttributionComponent } from "@eval/prompts";
import { isComponentLocator, traceComponentIdentities, type TraceComponentIdentity } from '@eval/tools';
import type { AttributionTransition } from "./transitions.js";

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
export const UNKNOWN_COMPONENT = '责任主体未确定';
export interface ResponsibilityMaterial {
  transitions: AttributionTransition[];
  execution_nodes: import('./transitions.js').AttributionExecutionNode[];
  business_chains: import('./types.js').BusinessChain[];
}

const COMPONENTS = attributionTaxonomy.components as Record<string, AttributionComponent>;
const component = (code: string): AttributionComponent | undefined => COMPONENTS[code];
const label = (code: string): string => component(code)?.label ?? UNKNOWN_COMPONENT;

const componentAliases: Record<string,string> = {
  finquery:"finquery", "finquery.py":"finquery-script", search:"web-search", web_search:"web-search",
  websearch:"web-search", web_fetch:"web-fetch", web_fetch_url:"web-fetch", accessingfulltext:"web-fetch",
  shell:"shell", "data-visualizer":"data-visualizer", view_skill:"view-skill", read_file:"view-skill",
  stock_ner_parse:"stock-ner", memory:"memory", "终稿生成轮":"final-generation", "final-generation":"final-generation",
};

/** Map metadata tool/skill text to the stable taxonomy component display. */
export function attributionComponentLabel(name: string): string {
  const value=name.trim();
  if (isComponentLocator(value))
    return /^llm[-_]?call[-_: /]/iu.test(value) ? "中间推理处理" : "流程处理";
  const direct=component(value);
  if(direct)return direct.label;
  const matching=Object.values(COMPONENTS).find(component=>component.label===value);
  if(matching)return matching.label;
  const code=componentAliases[value.toLowerCase()];
  if(code)return label(code);
  if (["中间推理处理", "流程处理", "工具执行"].includes(value)) return value;
  return value===UNKNOWN_COMPONENT?UNKNOWN_COMPONENT:`${label("other-tools")}（${value}）`;
}

/** Scripts run through shell are separate tool-dimension components, not generic shell. */
function commandText(message: Record<string, unknown>): string {
  const input = message.input;
  const value = typeof input === "string" ? input
    : input && typeof input === "object" ? (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).arguments ?? (input as Record<string, unknown>).cmd
    : undefined;
  if (typeof value === "string") return value;
  for (const key of ["arguments", "input"]) {
    const raw = message[key];
    if (typeof raw !== "string") continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const command = parsed.command ?? parsed.arguments;
      if (typeof command === "string") return command;
    } catch { /* not JSON; keep the raw command below */ }
    if (key === "arguments") return raw;
  }
  return "";
}
function executionCode(tool: string | undefined, message: Record<string, unknown>): string | null {
  if (!tool) return null;
  if (tool === "shell") {
    const command = commandText(message);
    if (/finquery(?:\.py|\b)/iu.test(command)) return "finquery-script";
    if (/data-visualizer/iu.test(command)) return "data-visualizer";
    return "shell";
  }
  const known: Record<string,string> = { finquery:"finquery", web_search:"web-search", web_fetch:"web-fetch",
    view_skill:"view-skill", read_file:"view-skill", stock_ner_parse:"stock-ner", aime_memory_read:"memory",
    query_user_positions:"memory", get_user_context:"memory", runtime:"tool-runtime", render:"output-render" };
  return known[tool] ?? "other-tools";
}
function boundaryTextLength(boundaries: readonly {evidence_id:string}[]): number {
  return boundaries.reduce((total, item) => {
    const point = parseEvidenceCoordinates(item.evidence_id);
    return total + (point && point.kind !== "image" ? Math.max(0, point.end - point.start) : 0);
  }, 0);
}
/** A transfer is selectable only when the material actually shrank before reaching the model. */
export function transferChanged(_answer: ResponsibilityMaterial, _raw: { messages: Record<string, unknown>[] }, boundary: AttributionTransition): boolean {
  if (boundary.kind !== "transfer" || !boundary.before.length || !boundary.after.length) return false;
  const before = boundaryTextLength(boundary.before), after = boundaryTextLength(boundary.after);
  return before > 0 && after < before * 0.5;
}

/** Stable component code for navigation, reporting and gating; labels stay display-only. */
export function responsibilityCode(answer: ResponsibilityMaterial, raw: { messages: Record<string, unknown>[] }, index: number | null): string | null {
  if (index === null) return null;
  const boundary = answer.transitions.find(t => t.transition_index === index);
  if (!boundary) throw new Error('责任边界编号不存在');
  if (boundary.kind === 'transfer') return transferChanged(answer, raw, boundary) ? 'context-transfer' : null;
  if (boundary.kind === 'delivery') return null;
  const node = answer.execution_nodes.find(n => n.execution_node_index === boundary.execution_node_index);
  if (!node) return null;
  const message = raw.messages[node.message_index] ?? {};
  if (boundary.kind === 'execution') {
    const chain = answer.business_chains.find(c => c.chain_index === boundary.chain_index);
    const tool = chain?.tool_component ?? (node.kind === 'tool' && typeof message.name === 'string' ? message.name : undefined);
    return executionCode(tool, message);
  }
  if (boundary.kind === 'generation' || boundary.kind === 'request_formation') {
    if (message.name === 'planner-finquery') return 'planner-finquery';
    if (message.name === 'planner-search') return 'planner-search';
    if (boundary.kind === 'generation' && answer.transitions.some(t => t.kind === 'delivery' && t.source_node_index === node.execution_node_index)) return 'final-generation';
    return 'expert-reasoning';
  }
  return null;
}

/** Names describe captured actions, never the alleged defect or an invented agent. */
export function responsibilityComponent(answer: ResponsibilityMaterial, raw: { messages: Record<string, unknown>[] }, index: number | null): string {
  const code = responsibilityCode(answer, raw, index);
  if (!code) return UNKNOWN_COMPONENT;
  if (code !== 'other-tools') return label(code);
  const boundary = answer.transitions.find(t => t.transition_index === index);
  const node = answer.execution_nodes.find(n => n.execution_node_index === boundary?.execution_node_index);
  const message = node ? raw.messages[node.message_index] ?? {} : {};
  const chain = answer.business_chains.find(c => c.chain_index === boundary?.chain_index);
  const tool = chain?.tool_component ?? (typeof message.name === 'string' ? message.name : undefined);
  return tool ? `${label("other-tools")}（${tool}）` : label("other-tools");
}
export function responsibilityDisplay(request: AgentRequest, index: number | null) {
  return {component: responsibilityComponent(request.input.answer as unknown as ResponsibilityMaterial,
    request.sources.answer.value as {messages:Record<string,unknown>[]}, index)};
}

/** Only captured calls and observed material changes are selectable responsibility boundaries. */
export function selectableTransitions(request: AgentRequest): AttributionTransition[] {
  const answer = request.input.answer as unknown as ResponsibilityMaterial;
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  return answer.transitions.filter(t => t.execution_node_index !== null ||
    t.kind === "transfer" && transferChanged(answer, raw, t));
}
