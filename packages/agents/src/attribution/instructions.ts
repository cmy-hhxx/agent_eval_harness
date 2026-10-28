import { type AgentRequest, type TaskAnalysis, type TaskCriterion, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceSources, normativeSources, hasSourceTextBlock, parseEvidenceCoordinates, sourceContentBlocks, sourceTextBlocks } from "@eval/tools";
import type { Evidence } from "./types.js";
import { ownEvidence } from "./source-evidence.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const paragraphs = (text: string) => sourceTextBlocks(text).map(block => block.quote);

export function instructionEvidenceContext(request: AgentRequest) {
  const raw = request.sources.answer?.value as { messages: unknown[] };
  const answer = request.input.answer as { final_message_index: number };
  const candidate = request.input.candidate_id;
  const sources = normativeSources(raw, request.sources.answer.id, answer.final_message_index);
  const bindings = object((answer as unknown as Record<string, unknown>).criterion_instruction_sources);
  const bindingIssues: ValidationIssue[] = [];
  const boundEvidence = new Map<string, ReturnType<typeof cite>[]>();
  if (bindings) for (const [id, entries] of Object.entries(bindings)) {
    if (!Array.isArray(entries)) continue; // Request schema reports an unidentifiable binding.
    const evidence: ReturnType<typeof cite>[] = [];
    entries.forEach((entry, index) => {
      const value = object(entry);
      if (!value || typeof value.message_index !== "number" || typeof value.path !== "string" || typeof value.quote !== "string") return;
      const source = sources.find(source => source.message_index === value.message_index &&
        (value.path === source.path || String(value.path).startsWith(source.path + "/")));
      const original = source && evidenceSources(raw.messages[source.message_index])
        .find(item => item.kind === "text" && item.path === value.path &&
          source.evidence.some(evidence => { const point = parseEvidenceCoordinates(evidence.evidence_id);
            return point?.kind === "text" && point.path === item.path; }));
      if (!source || !original || !paragraphs(original.text).includes(value.quote)) {
        bindingIssues.push({ category: "evidence", code: "instruction_source_binding_invalid",
          path: `/answer/criterion_instruction_sources/${id.replaceAll("~", "~0").replaceAll("/", "~1")}/${index}`,
          message: "指令关联必须指向本回答实际收到的完整原始规范段落，保留标题对应正文、条件与例外，不能使用模型改写、另一候选、规划器或工具内部提示。",
          actual: entry });
        return;
      }
      const coordinates = typeof value.evidence_id === "string" ? parseEvidenceCoordinates(value.evidence_id) : undefined;
      if (!coordinates || coordinates.kind !== "text" || coordinates.input_id !== request.sources.answer.id ||
        coordinates.message_index !== value.message_index || coordinates.path !== value.path ||
        coordinates.end > original.text.length || original.text.slice(coordinates.start, coordinates.end) !== value.quote ||
        !sourceContentBlocks(source.content, source.path).some(block => block.origins.some(origin =>
          origin.path === coordinates.path && origin.start === coordinates.start && origin.end === coordinates.end && origin.quote === value.quote))) {
        bindingIssues.push({ category: "evidence", code: "instruction_source_binding_invalid",
          path: `/answer/criterion_instruction_sources/${id.replaceAll("~", "~0").replaceAll("/", "~1")}/${index}`,
          message: "规范关联必须引用完整原始段落的精确 evidence_id，不能按引文反查、截断条件或替换重复位置。", actual: entry });
        return;
      }
      evidence.push(cite(request.sources.answer.id, source.message_index, original, coordinates.start, coordinates.end));
    });
    boundEvidence.set(id, evidence);
  }
  const applicable = (criterion: TaskCriterion) => !criterion.applies_to.length || criterion.applies_to.includes(String(candidate));
  const forCriterion = (criterion: TaskCriterion | undefined) => {
    if (!criterion || !applicable(criterion)) return [];
    if (bindings) return boundEvidence.get(criterion.id) ?? [];
    const evidence: ReturnType<typeof cite>[] = [];
    for (const source of sources) for (const block of sourceContentBlocks(source.content, source.path)) {
      if (!hasSourceTextBlock(criterion.acceptance_rule, block.quote)) continue;
      for (const original of block.origins) {
        const location = evidenceSources(raw.messages[source.message_index]).find(value => value.kind === "text" &&
          value.path === original.path && source.evidence.some(item => { const point = parseEvidenceCoordinates(item.evidence_id);
            return point?.kind === "text" && point.path === value.path; }));
        if (location) evidence.push(cite(request.sources.answer.id, source.message_index, location, original.start, original.end));
      }
    }
    return evidence.filter((item, index) => evidence.findIndex(other => other.evidence_id === item.evidence_id) === index);
  };
  const forRequirement = (index: unknown) => {
    const task = request.input.task_analysis as unknown as TaskAnalysis;
    return Number.isSafeInteger(index) && Number(index) >= 0
      ? forCriterion(task.requirements[Number(index)]) : [];
  };
  const appendNorms = (evidence: Evidence[], norms: Evidence[]): Evidence[] => {
    const completed = [...evidence];
    for (const norm of norms)
      if (!completed.some(item => ownEvidence(item) && item.evidence_id === norm.evidence_id))
        completed.push({ evidence_id: norm.evidence_id, message_index: norm.message_index, quote: norm.quote });
    return completed;
  };
  return { raw, sources, forCriterion, forRequirement, appendNorms, bindingIssues, finalIndex: answer.final_message_index };
}
