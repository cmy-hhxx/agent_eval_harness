import type { AgentRequest, PlannedTask, SubmissionReceipt, TaskAnalysis, ToolAudit } from "@eval/contracts";
import { unresolvedVerificationConcerns, validateVerificationConcerns,
  type ComparisonMaterialInspection, type ComparisonVerificationSubmission } from "@eval/agents/comparison";
import { displayEvidence, parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { getAnswerGeneration } from "./answer-generation.js";
import type { RawInput, TaskData } from "./types.js";

type Concern = ComparisonMaterialInspection["concerns"][number];

/** The bounded follow-up reads its parent's accepted proof instead of copying it into task data. */
export function previousReviewConcerns(task: PlannedTask, inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>, tasks: readonly PlannedTask[], analysis: TaskAnalysis): Concern[] {
  const previousId = task.dependencies.previous_review;
  if (!previousId) return [];
  const previous = tasks.find(item => item.id === previousId), receipt = dependencies.previous_review;
  if (!previous || previous.stage !== "comparison" || (previous.data as TaskData).verificationPending ||
    !receipt || receipt.taskId !== previousId || receipt.status !== "succeeded" ||
    previous.dependencies.criteria !== task.dependencies.criteria || previous.dependencies.previous_review ||
    ((previous.data as TaskData).reviewOf?.round ?? 0) >= 1 ||
    (receipt.evaluation as { status?: string }).status !== "needs_review")
    throw new Error("来源复查缺少本轮对应的首轮已接受核验收据：" + previousId);
  if (!receipt.audit.inspection) {
    if ((previous.data as TaskData).verificationOf) throw new Error("已接受独立核验缺少原始发现证明：" + previousId);
    return []; // A standalone Comparison can request a source review without an independent inspection.
  }
  if (!receipt.submitted) throw new Error("已接受独立核验缺少原匹配选择：" + previousId);
  const data = previous.data as TaskData;
  const sources = Object.fromEntries(Object.entries(previous.inputIds).map(([candidate, id]) => {
    if (!inputs[id]) throw new Error("来源复查的原始证明材料未登记：" + id);
    return [candidate, { id, value: inputs[id] }];
  }));
  const request = { sources, input: { task_analysis: analysis, candidates: Object.fromEntries(Object.entries(data.candidates)
    .map(([candidate, material]) => [candidate, { candidate_id: material.input_id, final_message_index: material.final_index,
      answer_generation: getAnswerGeneration(inputs[material.input_id] as RawInput, material.input_id, material.final_index) }])) } } as unknown as AgentRequest;
  const concerns = unresolvedVerificationConcerns(request, receipt.submitted as unknown as ComparisonVerificationSubmission, receipt.audit);
  validateVerificationConcerns(request, concerns, { ...receipt.audit, ...receipt.audit.inspection.proof });
  return concerns.flatMap(concern => {
    const inputId = previous.inputIds[concern.candidate];
    const candidate = Object.keys(task.inputIds).find(label => task.inputIds[label] === inputId);
    // Attribution receives only the concern owned by its answer; registered peers remain factual context.
    if (task.stage === "attribution" && candidate !== "answer") return [];
    if (!candidate) throw new Error("来源复查发现无法绑定原候选：" + inputId);
    return [{ ...structuredClone(concern), candidate }];
  });
}

/** Only this generated envelope receives display fields; raw source messages and reasons stay untouched. */
export function reviewConcernPresentation<T extends { answer_evidence: Concern["answer_evidence"]; source_evidence: Concern["source_evidence"] }>(
  concern: T, sources: AgentRequest["sources"], audit: Pick<ToolAudit, "viewedImages" | "traceReads">,
) {
  const references = (values: Concern["answer_evidence"]) => values.map(reference => {
    const coordinates = parseEvidenceCoordinates(reference.evidence_id);
    const source = coordinates && Object.entries(sources).find(([, source]) => source.id === coordinates.input_id);
    if (!coordinates || !source) throw new Error("来源复查证明不属于当前登记材料：" + reference.evidence_id);
    const resolved = resolveEvidence(source[1].value as RawInput, reference, source[0], audit, "/review_context/concerns", source[1].id);
    const shown = displayEvidence(resolved.quote.length <= 200 ? { ...resolved, observation: reference.observation } : {
      ...resolved, observation: reference.observation, quote: undefined, quote_preview: resolved.quote.slice(0, 200), has_more: true });
    return coordinates.kind === "image" ? { ...shown, view_request: { candidate: source[0], message_index: coordinates.message_index } }
      : { ...shown, read_request: { candidate: source[0], message_index: coordinates.message_index, path: coordinates.path,
        offset: coordinates.start, max_chars: Math.min(16000, coordinates.end - coordinates.start) }, end_offset: coordinates.end };
  });
  return { ...concern, answer_evidence: references(concern.answer_evidence), source_evidence: references(concern.source_evidence) };
}
