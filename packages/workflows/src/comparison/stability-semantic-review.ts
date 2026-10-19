import { Ajv2020 } from "ajv/dist/2020.js";
import type { PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import schema from "../../../../schemas/workflow/semantic-review.schema.json" with { type: "json" };

export interface SemanticReviewRecord {
  task_id: string;
  submission_id: string;
  reviewer: { kind: "agent" | "human"; name: string };
  result: "passed" | "failed";
  rationale: string;
}
export interface SemanticReviewSummary {
  status: "not_selected" | "required" | "incomplete" | "passed" | "failed";
  planned: number;
  accepted: number;
  reviewed: number;
  failed: number;
  /** Accepted rewrites that have no review; missing outputs are planned minus accepted. */
  unreviewed: number;
}
const validateDocument = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

export function semanticReviewRecords(document: unknown): SemanticReviewRecord[] {
  if (!validateDocument(document))
    throw new Error("Invalid semantic-review.json: " + JSON.stringify(validateDocument.errors));
  return structuredClone(document as SemanticReviewRecord[]);
}

/** A review applies to one exact accepted rewrite, never another attempt or an earlier submission. */
export function validateSemanticReviews(state: RunState, records: unknown): SemanticReviewRecord[] {
  const reviews = semanticReviewRecords(records);
  const tasks = new Map(state.manifest.tasks.map(task => [task.id, task])), seen = new Set<string>();
  for (const review of reviews) {
    if (seen.has(review.task_id)) throw new Error("Duplicate semantic review for task: " + review.task_id);
    seen.add(review.task_id);
    const task = tasks.get(review.task_id), receipt = state.receipts[review.task_id];
    if (!task || task.stage !== "rewrite" || !receipt || receipt.status !== "succeeded" || receipt.taskId !== task.id)
      throw new Error("Semantic review must target a current accepted rewrite task: " + review.task_id);
    if (receipt.submissionId !== review.submission_id)
      throw new Error("Semantic review references a stale submission: " + review.task_id);
  }
  return reviews;
}

export function semanticReviewSummary(tasks: readonly PlannedTask[], receipts: Readonly<Record<string, SubmissionReceipt>>,
  records: readonly SemanticReviewRecord[]): SemanticReviewSummary {
  const rewrites = tasks.filter(task => task.stage === "rewrite"), ids = new Set(rewrites.map(task => task.id));
  const reviewed = records.filter(record => ids.has(record.task_id));
  const planned = rewrites.length, accepted = rewrites.filter(task => receipts[task.id]?.status === "succeeded").length;
  const failed = reviewed.filter(record => record.result === "failed").length;
  const status = !planned ? "not_selected" : failed ? "failed" : accepted < planned ? "incomplete" :
    reviewed.length === planned ? "passed" : "required";
  return { status, planned, accepted, reviewed: reviewed.length, failed, unreviewed: accepted - reviewed.length };
}
