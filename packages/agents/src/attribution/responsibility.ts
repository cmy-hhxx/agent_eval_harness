import { canonical, ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";
import { isComponentLocator, traceComponentIdentities,traceComponentOwnsEvidence, type TraceComponentIdentity, answerTurnContexts, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource } from "@eval/tools";
import type { Evidence, ProblemProposal } from "./types.js";
import { isChineseAttributionText } from "./language.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolRecord = (value: Record<string, unknown>) => value.role === "tool" ||
  ["function_call", "function_call_output", "tool_call", "tool_result"].includes(String(value.type)) ||
  value.type === "span" && String(value.name).startsWith("tool-");
/** Workflow supplies the directory; no taxonomy labels or raw call IDs become actors. */
export function responsibilityIdentities(request: AgentRequest): TraceComponentIdentity[] {
  return (request.input.answer as { component_catalog: TraceComponentIdentity[] }).component_catalog;
}
export function responsibilityChoices(request: AgentRequest): string[] {
  return responsibilityIdentities(request).map(actor => actor.component);
}
export const responsibilityFunctions = Object.entries(attributionTaxonomy.domains).flatMap(([technical_domain, components]) =>
  components.map(functional_component => ({ technical_domain, functional_component })));
/** Names identify captured actors; the business position never becomes an invented component. */
export function responsibilityComponentName(actor:TraceComponentIdentity|undefined){
  if(!actor)return '';
  const role={model_call:'模型调用',final_answer:'终稿生成调用',tool:'工具调用',unknown:'处理节点'}[actor.role];
  return actor.identity_status==='named'?actor.component:`未命名${role}（消息 ${actor.message_indices.join('、')}）`;
}
export function componentCatalogIssues(request: AgentRequest): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: unknown[] };
  const answer = request.input.answer as { final_message_index: number };
  return canonical(responsibilityIdentities(request)) === canonical(traceComponentIdentities(raw, request.sources.answer.id, answer.final_message_index)) ? [] :
    [{ category: "evidence", code: "component_catalog", path: "/answer/component_catalog", message: "组件身份目录必须由本方实际轨迹构建，名称、角色、节点坐标与身份来源均须一致。" }];
}

/** A class cannot erase which captured component performed the failed function. */
export function responsibilityLabels(problem: Pick<ProblemProposal, "component">): string[] {
  return [...new Set(problem.component.map(row => `${row.component.trim()} / ${row.chain_step} / ${row.functional_component}`))];
}

export function responsibilitySchema(evidenceField: "evidence_ids" | "evidence_indices") {
  const text = { type: "string", minLength: 1 };
  return {
    type: "object", additionalProperties: false,
    required: ["actor_index", "role", "technical_domain", "functional_component", "component", "business_component", "chain_index", "chain_step", "field_names", "mechanism_source", "failure_stage", "mechanism", "certainty", "reason", evidenceField, "evidence_gap", "alternatives"],
    properties: {
      actor_index: { type: "integer", minimum: 1 },
      role: { enum: ["primary", "contributing"] }, technical_domain: text, functional_component: text, component: { ...text },
      business_component: text, chain_index: { type: ["integer", "null"], minimum: 1 },
      chain_step: { enum: attributionTaxonomy.investigation_steps }, field_names: { type: "array", uniqueItems: true, items: text },
      mechanism_source: { enum: ["explicit_process", "boundary_comparison"] },
      failure_stage: { enum: attributionTaxonomy.stages }, mechanism: text,
      certainty: { enum: ["confirmed", "inferred"] }, reason: text,
      [evidenceField]: { type: "array", minItems: 1, uniqueItems: true,
        items: evidenceField === "evidence_ids" ? text : { type: "integer", minimum: 1 } },
      evidence_gap: { type: ["string", "null"], minLength: 1 },
      alternatives: { type: "array", uniqueItems: true, items: text },
    },
    allOf: [{ oneOf: Object.entries(attributionTaxonomy.domains).map(([domain, components]) => ({
      properties: { technical_domain: { const: domain }, functional_component: { enum: components } },
    })) }],
  };
}

