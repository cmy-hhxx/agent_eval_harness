import { randomUUID } from "node:crypto";
import type { AgentBinding, AgentDefinition, PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import { instructionReviewAgent } from "@eval/agents/instruction-review";
import type { Candidate, RawInput } from "../inputs/types.js";
import { bindInstructionReview } from "./instruction.js";

/** A dimension owns its evidence view and judgment; scheduling and persistence are shared. */
export interface AttributionDimension {
  label: string;
  agent: AgentDefinition;
  resultKey: string;
  bind(candidate: Candidate, raw: RawInput): AgentBinding;
}

export const attributionDimensions = {
  "instruction-review": { label: "指令遵循归因", agent: instructionReviewAgent,
    resultKey: "instruction_review", bind: bindInstructionReview },
} satisfies Record<string, AttributionDimension>;
export type DimensionAttributionStage = keyof typeof attributionDimensions;

export function attributionDimension(stage: string): AttributionDimension | undefined {
  return Object.hasOwn(attributionDimensions, stage) ? attributionDimensions[stage as DimensionAttributionStage] : undefined;
}

/** Independent follow-ups never depend on one another or receive primary judgments. */
export function dimensionAttributionFollowup(task: PlannedTask, state: RunState,
  dimensions: Readonly<Record<string, AttributionDimension>> = attributionDimensions): PlannedTask[] {
  if (task.stage !== "attribution-session") return [];
  const candidate = (task.data as { candidate: Candidate }).candidate;
  if (!candidate.input_id) throw new Error("维度归因缺少回答的原始输入身份。");
  return Object.keys(dimensions).filter(stage => !state.manifest.tasks.some(item =>
    item.stage === stage && item.dependencies.source === task.id)).map(stage => ({
      id: randomUUID(), stage, inputIds: { case: candidate.input_id }, dependencies: { source: task.id },
      data: { stage, candidates: { A: candidate }, reference: null },
    }));
}

export function dimensionAttributionRow(task: PlannedTask, receipt: SubmissionReceipt, candidate: Candidate) {
  const dimension = attributionDimension(task.stage);
  if (!dimension) throw new Error("未登记的归因维度：" + task.stage);
  return { evaluation_type: dimension.resultKey, evaluator_version: receipt.evaluatorVersion,
    task_id: task.id, submission_id: receipt.submissionId, source_attribution_task_id: task.dependencies.source,
    input_id: candidate.input_id, batch_id: candidate.batch_id, case_id: candidate.case_id, version: candidate.version,
    trace_id: candidate.trace_id, input_file: candidate.source, input_line: candidate.line, judge: receipt.judge,
    [dimension.resultKey]: receipt.evaluation, verification: receipt.audit.review };
}
