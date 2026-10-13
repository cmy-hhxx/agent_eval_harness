import { ValidationError, type AgentRequest, type TaskAnalysis, type TaskCriterion, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceCovers, evidenceSources, hasSourceTextBlock, normativeSources, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource, sourceContentBlocks, sourceTextBlocks, type NormativeSource } from "@eval/tools";
import type { AttributionResult, Evidence } from "./types.js";
import { ownEvidence } from "./source-evidence.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const paragraphs = (text: string) => sourceTextBlocks(text).map(block => block.quote);
const independentFinalInstruction = (finding: unknown) => {
  const value = object(finding), assessment = object(value?.assessment);
  return value?.dimension === "instruction_following" && value.stage === "final_answer" &&
    assessment?.evidence_status === "established" && assessment.requirement_index === null;
};

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
          message: "程序指令关联必须指向本回答真实指令上下文中的完整原始规范块，保留标题对应正文、条件与例外，不能使用模型改写、另一候选、规划器或工具内部提示。",
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
          message: "规范关联必须保留程序原始完整段落的精确 evidence_id，不能按引文反查、截断条件或替换重复位置。", actual: entry });
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

/** Source provenance is checked against the raw norm, not text written into a model observation. */
function isNormEvidence(item: Evidence, sources: NormativeSource[], raw: { messages: unknown[] }, inputId: string) {
  return !!item.quote.trim() && sources.some(source => source.evidence.some(original =>
    evidenceCovers(raw, inputId, original.evidence_id, item.evidence_id)));
}

export function instructionEvidenceIssues(request: AgentRequest, result: AttributionResult): ValidationIssue[] {
  const context = instructionEvidenceContext(request);
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const criteria = new Map([...task.requirements, ...task.scoring_points, ...task.red_flags].map(criterion => [criterion.id, criterion]));
  const errors: ValidationIssue[] = [...context.bindingIssues];
  for (const field of ["findings", "criterion_assessments"] as const) result[field].forEach((item, index) => {
    item.context_evidence?.forEach((evidence, i) => {
      if (!ownEvidence(evidence) || !isNormEvidence(evidence, context.sources, context.raw, request.sources.answer.id))
        errors.push({ category: "evidence", code: "instruction_context_invalid", path: `/${field}/${index}/context_evidence/${i}`,
          message: "规范上下文只能保留本方真实指令来源，不能把最终回答、工具事实或 peer 放入上下文规避聚焦引用。" });
    });
  });
  const answerEvidence = (item: Evidence, finalOnly: boolean) => {
    if (item.message_index === context.finalIndex) return true;
    if (finalOnly || item.message_index >= context.finalIndex) return false;
    const message = object(context.raw.messages[item.message_index]);
    if (!message) return false;
    if (message.role === "tool" || message.role === "assistant" ||
        ["function_call", "function_call_output", "tool_call", "tool_result", "reasoning"].includes(String(message.type))) return true;
    // An LLM turn also holds input instructions; only its actual assistant output counts as execution.
    if (message.type !== "llm_turn") return false;
    const output = selectEvidenceSource(evidenceSources(message), "/output");
    return !!output && evidenceCovers(context.raw, request.sources.answer.id,
      cite(request.sources.answer.id, item.message_index, output.source, output.start, output.end).evidence_id, item.evidence_id);
  };
  const check = (evidence: Evidence[], normSources: NormativeSource[], path: string, finalOnly: boolean,
    relatedNorms: Evidence[], completeRelated = false) => {
    evidence = evidence.filter(ownEvidence);
    const hasNorm = completeRelated && relatedNorms.length
      ? relatedNorms.every(norm => evidence.some(item => isNormEvidence(item, normSources, context.raw, request.sources.answer.id) &&
          evidenceCovers(context.raw, request.sources.answer.id, item.evidence_id, norm.evidence_id)))
      : evidence.some(item => isNormEvidence(item, normSources, context.raw, request.sources.answer.id) && (!relatedNorms.length ||
          relatedNorms.some(norm => (evidenceCovers(context.raw, request.sources.answer.id, norm.evidence_id, item.evidence_id) ||
              evidenceCovers(context.raw, request.sources.answer.id, item.evidence_id, norm.evidence_id)))));
    if (!hasNorm) errors.push({
      category: "evidence", code: "instruction_evidence_required", path,
      message: "已确认的指令判断须有完整原规范及实际回答或执行证据。instruction_following 选择本方 norm_directory 中对应规范的 norm_index；未知规范用 null 且 uncertain。核对原条件是否触发以及实际行为，来源编号本身不证明遵守或违反。",
      expected: { normative_sources: (path.startsWith("/findings/") ? context.sources : normSources).map(source => ({ message_index: source.message_index, path: source.path, role: source.role,
        references: source.evidence.map(item => ({ evidence_id: item.evidence_id })) })) },
    });
    if (!evidence.some(item => answerEvidence(item, finalOnly))) errors.push({
      category: "evidence", code: "instruction_answer_evidence_required", path,
      message: finalOnly ? `最终回答的指令判断还须引用最终消息 ${context.finalIndex}，只有指令原文不足以证明实际交付。`
        : "指令评审还须引用最终回答或与结论相关的真实执行过程；只有指令、用户提问或上下文不足以证明已满足或违反。",
      expected: { final_message_index: context.finalIndex },
    });
  };
  result.criterion_assessments.forEach((assessment, index) => {
    if (assessment.status === "not_applicable" || assessment.evidence_status !== "established") return;
    const norms = context.forCriterion(criteria.get(assessment.criterion_id));
    if (!norms.length) return;
    const normSources = context.sources.filter(source => norms.some(norm => source.evidence.some(original => evidenceCovers(context.raw, request.sources.answer.id, original.evidence_id, norm.evidence_id))));
    check([...assessment.evidence, ...assessment.context_evidence ?? []], normSources, `/criterion_assessments/${index}/evidence`, false, norms);
  });
  result.findings.forEach((finding, index) => {
    if (finding.assessment.evidence_status !== "established") return;
    if (!context.sources.length && !independentFinalInstruction(finding)) return;
    const norms = context.forRequirement(finding.assessment.requirement_index);
    if (finding.dimension !== "instruction_following" && !norms.length) return;
    // Bound norms are required in full; independent explicit rules remain part of the evidence.
    check([...finding.evidence, ...finding.context_evidence ?? []], context.sources, `/findings/${index}/evidence`, finding.stage === "final_answer", norms, true);
  });
  return errors;
}

