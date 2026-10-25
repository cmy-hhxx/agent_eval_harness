import { cite, evidenceSources,selectEvidenceSource } from "./evidence.js";
import {parseEvidenceCoordinates} from '@eval/contracts';
import {traceCallOrigins} from './trace-exchanges.js';
import { answerTurnContexts } from "./instructions.js";

export interface TraceComponentIdentity {
  component: string;
  kind: "model" | "tool" | "unknown";
  identity_status: "named" | "role_only" | "unknown_identity";
  role: "final_answer" | "model_call" | "tool" | "unknown";
  message_indices: number[];
  identity_evidence: ReturnType<typeof cite>[];
  identity_gap: string | null;
  /** Same generation, distinct captured reasoning and delivery boundaries. */
  generation_message_index?: number;
  generated_call_indices?: number[];
}

function inSource(raw:{messages:unknown[]},point:NonNullable<ReturnType<typeof parseEvidenceCoordinates>>,path:string){
  if(point.kind==='image')return false;
  if(point.kind==='text')return point.path===path||point.path.startsWith(path+'/');
  const sources=evidenceSources(raw.messages[point.message_index]),json=sources.filter(source=>source.kind==='json');
  const paths=sources.filter(source=>source.kind==='text'&&(source.path===path||source.path.startsWith(path+'/'))).map(source=>source.path);
  return paths.some(leaf=>{const range=selectEvidenceSource(json,leaf);
    return !!range&&point.path===range.source.path&&point.start<range.end&&range.start<point.end;});
}
export function isGeneratedCallEvidence(raw:{messages:unknown[]},actor:Pick<TraceComponentIdentity,'message_indices'>,evidenceId:string){
  const point=parseEvidenceCoordinates(evidenceId);if(!point)return false;
  return traceCallOrigins(raw.messages).some(origin=>actor.message_indices.includes(origin.planner_index)&&
    (point.message_index===origin.request_index&&inSource(raw,point,origin.input_path)||
      point.message_index===origin.planner_index&&inSource(raw,point,origin.arguments_path)));
}
export function traceComponentOwnsEvidence(raw:{messages:unknown[]},actor:TraceComponentIdentity,evidenceId:string){
  const point=parseEvidenceCoordinates(evidenceId);if(!point)return false;
  if(actor.message_indices.includes(point.message_index))return true;
  if(isGeneratedCallEvidence(raw,actor,evidenceId))return true;
  if(actor.generation_message_index!==point.message_index)return false;
  const generated=record(raw.messages[point.message_index]),outputs=Array.isArray(generated.output)?generated.output:[];
  return outputs.length===1&&typeof record(outputs[0]).content==='string'&&actor.message_indices.some(index=>
    record(raw.messages[index]).content===record(outputs[0]).content)&&inSource(raw,point,'/output/0/content');
}

