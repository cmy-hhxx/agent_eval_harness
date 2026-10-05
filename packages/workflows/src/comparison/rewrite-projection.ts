import type { PlannedTask, RunState, SubmissionReceipt } from "@eval/contracts";
import type { RewriteResult } from "@eval/agents/rewrite";
import type { TaskData } from "./types.js";

export function sourceRewriteTasks(tasks: PlannedTask[], sourceTaskId: string): PlannedTask[] {
  return tasks.filter(task => task.stage === "rewrite" && (task.data as TaskData).rewriteOf!.taskId === sourceTaskId);
}

/** Acceptance time decides ownership; manifest order breaks an equal-time tie. */
export function acceptedRewrites<T extends Pick<SubmissionReceipt, "acceptedAt">>(
  tasks: PlannedTask[], receipts: Record<string, T | undefined>, sourceTaskId: string,
): { task: PlannedTask; receipt: T }[] {
  return sourceRewriteTasks(tasks, sourceTaskId)
    .flatMap(task => receipts[task.id] ? [{ task, receipt: receipts[task.id]! }] : [])
    .sort((a, b) => a.receipt.acceptedAt - b.receipt.acceptedAt);
}

/** Reconstruct the current text without mutating any historical receipt. */
export function acceptedRewriteProjection(state: RunState, sourceTaskId: string) {
  const accepted = acceptedRewrites(state.manifest.tasks, state.receipts, sourceTaskId);
  if (!accepted.length) return undefined;
  const rewrites = new Map<string, RewriteResult["rewrites"][number]>(), owners = new Map<string, string>();
  for (const { task, receipt } of accepted) for (const item of (receipt.evaluation as RewriteResult).rewrites) {
    rewrites.set(item.id, item);
    owners.set(item.id, task.id);
  }
  return { rewritten: { evaluator_version: accepted.at(-1)!.receipt.evaluatorVersion, rewrites: [...rewrites.values()] }, owners };
}
