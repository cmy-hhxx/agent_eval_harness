import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { workflowText } from "@eval/prompts";
import { ValidationError, type PlannedTask, type RunState, type WorkflowDefinition } from "@eval/contracts";
import { attributionProfile } from "@eval/agents/attribution";
import type { EvalConfig, TaskData } from "./types.js";
import { bindTask } from "./binding.js";
import { attributionRewritePlaceholder, planAttributionRewriteGroups } from "./attribution-rewrite-planning.js";
import { validateOriginalAttributionEvidence } from "../review/public-trace.js";
import type { RawInput } from "../inputs/types.js";

/** Turning the opt-in off releases unfinished consumers back to their original accepted sources. */
export function configureStandardReview(state: RunState, enabled: boolean): void {
  for (const task of state.manifest.tasks) if (task.stage === "attribution" && !state.receipts[task.id])
    (task.data as TaskData).standardAnswerReview = enabled;
  if (enabled) return;
  const originals = new Map(state.manifest.tasks.flatMap(task => {
    const data = task.data as TaskData;
    return data.standardConflictReview && data.reviewOf && !state.receipts[task.id]
      ? [[task.id, data.reviewOf.taskId] as const] : [];
  }));
  const removed = new Set(originals.keys());
  for (const task of state.manifest.tasks) {
    if (state.receipts[task.id]) continue;
    if (task.stage === "rewrite" && originals.has(task.dependencies.source)) {
      removed.add(task.id); continue;
    }
    task.dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([key, id]) => [key, originals.get(id) ?? id]));
  }
  state.manifest.tasks = state.manifest.tasks.filter(task => !removed.has(task.id));
  for (const id of removed) delete state.manifest.states[id];
  if (state.manifest.pausedStages) state.manifest.pausedStages = state.manifest.pausedStages
    .map(pause => ({ ...pause, taskIds: pause.taskIds.filter(id => !removed.has(id)) })).filter(pause => pause.taskIds.length);
  if (state.manifest.executionScope) {
    const scope = new Set(state.manifest.executionScope.flatMap(id => removed.has(id) ? originals.has(id) ? [originals.get(id)!] : [] : [id]));
    state.manifest.executionScope = [...scope];
  }
}

function reviewRewrite(template: PlannedTask, sourceTaskId: string): PlannedTask {
  const data = template.data as TaskData;
  const task = attributionRewritePlaceholder(sourceTaskId, { case: data.case, rewriteNames: data.rewriteNames });
  (task.data as TaskData).revision = 1;
  return task;
}

/** Accepted answers are reused when their original standard is exactly the new shared standard. */
const advanceCriteria: NonNullable<WorkflowDefinition["advance"]> = (task, _receipt, state, inputs) => {
  const data = task.data as TaskData, tasks: PlannedTask[] = [], replace = new Map<string, PlannedTask>();
  const reviews = new Map<string, PlannedTask>();
  for (const comparison of state.manifest.tasks.filter((item) => item.stage === "comparison" &&
    item.dependencies.criteria === task.id && !state.receipts[item.id])) {
    const compared = comparison.data as TaskData, deps = { ...comparison.dependencies };
    for (const [label, candidate] of Object.entries(compared.candidates)) {
      const sourceId = deps[label]!, source = state.receipts[sourceId];
      if (!source) continue;
      const original = state.manifest.tasks.find((item) => item.id === sourceId)!;
      if (!original.dependencies.criteria && isDeepStrictEqual((original.data as TaskData).reference, data.reference)) {
        const check: PlannedTask = { ...original, inputIds: { answer: candidate.input_id }, dependencies: {},
          data: { ...(original.data as TaskData), candidates: { A: candidate }, reference: data.reference } satisfies TaskData };
        try {
          attributionProfile.validate!(bindTask(check, inputs, {}, { tasks: state.manifest.tasks }).request, source.evaluation, source.audit);
          continue;
        } catch (error) { if (!(error instanceof ValidationError)) throw error; }
      }
      let review = reviews.get(sourceId);
      if (!review) {
        review = { id: randomUUID(), stage: "attribution", dependencies: {}, inputIds: { answer: candidate.input_id },
          data: { stage: "attribution", candidates: { A: candidate }, reference: data.reference, criteriaScope: data.criteriaScope,
            initialContextChars: compared.initialContextChars, revision: 1,
            standardAnswerReview: (state.manifest.config as EvalConfig).standardAnswerReview === true,
            ...((original.data as TaskData).reviewQuestions ? { reviewQuestions: [...(original.data as TaskData).reviewQuestions!] } : {}),
            reviewOf: { taskId: sourceId, round: 1, reasons: [workflowText("criteria-review")] } } satisfies TaskData };
        reviews.set(sourceId, review); tasks.push(review);
        const polish = state.manifest.tasks.find((item) => item.stage === "rewrite" && item.dependencies.source === sourceId);
        if (polish) tasks.push(reviewRewrite(polish, review.id));
      }
      deps[label] = review.id;
      for (const cluster of state.manifest.tasks.filter((item) => item.stage === "clustering" && !state.receipts[item.id])) {
        const current = replace.get(cluster.id) ?? cluster;
        if (current.dependencies[candidate.input_id] === sourceId)
          replace.set(cluster.id, { ...current, dependencies: { ...current.dependencies, [candidate.input_id]: review.id } });
      }
    }
    if (!isDeepStrictEqual(deps, comparison.dependencies)) replace.set(comparison.id, { ...comparison, dependencies: deps });
  }
  return { tasks, replace: [...replace.values()] };
};

/** Accepted formal comparisons and retrospective verification never reopen source results. */
export const advanceReview: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) => {
  if (task.stage === "attribution") validateOriginalAttributionEvidence(receipt.evaluation,
    Object.fromEntries(Object.values(task.inputIds).filter(id => inputs[id]).map(id => [id, inputs[id] as RawInput])), receipt.audit, receipt.submitted);
  if (task.stage === "attribution" && state.manifest.tasks.some(item =>
    (item.data as TaskData).standardConflictReview && (item.data as TaskData).reviewOf?.taskId === task.id)) return { tasks: instructionReviewFollowup(task,state) };
  const advance = task.stage === "criteria" ? advanceCriteria(task, receipt, state, inputs)
    : { tasks: [] };
  const retargeted = (advance.replace ?? []).some(replacement => replacement.stage === "rewrite" &&
    state.manifest.tasks.some(previous => previous.id === replacement.id && (previous.data as TaskData).rewriteOf?.taskId === task.id) &&
    (replacement.data as TaskData).rewriteOf?.taskId !== task.id);
  const grouped = retargeted ? { tasks: [] } : planAttributionRewriteGroups(task, receipt, state);
  return { tasks: [...advance.tasks, ...grouped.tasks, ...instructionReviewFollowup(task, state)],
    ...((advance.replace?.length || grouped.replace?.length) ? { replace: [...advance.replace ?? [], ...grouped.replace ?? []] } : {}) };
};
import { instructionReviewFollowup } from "./instruction-review.js";