/** These values locate executions; they do not name the actor responsible for them. */
export function isComponentLocator(value: string): boolean {
  return /^llm[-_]?call[-_: /]/iu.test(value) ||
    /^(?:span|trace|call|request|invocation|session|run|node|agent)[-_: /](?:\d+|[a-f\d-]{8,})$/iu.test(value) ||
    /^\d+$/u.test(value) ||
    /^(?:[a-f\d]{8,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(value) ||
    /^ev_/u.test(value);
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const toolRecord = (row: Record<string, unknown>) => row.role === "tool" ||
  ["function_call", "function_call_output", "tool_call", "tool_result"].includes(String(row.type)) ||
  row.type === "span" && String(row.name).startsWith("tool-");

/** Workflow-owned identities: retain raw names and coordinates; never rename the source trace. */
export function traceComponentIdentities(raw: { messages: unknown[] }, inputId: string, finalIndex: number): TraceComponentIdentity[] {
  const answerTurn = answerTurnContexts(raw, finalIndex).at(-1)?.message_index;
  const separateReasoning = answerTurn !== undefined && evidenceSources(raw.messages[answerTurn])
    .some(source=>source.kind==='text'&&source.text.trim()&&!source.path.startsWith('/input')&&/(?:^|\/)(?:reasoning(?:_content)?|analysis|thinking)(?:\/|$)/iu.test(source.path));
  const rows: TraceComponentIdentity[] = [];
  const calls = new Map<string, { index: number; row: Record<string, unknown> }>();
  const proof = (index: number, path: string) => {
    const source = evidenceSources(raw.messages[index]).find(source => source.kind === "text" && source.path === path);
    return source ? [cite(inputId, index, source, 0, source.text.length)] : [];
  };
  for (const [index, value] of raw.messages.entries()) {
    const row = record(value), tool = toolRecord(row), model = row.type === "llm_turn";
    const final = index === finalIndex;
    if (!tool && !model && !final && row.type !== "span") continue;
    if (["function_call", "tool_call"].includes(String(row.type)))
      for (const id of [row.call_id, row.id]) if (typeof id === "string" && id) calls.set(id, { index, row });
    const linked = calls.get(String(row.call_id ?? row.tool_call_id));
    const origin = tool && !row.name && linked ? linked : { index, row };
    const nameKey = ["node_name", "agent_name", "service_name", "tool_name", "name"].find(key =>
      typeof origin.row[key] === "string" && String(origin.row[key]).trim() && !isComponentLocator(String(origin.row[key]).trim()));
    let name = nameKey ? String(origin.row[nameKey]).trim() : undefined;
    const generationActor = final && separateReasoning ? rows.find(actor=>actor.message_indices.includes(answerTurn!)) : undefined;
    if (!name && generationActor?.identity_status === 'named') name=generationActor.component;
    const kind = tool ? "tool" : model || final ? "model" : "unknown";
    const role = tool ? "tool" : index === answerTurn && !separateReasoning || final ? "final_answer" : model ? "model_call" : "unknown";
    // A captured final is the same actor only when its actual generation is recorded.
    if (final && answerTurn !== undefined && !separateReasoning) {
      const actor = rows.find(actor => actor.message_indices.includes(answerTurn));
      if (actor) {
        if (name && actor.identity_status !== "named") {
          actor.component = name; actor.identity_status = "named"; actor.identity_gap = null;
          actor.identity_evidence.push(...proof(origin.index, `/${nameKey}`));
        }
        actor.message_indices.push(index); continue;
      }
    }
    const existing = tool && name ? rows.find(actor => actor.kind === "tool" && actor.component === name) : undefined;
    if (existing) { existing.message_indices.push(index); continue; }
    const fallback = role === "final_answer" ? "最终回答组织"
      : role === "model_call" ? "中间推理处理"
      : role === "tool" ? "工具执行"
      : "流程处理";
    rows.push({ component: name ?? fallback, kind, role,
      identity_status: name ? "named" : role === "unknown" || role === "model_call" ? "unknown_identity" : "role_only",
      ...(final && separateReasoning ? {generation_message_index:answerTurn} : {}),
      message_indices: [index], identity_evidence: nameKey ? proof(origin.index, `/${nameKey}`) : generationActor?.identity_status === 'named' ? [...generationActor.identity_evidence]
        : [...proof(index, "/type"), ...proof(index, "/role"), ...proof(index, "/name")],
      identity_gap: name ? role === "unknown" ? "轨迹提供了节点名称，但未提供可确认的职责角色。" : null : role === "model_call" || role === "unknown"
        ? "轨迹未提供真实节点名称及具体职责角色；仅按已采集记录定位，不推测业务节点名或模型型号。"
        : "轨迹未提供真实节点名称；名称仅表达可确认的轨迹角色，原调用标识留在证据导航中。" });
  }
  const origins=traceCallOrigins(raw.messages);
  for(const actor of rows){const calls=origins.filter(origin=>actor.message_indices.includes(origin.planner_index)).map(origin=>origin.request_index);
    if(calls.length)actor.generated_call_indices=calls;}
  const names = new Map<string, TraceComponentIdentity[]>();
  for (const row of rows) names.set(row.component, [...names.get(row.component) ?? [], row]);
  for (const duplicates of names.values()) if (duplicates.length > 1)
    duplicates.forEach(row => {
      row.identity_gap = "存在多条同名节点记录，无法确认是否属于同一业务节点；按轨迹记录分别定位。";
    });
  return rows;
}