/** Include independent closure feedback alongside schema failures; unresolved refs retain their own feedback. */
export function instructionSubmissionIssues(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[] {
  const value = object(draft);
  if (!value) return [];
  const context = instructionEvidenceContext(request);
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const criteria = new Map([...task.requirements, ...task.scoring_points, ...task.red_flags].map(criterion => [criterion.id, criterion]));
  const resolve = (refs: unknown, criterion: TaskCriterion | undefined,
    norms = context.forCriterion(criterion)): Evidence[] | undefined => {
    if (!Array.isArray(refs)) return undefined;
    const evidence: Evidence[] = [];
    const ownRefs = refs.filter(item => { const ref = object(item); return typeof ref?.evidence_id === "string" &&
      parseEvidenceCoordinates(ref.evidence_id)?.input_id === request.sources.answer.id; });
    for (const item of ownRefs) {
      const ref = object(item);
      if (typeof ref?.evidence_id !== "string") return undefined;
      try { evidence.push(resolveEvidence(context.raw, ref as { evidence_id: string }, "answer", audit, "/evidence", request.sources.answer.id)); }
      catch (error) { if (error instanceof ValidationError) return undefined; throw error; }
    }
    return context.appendNorms(evidence, norms);
  };
  const checks: AttributionResult["criterion_assessments"] = [];
  const checkIndices: number[] = [];
  if (Array.isArray(value.criterion_assessments)) value.criterion_assessments.forEach((entry, index) => {
    const assessment = object(entry);
    if (!assessment || typeof assessment.criterion_id !== "string" || assessment.evidence_status !== "established" ||
        !["met", "partial", "unmet"].includes(String(assessment.status))) return;
    const criterion = criteria.get(assessment.criterion_id);
    if (!criterion) return;
    const evidence = resolve(assessment.evidence, criterion);
    if (evidence) {
      checks.push({ ...assessment, evidence } as unknown as AttributionResult["criterion_assessments"][number]);
      checkIndices.push(index);
    }
  });
  // Preserve the original array paths even when an unidentifiable entry was skipped.
  const result = instructionEvidenceIssues(request, { task_analysis: task, criterion_assessments: checks, findings: [] } as unknown as AttributionResult);
  return result.map(issue => {
    const match = /^\/(criterion_assessments|findings)\/(\d+)\/evidence$/u.exec(issue.path);
    if (!match) return issue;
    const group = match[1]!, index = Number(match[2]);
    return { ...issue, path: `/${group}/${checkIndices[index]}/evidence` };
  });
}
