import type { AgentBinding, PlannedTask, ReviewCase, SubmissionReceipt } from "@eval/contracts";
import { instructionSources } from "@eval/tools";
import { attributionTrace } from "./public-trace.js";
import type { Candidate, RawInput } from "../inputs/types.js";

/** A new session gets rules and behavior, never the primary evaluator's findings or judgments. */
export function bindInstructionReview(candidate: Candidate, raw: RawInput): AgentBinding {
  const trace = attributionTrace(raw, candidate.input_id, candidate.final_index);
  const final = trace.messages[candidate.final_index];
  const evidence: Record<string, string> = { Q: candidate.question,
    A: typeof final.content === "string" ? final.content : JSON.stringify(final.content ?? final, null, 2) };
  const norm_catalog = instructionSources(raw, candidate.input_id, candidate.final_index).map((source, index) => {
    const source_id = `N${String(index + 1).padStart(3, "0")}`;
    const content = typeof source.content === "string" ? source.content : JSON.stringify(source.content, null, 2);
    evidence[source_id] = content;
    return { source_id, role: source.role, message_index: source.message_index, path: source.path,
      length: Array.from(content).length,
      headings: content.split("\n").filter(line => /^#{1,6}\s+\S/u.test(line)).map(line => line.slice(0, 120)).slice(0, 32) };
  });
  for (const [index, message] of trace.messages.entries()) {
    if (index === candidate.final_index || message.role === "user" || message.type === "user_question" || message.type === "private_instruction_omitted") continue;
    evidence[`C${String(index + 1).padStart(3, "0")}`] = JSON.stringify(message, null, 2);
  }
  const material: ReviewCase = { case_id: candidate.input_id, task_question: candidate.question, candidate_output_id: "A", evidence,
    availability: { candidate_output: "available", internal_instructions: norm_catalog.length ? "available" : "not_collected" },
    public_requirements: { question: candidate.question } };
  const input = { case_id: candidate.input_id, task_question: candidate.question, norm_catalog,
    candidate_response: Array.from(evidence.A).slice(0, 12000).join(""), answer_requires_more: Array.from(evidence.A).length > 12000,
    evidence_catalog: Object.entries(evidence).map(([source_id, text]) => ({ source_id, length: Array.from(text).length })),
    availability: material.availability };
  return { agent: "instruction-review", profile: "default", request: { input, sources: { case: { id: candidate.input_id, value: material } } } };
}

export function instructionReviewRow(task: PlannedTask, receipt: SubmissionReceipt, candidate: Candidate) {
  return { evaluation_type: "instruction_review", evaluator_version: receipt.evaluatorVersion,
    task_id: task.id, submission_id: receipt.submissionId, source_attribution_task_id: task.dependencies.source,
    input_id: candidate.input_id, batch_id: candidate.batch_id, case_id: candidate.case_id, version: candidate.version,
    trace_id: candidate.trace_id, input_file: candidate.source, input_line: candidate.line, judge: receipt.judge,
    instruction_review: receipt.evaluation, verification: receipt.audit.review };
}