/** Confirmed causes need their own process evidence; inference never means an empty responsibility. */
export function responsibilityIssues(request: AgentRequest, problem: unknown, selected: readonly (Evidence | undefined)[], path: string): ValidationIssue[] {
  const rows = object(problem)?.component;
  if (!Array.isArray(rows)) return [];
  const issues: ValidationIssue[] = [...componentCatalogIssues(request)], actors = responsibilityIdentities(request);
  const raw = request.sources.answer?.value as { messages: unknown[] };
  const selectedIds = new Set(selected.flatMap(item => item ? [item.evidence_id] : []));
  const add = (code: string, location: string, message: string, actual?: unknown) =>
    issues.push({ category: "evidence", code, path: location, message, actual });
  if (rows.filter(row => object(row)?.role === "primary").length !== 1)
    add("responsibility_primary", `${path}/component`, "每条问题必须且只能有一个主责；其他有独立作用的原因标 contributing，不得留空。");
  const seen = new Set<string>();
  rows.forEach((entry, index) => {
    const row = object(entry); if (!row) return;
    const location = `${path}/component/${index}`;
    const actor = Number.isSafeInteger(row.actor_index) ? actors[Number(row.actor_index) - 1] : undefined;
    if (typeof row.component === "string" && isComponentLocator(row.component))
      add("responsibility_actor_locator", `${location}/component`, "调用ID、span ID及UUID只能用于导航，不能作为实际组件名称。", row.component);
    if (!actor || responsibilityComponentName(actor) !== row.component) add("responsibility_actor", `${location}/actor_index`, "主体按节点编号和来源定位；真实名称原样保留，匿名主体保留角色、未命名状态和消息坐标；业务位置不能冒充组件名称。", row.actor_index);
    const modelActor = actor?.kind === "model";
    if (modelActor && ["工具业务实现", "工具接入与协议"].includes(String(row.technical_domain)))
      add("responsibility_actor_domain", location, "llm_turn是模型节点，不能因有name而认作工具；定位其推断、控制或实际相关技术功能。", row.component);
    if (!attributionTaxonomy.domains[String(row.technical_domain)]?.includes(String(row.functional_component)) ||
      !attributionTaxonomy.stages.includes(String(row.failure_stage)))
      add("responsibility_taxonomy", location, "技术域、二级功能组件与出错环节须选择固定目录，具体失误写 mechanism。", entry);
    const refs = Array.isArray(row.evidence_ids) ? row.evidence_ids : [];
    if (typeof row.mechanism === "string" && !isChineseAttributionText(row.mechanism))
      add("responsibility_mechanism_language", `${location}/mechanism`, "具体失误机制须用中文短文说明本次错误动作，保留必要的专有名词。");
    if(typeof row.mechanism==='string'&&['模型推理问题','模型能力不足','模型推断与生成','模型理解错误','模型推理错误','模型生成错误',
      '终稿调用','终稿有问题','终稿理解错误','终稿生成错误','终稿输出错误','终稿调用输出了错误答案']
      .includes(row.mechanism.replace(/[\s。！!；;，,：:]/gu,'')))
      add('responsibility_mechanism_generic',`${location}/mechanism`,
        '节点输出了错误答案只是位置，不能用模型推理、能力或终稿调用标签结束归因。指出哪个具体事实、字段、来源或计算，在所选节点的哪个处理动作上发生偏离，并引用相关输入输出边界；未知上游处理者明确留缺口，隐藏机制保留推断。',row.mechanism);
    if (!refs.length || refs.some(id => !selectedIds.has(String(id))))
      add("responsibility_evidence", `${location}/evidence_ids`, "每个责任分别引用本条 finding 已选择的真实证据，不能编造编号。");
    if (row.certainty === "inferred" && (typeof row.evidence_gap !== "string" || !row.evidence_gap.trim() || !Array.isArray(row.alternatives) || !row.alternatives.length))
      add("responsibility_inference", location, "推断责任必须说明关键证据缺口，并给出已考虑的其他可能解释；仍须选出最可能主责。");
    if (row.certainty === "confirmed") {
      if (row.evidence_gap !== null) add("responsibility_certainty", `${location}/evidence_gap`, "确证责任的 evidence_gap 为 null；因果关键材料仍缺失时改为 inferred，不改变缺陷确定性。");
      const own = selected.filter((item): item is Evidence => !!item && !item.source && refs.includes(item.evidence_id));
      if (actor && !own.some(item=>traceComponentOwnsEvidence(raw,actor,item.evidence_id)))
        add("responsibility_actor_evidence", location, "确证责任须有所选具体节点的实际证据，同名其他节点的材料不能替代。");
      const messages = own.map(item => ({ item, message: object(raw.messages[item.message_index]), point: parseEvidenceCoordinates(item.evidence_id) }));
      const actualTool = actor?.kind === "tool" && messages.some(({ message, item }) => message && toolRecord(message) && actor.message_indices.includes(item.message_index));
      if (["工具业务实现", "工具接入与协议"].includes(String(row.technical_domain)) && !actualTool)
        add("responsibility_process_missing", location, "确证工具责任须引用该工具的实际请求、返回或接入过程；只有最终错误时须标推断。");
      const contexts = answerTurnContexts(raw, (request.input.answer as {final_message_index:number}).final_message_index);
      const actualInput = messages.some(({ item, point }) => point && point.kind !== "image" && contexts.some(context => {
        if (context.message_index !== item.message_index) return false;
        if (point.kind === "text") return point.path.startsWith(context.path + "/");
        const range = selectEvidenceSource(evidenceSources(raw.messages[item.message_index]), context.path);
        return range && point.path === range.source.path && point.start >= range.start && point.end <= range.end;
      }));
      if (row.technical_domain === "上下文工程" && !actualInput)
        add("responsibility_process_missing", location, "确证上下文传递责任须引用实际模型输入快照，不能把原始工具返回当作模型已收到的内容。");
      if (["运行环境与资源", "交付与呈现"].includes(String(row.technical_domain)) && !messages.some(({ message }) => message && (toolRecord(message) || message.type === "llm_turn")))
        add("responsibility_process_missing", location, "确证环境或呈现责任须有本方真实过程证据；纯最终回答及采集缺口不能证明故障。");
    }
    const key = JSON.stringify([row.technical_domain, row.functional_component, row.actor_index, row.failure_stage, row.mechanism]);
    if (seen.has(key)) add("responsibility_duplicate", location, "同一失误机制只记一次，不能重复列为主责和关联责任。");
    seen.add(key);
  });
  return issues;
}

export function resolveProblemSubmission(request: AgentRequest, problem: ProblemProposal, selected: readonly (Evidence | undefined)[], path: string): ProblemProposal {
  const issues = responsibilityIssues(request, problem, selected, path);
  if (issues.length) throw new ValidationError(issues);
  return structuredClone(problem);
}
