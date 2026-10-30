import { ValidationError, resolveEvidenceSelection, evidenceOrigin, type AgentDefinition, type AgentProfile, type JsonObject } from "@eval/contracts";
import { resolveEvidence, parseEvidenceCoordinates, displayEvidence } from "@eval/tools";
import { agentPrompt, compactFields, compactOutputGuidance } from "@eval/prompts";
import schema from "../../../../schemas/compact/result.schema.json" with { type: "json" };

export interface SessionCompact extends JsonObject {
  session_overview: JsonObject;
  meta: JsonObject;
  turns: (JsonObject & { turn_index: number })[];
  cross_turn?: JsonObject;
}
export const compactResultSchema = schema;
export { compactFields };
const prompt = agentPrompt("compact", [], { fileSubmission: false });
function validateTurns(value: SessionCompact, count: unknown) {
  if (value.turns.length !== count || value.turns.some((turn, index) => turn.turn_index !== index))
    throw new ValidationError([{ category: "decision", code: "compact_turns", path: "/turns",
      message: "摘要必须按输入顺序覆盖每个实际收到的 turn，turn_index 从0开始。" }]);
}
export const compactProfile: AgentProfile = {
  id: "default", requestSchema: { type: "object", required: ["turn_count", "meta"], additionalProperties: true },
  submissionSchema: schema, resultSchema: schema,
  ...prompt, toolNames: [], maxToolCalls: 0,
  resolve(request, draft) {
    const value = draft as SessionCompact;
    validateTurns(value, request.input.turn_count);
    return { ...value, meta: { ...value.meta, ...request.input.meta as JsonObject } };
  },
};
export const compactFieldProfiles: Record<string, AgentProfile> = Object.fromEntries(Object.entries(compactFields).map(([field, definition]) => {
  const valueSchema = definition.scope === "session" ? (schema.properties as Record<string, unknown>)[field]
    : (schema.properties.turns.items.properties as Record<string, unknown>)[field];
  const submissionSchema = { type: "object", required: ["value"], additionalProperties: false, properties: { value: valueSchema } };
  const type = (valueSchema as { type: string }).type;
  return [field, { ...prompt, id: field, requestSchema: { type: "object" },
    systemPrompt: prompt.systemPrompt + "\n\n" + compactOutputGuidance.field_task.replace("{field}", field)
      .replace("{type}", type).replace("{instruction}", definition.instruction),
    submissionSchema, resultSchema: submissionSchema, toolNames: [], maxToolCalls: 0, evidenceSelections: true, maxEvidenceQuoteChars: 400,
    renderPrompt(input, policy, recovery) {
      let example = structuredClone(definition.submission_example ?? compactOutputGuidance.examples[type]!);
      const turns = (input.turns ?? []) as JsonObject[];
      const excerpt = turns.flatMap(turn => [...turn.final_evidence as JsonObject[] ?? [], ...turn.process_excerpts as JsonObject[] ?? []])
        .find(entry => Number.isSafeInteger((entry.reference as JsonObject | undefined)?.evidence_index));
      const index = (excerpt?.reference as JsonObject | undefined)?.evidence_index;
      const fillExample = (value: unknown): unknown => Array.isArray(value) ? value.map(fillExample)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).flatMap(([key, child]) => key === "$evidence"
          ? index === undefined ? [] : [[key, [index]]] : [[key, fillExample(child)]])) : value;
      example = field === "key_data" && !excerpt ? { value: {} } : fillExample(example) as JsonObject;
      const repair = recovery?.draft !== undefined && recovery.errors.length
        ? { previous_submission: recovery.draft, errors: recovery.errors,
          instruction: compactOutputGuidance.repair_instruction } : undefined;
      return prompt.renderPrompt({ ...input, target_field: field, field_value_type: type,
        submission_example: example, ...(repair ? { field_repair: repair } : {}) }, policy, repair ? undefined : recovery);
    },
    resolve(request, draft, audit) {
      const facts = request.input.facts as JsonObject[] | undefined;
      const values = new Map((facts ?? []).map(fact => [((fact.source_evidence as JsonObject[])[0]!.reference as JsonObject).evidence_id, fact]));
      const origin = { agent: "compact", field, ...(request.input.trace_index === undefined ? {} : { turn_index: request.input.trace_index }) };
      const expand = (node: unknown, path: string): unknown => {
        if (Array.isArray(node)) return node.map((value, index) => expand(value, `${path}/${index}`));
        if (!node || typeof node !== "object") return node;
        const { $evidence, source_evidence, source_values, summary_origin: _summaryOrigin, ...rest } = node as JsonObject;
        const reserved = Object.keys(rest).find(key => key.startsWith("$"));
        if (Array.isArray(rest.evidence) && rest.evidence.length && rest.evidence.every(Number.isSafeInteger))
          throw new ValidationError([{ category: "structure", code: "compact_reference_field", path: `${path}/evidence`,
            message: "原文编号必须放入 $evidence 整数数组；将此处 evidence 改为 $evidence，其他字段保持原样。" }]);
        if (source_evidence !== undefined || source_values !== undefined || reserved) throw new ValidationError([{ category: "structure", code: "compact_source_evidence", path,
          message: "原文和精确数值由代码填写；只用 $evidence 数组选择当前材料的 reference.evidence_index。" }]);
        if ($evidence !== undefined && !Array.isArray($evidence)) throw new ValidationError([{ category: "structure", code: "compact_evidence_type", path: `${path}/$evidence`,
          actual: $evidence, expected: { type: "array", items: "integer" }, message: "$evidence 必须是整数数组，例如 [3,7]；单个编号也放在数组内。" }]);
        const evidence = (($evidence ?? []) as unknown[]).map((index, ordinal) => {
          const selectionPath = `${path}/$evidence/${ordinal}`;
          let reference;
          try { reference = resolveEvidenceSelection(audit.evidenceBank ?? [], { evidence_index: index }, selectionPath); }
          catch (error) {
            if (!(error instanceof ValidationError)) throw error;
            throw new ValidationError(error.issues!.map(issue => ({ ...issue, expected: { ...issue.expected as JsonObject,
              repair_action: "只选择当前材料中已给出的 reference.evidence_index；没有依据时删除对应描述。" } })));
          }
          const item = resolveEvidence(request.sources.answer!.value as { messages: unknown[] }, reference, "answer", audit, selectionPath, request.sources.answer!.id);
          const point = parseEvidenceCoordinates(item.evidence_id)!;
          if (point.kind === "image" || item.quote.length > 400) throw new ValidationError([{ category: "evidence", code: "compact_evidence_range", path: "/value/$evidence",
            message: "选择当前呈现的不超过400字的文本片段。" }]);
          const position = (request.input.source_positions as JsonObject[])[item.message_index];
          return { ...displayEvidence(item), origin: evidenceOrigin((request.sources.answer!.value as { messages: unknown[] }).messages[item.message_index], point.path),
            location: { ...position, source_message_index: item.message_index,
            path: point.path, start: point.start, end: point.end } };
        });
        const summary = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, expand(value, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)]));
        const selectedValues = evidence.flatMap(entry => { const fact = values.get((entry.reference as JsonObject).evidence_id); return fact ? [structuredClone(fact)] : []; });
        const excerpts = evidence.filter(entry => !values.has((entry.reference as JsonObject).evidence_id));
        return { ...summary, ...(selectedValues.length ? { source_values: selectedValues } : {}),
          ...(excerpts.length ? { source_evidence: excerpts } : {}), ...(evidence.length ? { summary_origin: origin } : {}) };
      };
      const value = expand((draft as JsonObject).value, "/value");
      if (field === "components") for (const [index, entry] of (value as JsonObject[]).entries()) {
        const evidence = entry.source_evidence as JsonObject[] ?? [];
        if (!evidence.some(item => typeof item.quote === "string" && item.quote.includes(String(entry.name))))
          throw new ValidationError([{ category: "structure", code: "component_source_name", path: `/value/${index}/name`,
            message: "name 必须使用所选 $evidence 原文中实际出现的脚本路径、文件名或技能名；补充含该名称的编号，无法定位则删除该项。" }]);
      }
      return { value };
    },
  } satisfies AgentProfile];
}));
export const compactAgent: AgentDefinition = { id: "compact", profiles: { default: compactProfile, ...compactFieldProfiles } };
