import { ValidationError, resolveEvidenceSelection, type AgentDefinition, type AgentProfile, type JsonObject } from "@eval/contracts";
import { resolveEvidence, parseEvidenceCoordinates, isComponentLocator } from "@eval/tools";
import { agentPrompt, compactFields, compactOutputGuidance } from "@eval/prompts";
import schema from "../../../../schemas/compact/result.schema.json" with { type: "json" };

export interface SessionCompact extends JsonObject {
  session_overview: string[];
  session_meta: JsonObject;
  trace_meta: JsonObject[];
  turns: (JsonObject & { turn_idx: number; final_answer: string })[];
}
export const compactResultSchema = schema;
export { compactFields };
const prompt = agentPrompt("compact", [], { fileSubmission: false });
const anonymousActor = (actor: JsonObject) => actor.kind === "model" && (actor.anonymous === true || isComponentLocator(String(actor.name)));
const anonymousRoles = ["规划", "推理", "答案合成"];
const invocationCount = /第\s*[\d零一二两三四五六七八九十百]+\s*次(?!性)[^。；\n]{0,16}(?:调用|shell|finquery)|(?:共|合计|总计|累计)[^。；\n]{0,12}[\d零一二两三四五六七八九十百]+\s*次(?!性)[^。；\n]{0,12}(?:调用|工具)|(?:调用|工具)[^。；\n]{0,16}[\d零一二两三四五六七八九十百]+\s*次(?!性)/u;
function componentMergeGroups(rows: JsonObject[]) {
  if (!Array.isArray(rows)) return [];
  const groups = new Map<string, { name: unknown; rows: number[]; actor_indices: Set<number>; evidence: Set<number> }>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const key = JSON.stringify([row.components_kind, row.components_name]);
    const group = groups.get(key) ?? { name: row.components_name, rows: [], actor_indices: new Set(), evidence: new Set() };
    group.rows.push(index);
    for (const value of Array.isArray(row.actor_indices) ? row.actor_indices as number[] : []) group.actor_indices.add(value);
    for (const value of Array.isArray(row.evidence) ? row.evidence as number[] : []) group.evidence.add(value);
    groups.set(key, group);
  });
  return [...groups.values()].filter(group => group.rows.length > 1).map(group => ({ ...group,
    actor_indices: [...group.actor_indices], evidence: [...group.evidence] }));
}
export const compactProfile: AgentProfile = {
  id: "default", requestSchema: { type: "object", required: ["turn_count", "session_meta", "trace_meta"] },
  submissionSchema: schema, resultSchema: schema,
  ...prompt, toolNames: [], maxToolCalls: 0,
  resolve(request, draft) {
    const value = draft as SessionCompact;
    if (value.turns.length !== request.input.turn_count || value.trace_meta.length !== value.turns.length ||
        value.turns.some((turn, index) => turn.turn_idx !== index))
      throw new ValidationError([{ category: "decision", code: "compact_turns", path: "/turns",
        message: "摘要必须按输入顺序覆盖每个实际收到的 turn，turn_idx 从0开始，trace_meta 同序。" }]);
    for (const [turnIndex, turn] of value.turns.entries()) for (const field of Object.keys(compactFields).filter(field => field !== "session_overview")) {
      const item = (schema.properties.turns.items.properties as Record<string, JsonObject>)[field]!.items as JsonObject;
      const indexKey = Object.keys(item.properties as JsonObject).find(key => key.endsWith("_idx"))!;
      if ((turn[field] as JsonObject[]).some((entry, index) => entry[indexKey] !== index + 1))
        throw new ValidationError([{ category: "structure", code: "compact_indices", path: "/turns/" + turnIndex + "/" + field,
          message: "条目 idx 必须由程序从1开始连续生成。" }]);
    }
    return { ...value, session_meta: request.input.session_meta, trace_meta: request.input.trace_meta };
  },
};
export const compactFieldProfiles: Record<string, AgentProfile> = Object.fromEntries(Object.entries(compactFields).map(([field, definition]) => {
  const valueSchema = definition.scope === "session" ? { type: "array", minItems: 2, maxItems: 2, items: { type: "string", minLength: 1 } }
    : (schema.properties.turns.items.properties as Record<string, JsonObject>)[field]!;
  const properties = (valueSchema.items as JsonObject).properties as JsonObject | undefined;
  const indexKey = properties && Object.keys(properties).find(key => key.endsWith("_idx"))!;
  const modelValueSchema = properties ? { type: "array", items: { type: "object", additionalProperties: false,
    required: [...Object.keys(properties).filter(key => key !== indexKey && !(field === "key_data" && key === "key_data_content")), ...(field === "components" ? ["actor_indices"] : [])],
    properties: { ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== indexKey && !(field === "key_data" && key === "key_data_content"))),
      ...(field === "components" ? { actor_indices: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 1 } } } : {}),
      evidence: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", minimum: 1 } } } } } : valueSchema;
  const wrap = (value: unknown) => ({ type: "object", required: ["value"], additionalProperties: false, properties: { value } });
  return [field, { ...prompt, id: field, requestSchema: { type: "object" },
    systemPrompt: prompt.systemPrompt + "\n\n" + compactOutputGuidance.field_task.replace("{field}", field)
      .replace("{type}", "array").replace("{instruction}", definition.instruction),
    submissionSchema: wrap(modelValueSchema), resultSchema: wrap(valueSchema), toolNames: [], maxToolCalls: 0,
    evidenceSelections: true, maxEvidenceQuoteChars: 400,
    renderPrompt(input, policy, recovery) {
      const example = structuredClone(definition.submission_example!);
      const turns = (input.turns ?? []) as JsonObject[];
      const excerpts = turns.flatMap(turn => [...turn.final_evidence as JsonObject[] ?? [], ...turn.process_excerpts as JsonObject[] ?? []]);
      const index = (excerpts.find(entry => Number.isSafeInteger((entry.reference as JsonObject | undefined)?.evidence_index))?.reference as JsonObject | undefined)?.evidence_index;
      if (field !== "session_overview") {
        if (index === undefined) example.value = [];
        else for (const entry of example.value as JsonObject[]) entry.evidence = [index];
      }
      if (field === "components") {
        const actors = input.recorded_components as JsonObject[] ?? [];
        const models = actors.filter(anonymousActor);
        example.value = [...(models.length > 1 ? [{ components_kind: "model", components_name: "规划",
          components_content: "为推进本轮业务请求，合并可见的规划与调整；指导后续执行。",
          actor_indices: models.slice(0, -1).map(actor => actor.actor_index), evidence: index === undefined ? [] : [index] }] : []),
          ...(models.length ? [{ components_kind: "model", components_name: "答案合成",
          components_content: "为完成本轮业务请求，分析已取得的材料；输出具体答复。",
          actor_indices: [models.at(-1)!.actor_index], evidence: index === undefined ? [] : [index] }] : []),
          ...actors.filter(actor => !anonymousActor(actor)).map(actor => ({ components_kind: actor.kind, components_name: actor.name,
            components_content: "为完成本轮业务请求，执行该组件的实际动作；根据原文概括结果。",
            actor_indices: [actor.actor_index], evidence: index === undefined ? [] : [index] }))];
      }
      const repair = recovery?.draft !== undefined && recovery.errors.length
        ? { previous_submission: recovery.draft, errors: recovery.errors, instruction: compactOutputGuidance.repair_instruction,
          ...(field === "components" ? { merge_groups: componentMergeGroups((recovery.draft as JsonObject).value as JsonObject[] ?? []) } : {}) } : undefined;
      return prompt.renderPrompt({ ...input, target_field: field, field_value_type: "array",
        submission_example: example, ...(repair ? { field_repair: repair } : {}) }, policy, repair ? undefined : recovery);
    },
    resolve(request, draft, audit) {
      const countPhrase = field !== "key_data" && JSON.stringify((draft as JsonObject).value).match(invocationCount);
      if (countPhrase)
        throw new ValidationError([{ category: "structure", code: "compact_call_count", path: "/value", actual: countPhrase[0],
          message: "调用次数仅由程序统计和组装，摘要不写共N次或第N次调用；用简要动作、结果及 evidence 导航，不把消息序号当调用次数。" }]);
      if (field === "session_overview") return draft;
      const recorded = request.input.recorded_components as JsonObject[] ?? [], selected = new Set<number>();
      const value: JsonObject[] = ((draft as JsonObject).value as JsonObject[]).map((entry, index) => {
        const { actor_indices, ...content } = entry;
        const actors = field === "components" ? (actor_indices as number[]).map(id => {
          const actor = recorded.find(actor => actor.component_index === id);
          if (!actor || actor.kind !== entry.components_kind)
            throw new ValidationError([{ category: "structure", code: "component_actor", path: "/value/" + index + "/actor_indices",
              message: "actor_indices 只能选择本轮同类型的 recorded_components 编号，具名来源不能重复分配；不要按输出条目顺序另编来源编号。", actual: id,
              expected: { available_actors: recorded.filter(item => item.kind === entry.components_kind).map(item => ({ actor_index: item.component_index, name: item.name })) } }]);
          selected.add(id); return actor;
        }) : [];
        if (field === "components" && actors.some(anonymousActor) &&
            (!actors.every(anonymousActor) || !anonymousRoles.includes(String(entry.components_name))))
          throw new ValidationError([{ category: "structure", code: "component_anonymous_role", path: "/value/" + index + "/components_name",
            message: "匿名模型调用只按可见职责归为规划、推理或答案合成；同类合并，不另起业务名，不与具名 Agent 合并。" }]);
        if (field === "components" && actors.some(actor => actor.kind === "model" && !anonymousActor(actor)) &&
            (actors.length !== 1 || actors[0]!.name !== entry.components_name))
          throw new ValidationError([{ category: "structure", code: "component_named_actor", path: "/value/" + index + "/components_name",
            message: "明确命名的 Agent 保留真实名称并单列，不改成职责别名，不与匿名调用合并。", expected: actors.map(actor => actor.name) }]);
        if (field === "components" && (isComponentLocator(String(entry.components_name)) ||
            actors.some(actor => actor.kind === "model" && (actor.identity_status === "located" && actor.name === entry.components_name || actor.model === entry.components_name))))
          throw new ValidationError([{ category: "structure", code: "component_locator_name", path: "/value/" + index + "/components_name",
            message: "components_name 必须说明本轮的实际业务职责，不能使用 llm-call、消息编号或调用 ID。来源身份通过 actor_indices 选择。" }]);
        if (field === "components" && entry.components_kind === "script" && /\.jsonl?$/iu.test(String(entry.components_name)))
          throw new ValidationError([{ category: "structure", code: "component_data_file", path: "/value/" + index + "/components_name",
              message: "JSON 数据或配置文件不是执行脚本组件，删除该项，不改成其他组件类型。key_data 只摘录终稿中的数据。" }]);
        const evidence = (entry.evidence as number[]).map((selection, ordinal) => {
          const path = "/value/" + index + "/evidence/" + ordinal;
          const reference = resolveEvidenceSelection(audit.evidenceBank ?? [], { evidence_index: selection }, path);
          const item = resolveEvidence(request.sources.answer!.value as { messages: unknown[] }, reference, "answer", audit, path, request.sources.answer!.id);
          const point = parseEvidenceCoordinates(item.evidence_id)!;
          const position = (request.input.source_positions as JsonObject[])[item.message_index];
          if (point.kind === "image" || item.quote.length > 400 || request.input.trace_index !== undefined && position.trace_index !== request.input.trace_index)
            throw new ValidationError([{ category: "evidence", code: "compact_evidence_scope", path,
              message: "只选择当前轮已呈现的不超过400字的原文编号。" }]);
          if (field === "key_data" && (item.message_index !== request.input.final_message_index || point.kind !== "text" || !/^\/content(?:\/|$)/u.test(point.path)))
            throw new ValidationError([{ category: "evidence", code: "compact_key_data_source", path,
              message: "key_data 只能选择本轮最终回复的原文短句或表格行；不能选择工具、数值菜单、用户请求或交叉核验材料。" }]);
          return { evidence_id: item.evidence_id, quote: item.quote };
        });
        if (field === "components" && entry.components_kind !== "model" && actors.some(actor => actor.identity_status !== "located" && actor.name !== entry.components_name))
          throw new ValidationError([{ category: "structure", code: "component_actor_name", path: "/value/" + index + "/components_name",
            message: "已记录工具、脚本和 skill 必须各自使用目录中的实际名称，不能将不同主体合并或改名。", expected: actors.map(actor => actor.name) }]);
        const identity = actors.flatMap(actor => (actor.source_evidence as JsonObject[]).map(item => ({
          evidence_id: String((item.reference as JsonObject).evidence_id), quote: String(item.quote),
        })));
        return { [indexKey!]: index + 1, ...content,
          ...(field === "key_data" ? { key_data_content: evidence.map(item => item.quote).join("\n") } : {}),
          evidence: [...new Map([...evidence, ...identity].map(item => [item.evidence_id, item])).values()] };
      });
      if (field === "components" && new Set(value.map(entry => JSON.stringify([entry.components_kind, entry.components_name]))).size !== value.length)
        throw new ValidationError([{ category: "structure", code: "component_duplicate", path: "/value",
          expected: { merge_groups: componentMergeGroups((draft as JsonObject).value as JsonObject[]) },
          message: "同一类型、同一名称的组件只保留一项并合并来源编号与证据；匿名规划、推理、答案合成各自按职责合并，不逐调用重复列出。" }]);
      const missing = field === "components" ? recorded.filter(actor => !anonymousActor(actor) && !selected.has(Number(actor.component_index))) : [];
      const missingAnonymous = field === "components" && recorded.some(anonymousActor) && !recorded.some(actor => anonymousActor(actor) && selected.has(Number(actor.component_index)));
      if (missing.length || missingAnonymous) throw new ValidationError([{ category: "structure", code: "component_coverage", path: "/value",
        message: "覆盖本轮全部具名 Agent、工具、已执行脚本与已读取 skill；存在匿名模型执行时须保留其可见职责分组，不要求逐调用列出。",
        expected: { unassigned_actors: missing.map(actor => ({ actor_index: actor.component_index, kind: actor.kind, name: actor.name })) } }]);
      return { value };
    },
  } satisfies AgentProfile];
}));
export const compactAgent: AgentDefinition = { id: "compact", profiles: { default: compactProfile, ...compactFieldProfiles } };
