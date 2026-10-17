import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState, SubmissionReceipt, WorkflowDefinition } from "@eval/contracts";
import type { RewriteResult } from "@eval/agents/rewrite";
import { attributionRewriteGroups, attributionSlots } from "./commentary.js";
import { sourceRewriteTasks } from "./rewrite-projection.js";
import { pendingTaskProgress } from "./task-progress.js";
import type { AttributionResult, EvalConfig, TaskData } from "./types.js";

/** The result determines groups only after acceptance; this task reserves its first group. */
export function attributionRewritePlaceholder(
  sourceTaskId: string, context: Pick<TaskData, "case" | "rewriteNames">, previous?: PlannedTask,
): PlannedTask {
  return { id: previous?.id ?? randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: sourceTaskId },
    data: { ...(previous?.data as TaskData | undefined), stage: "rewrite", candidates: {}, reference: null,
      rewriteOf: { stage: "attribution", taskId: sourceTaskId, resultId: sourceTaskId }, ...context } satisfies TaskData };
}

/** Preserve accepted text and paid group tasks; expand a pending whole-result placeholder once. */
export function planAttributionRewriteGroups(
  source: PlannedTask, receipt: SubmissionReceipt, state: RunState, rewrites = sourceRewriteTasks(state.manifest.tasks, source.id),
): ReturnType<NonNullable<WorkflowDefinition["advance"]>> {
  if (source.stage !== "attribution" || !(state.manifest.config as EvalConfig).rewrite.attribution) return { tasks: [] };
  const result = receipt.evaluation as AttributionResult;
  const filled = new Set(rewrites.filter(task => state.receipts[task.id]).flatMap(task =>
    (state.receipts[task.id]!.evaluation as RewriteResult).rewrites.map(item => item.id)));
  const claimed = new Set(rewrites.filter(task => !state.receipts[task.id]).flatMap(task => (task.data as TaskData).rewriteSlotIds ?? []));
  const needed = attributionSlots(result).filter(item => !filled.has(item.id) && !claimed.has(item.id)).map(item => item.id);
  const groups = attributionRewriteGroups(result, needed);
  if (!groups.length) return { tasks: [] };
  const placeholder = rewrites.find(task => !state.receipts[task.id] && !(task.data as TaskData).rewriteSlotIds &&
    state.manifest.states[task.id]?.attempts === 0 && !state.manifest.states[task.id]?.failure && state.manifest.states[task.id]?.status !== "running");
  const original = (placeholder ?? rewrites[0])?.data as TaskData | undefined, candidate = (source.data as TaskData).candidates.A!;
  const context = { case: original?.case ?? { batch_id: candidate.batch_id, case_id: candidate.case_id, question: candidate.question },
    rewriteNames: original?.rewriteNames ?? { A: candidate.name } };
  const tasks: PlannedTask[] = [], replace: PlannedTask[] = [];
  for (const [index, slots] of groups.entries()) {
    const reused = index === 0 ? placeholder : undefined;
    const next = attributionRewritePlaceholder(source.id, context, reused);
    (next.data as TaskData).rewriteSlotIds = slots;
    (next.data as TaskData).revision = reused ? (reused.data as TaskData).revision ?? 1 : 1;
    (reused ? replace : tasks).push(next);
  }
  return { tasks, ...(replace.length ? { replace } : {}) };
}

/** A newer request owns its selected slots; covered historical pending work remains in the ledger. */
export function latestAttributionRewriteTasks(tasks: PlannedTask[], sourceTaskId: string, slotIds: string[]): PlannedTask[] {
  const owners = new Map<string, PlannedTask>(), valid = new Set(slotIds);
  for (const task of sourceRewriteTasks(tasks, sourceTaskId))
    for (const id of (task.data as TaskData).rewriteSlotIds ?? slotIds) if (valid.has(id)) owners.set(id, task);
  return [...new Set(owners.values())];
}

/** Fully covered pending requests are history; their attempts and failures stay in the manifest. */
export function supersededAttributionRewriteIds(state: RunState): Set<string> {
  const bySource = new Map<string, PlannedTask[]>(), sources = new Map(state.manifest.tasks.map(task => [task.id, task]));
  for (const task of state.manifest.tasks) {
    const data = task.data as TaskData;
    if (task.stage === "rewrite" && data.rewriteOf?.stage === "attribution")
      bySource.set(data.rewriteOf.taskId, [...bySource.get(data.rewriteOf.taskId) ?? [], task]);
  }
  const superseded = new Set<string>();
  for (const [sourceId, rewrites] of bySource) {
    if (sources.get(sourceId)?.stage !== "attribution" || !state.receipts[sourceId]) continue;
    const slots = attributionSlots(state.receipts[sourceId]!.evaluation as AttributionResult).map(slot => slot.id);
    const owners = new Set(latestAttributionRewriteTasks(rewrites, sourceId, slots).map(task => task.id));
    for (const task of rewrites) if (!state.receipts[task.id] && !owners.has(task.id)) superseded.add(task.id);
  }
  return superseded;
}

/** Reconciliation expands only active source answers, including a frozen rewrite-only repair. */
export function reconcileAttributionRewriteGroups(state: RunState, preserveCompletedResults = false): void {
  const scope = state.manifest.executionScope && new Set(state.manifest.executionScope);
  const bySource = new Map<string, PlannedTask[]>(), proposals = new Set<string>();
  for (const task of state.manifest.tasks) {
    const data = task.data as TaskData;
    if (task.stage === "rewrite" && data.rewriteOf?.stage === "attribution")
      bySource.set(data.rewriteOf.taskId, [...bySource.get(data.rewriteOf.taskId) ?? [], task]);
    if (data.standardConflictReview) proposals.add(data.reviewOf!.taskId);
  }
  for (const source of [...state.manifest.tasks]) {
    if (source.stage !== "attribution" || !state.receipts[source.id]) continue;
    const rewrites = bySource.get(source.id) ?? [];
    if (preserveCompletedResults && rewrites.length && rewrites.every(task => state.receipts[task.id])) continue;
    if (scope && !scope.has(source.id) && !rewrites.some(task => scope.has(task.id))) continue;
    if (proposals.has(source.id)) continue;
    const planned = planAttributionRewriteGroups(source, state.receipts[source.id]!, state, rewrites);
    for (const replacement of planned.replace ?? []) {
      const index = state.manifest.tasks.findIndex(task => task.id === replacement.id);
      state.manifest.tasks[index] = replacement;
      state.manifest.states[replacement.id] = { ...pendingTaskProgress(state.manifest.states[replacement.id], true),
        revision: (replacement.data as TaskData).revision ?? 1 };
    }
    for (const task of planned.tasks) {
      state.manifest.tasks.push(task);
      state.manifest.states[task.id] = { status: "pending", attempts: 0, revision: 1 };
      if (scope) scope.add(task.id);
    }
  }
  const superseded = supersededAttributionRewriteIds(state);
  if (scope) state.manifest.executionScope = [...scope].filter(id => !superseded.has(id));
  else if ((state.manifest.config as EvalConfig & { attributionJob?: unknown }).attributionJob && superseded.size)
    state.manifest.executionScope = state.manifest.tasks.filter(task => !superseded.has(task.id)).map(task => task.id);
  state.manifest.preflight.rewrite_tasks = state.manifest.tasks.filter(task => task.stage === "rewrite").length;
}
