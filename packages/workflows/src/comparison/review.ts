import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { workflowText, standardConflictReviewInstructions } from "@eval/prompts";
import { ValidationError, type PlannedTask, type RunState, type WorkflowDefinition } from "@eval/contracts";
import { attributionProfile, type AttributionResult } from "@eval/agents/attribution";
import type { EvalConfig, TaskData } from "./types.js";
import { bindTask } from "./binding.js";
import { attributionRewritePlaceholder, planAttributionRewriteGroups } from "./attribution-rewrite-planning.js";
import { validateOriginalAttributionEvidence } from "./public-trace.js";
import type { RawInput } from "./types.js";

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

/** Recheck both sides against the same original evidence before any affected comparison. */
const advanceStandardConflict: NonNullable<WorkflowDefinition["advance"]> = (task, _receipt, state) => {
  const available = state.manifest.tasks.filter(item => item.stage === "comparison" &&
    !(item.data as TaskData).verificationAudit && !state.receipts[item.id] && state.manifest.states[item.id]?.status !== "running");
  const sources = new Map([[task.id, task]]), comparisons = new Map<string, PlannedTask>();
  // A source can feed several pairs. Replace their sources together so no touched pair keeps an unreviewed side.
  for (let changed = true; changed;) {
    changed = false;
    for (const comparison of available) {
      if (comparisons.has(comparison.id) || !Object.keys((comparison.data as TaskData).candidates)
        .some(label => sources.has(comparison.dependencies[label]))) continue;
      comparisons.set(comparison.id, comparison); changed = true;
      for (const label of Object.keys((comparison.data as TaskData).candidates)) {
        const source = state.manifest.tasks.find(item => item.id === comparison.dependencies[label])!;
        sources.set(source.id, source);
      }
    }
  }
  const tasks: PlannedTask[] = [], reviews = new Map<string, PlannedTask>();
  for (const source of sources.values()) {
    const data = source.data as TaskData;
    if (data.standardConflictReview) continue;
    const existing = state.manifest.tasks.find(item => (item.data as TaskData).standardConflictReview &&
      (item.data as TaskData).reviewOf?.taskId === source.id);
    if (existing) { reviews.set(source.id, existing); continue; }
    const peers = new Map([...comparisons.values()]
      .filter(comparison => Object.values(comparison.inputIds).includes(source.inputIds.answer))
      .flatMap(comparison => Object.values((comparison.data as TaskData).candidates)
        .filter(candidate => candidate.input_id !== source.inputIds.answer)
        .map(candidate => [candidate.input_id, candidate] as const)));
    const referenceCandidates = Object.fromEntries([...peers.values()].map((candidate, index) => [`peer_${index + 1}`, candidate]));
    const review: PlannedTask = { ...source, id: randomUUID(),
      inputIds: { answer: source.inputIds.answer, ...Object.fromEntries(Object.entries(referenceCandidates).map(([key, candidate]) => [key, candidate.input_id])) },
      data: { ...data, referenceCandidates, standardConflictReview: true, revision: 1,
        reviewOf: { taskId: source.id, round: (data.reviewOf?.round ?? 0) + 1,
          reasons: [standardConflictReviewInstructions] } } satisfies TaskData };
    reviews.set(source.id, review); tasks.push(review);
    const polish = state.manifest.tasks.find(item => item.stage === "rewrite" && item.dependencies.source === source.id);
    if (polish && (state.receipts[polish.id] || state.manifest.states[polish.id]?.status === "running"))
      tasks.push(reviewRewrite(polish, review.id));
  }
  const replace = state.manifest.tasks.flatMap(consumer => {
    if (consumer.stage === "instruction-review" || state.receipts[consumer.id] || state.manifest.states[consumer.id]?.status === "running" ||
      (consumer.data as TaskData).verificationAudit ||
      !Object.values(consumer.dependencies).some(id => reviews.has(id))) return [];
    const consumerData = consumer.data as TaskData;
    const rewrite = consumerData.rewriteOf && reviews.get(consumerData.rewriteOf.taskId);
    return [{ ...consumer,
      dependencies: Object.fromEntries(Object.entries(consumer.dependencies).map(([key, id]) => [key, reviews.get(id)?.id ?? id])),
      ...(rewrite ? { data: { ...consumerData,
        rewriteOf: { ...consumerData.rewriteOf!, taskId: rewrite.id, resultId: rewrite.id } } satisfies TaskData } : {}),
    }];
  });
  return { tasks, replace };
};

/** Accepted answers are reused when their original standard is exactly the new shared standard. */
const advanceCriteria: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) => {
  const data = task.data as TaskData, tasks: PlannedTask[] = [], replace = new Map<string, PlannedTask>();
  const reviews = new Map<string, PlannedTask>();
  for (const comparison of state.manifest.tasks.filter((item) => item.stage === "comparison" &&
    item.dependencies.criteria === task.id && !state.receipts[item.id])) {
    const compared = comparison.data as TaskData, deps = { ...comparison.dependencies };
    for (const [label, candidate] of Object.entries(compared.candidates)) {
      const sourceId = deps[label]!, source = state.receipts[sourceId];
      if (!source) continue;
      const original = state.manifest.tasks.find((item) => item.id === sourceId)!;
      const evaluation = source.evaluation as { task_analysis?: unknown; core_assessment?: unknown; criterion_assessments?: unknown };
      if (isDeepStrictEqual(evaluation.task_analysis, receipt.evaluation) && evaluation.core_assessment &&
        Array.isArray(evaluation.criterion_assessments) && isDeepStrictEqual((original.data as TaskData).reference, data.reference)) {
        const check: PlannedTask = { ...original, inputIds: { answer: candidate.input_id }, dependencies: { criteria: task.id },
          data: { ...(original.data as TaskData), candidates: { A: candidate }, reference: data.reference } satisfies TaskData };
        try {
          attributionProfile.validate!(bindTask(check, inputs, { criteria: receipt }, { tasks: state.manifest.tasks }).request, source.evaluation, source.audit);
          continue;
        } catch (error) { if (!(error instanceof ValidationError)) throw error; }
      }
      let review = reviews.get(sourceId);
      if (!review) {
        review = { id: randomUUID(), stage: "attribution", dependencies: { criteria: task.id }, inputIds: { answer: candidate.input_id },
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
    Object.fromEntries(Object.values(task.inputIds).filter(id => inputs[id]).map(id => [id, inputs[id] as RawInput])), receipt.audit);
  if (task.stage === "attribution" && state.manifest.tasks.some(item =>
    (item.data as TaskData).standardConflictReview && (item.data as TaskData).reviewOf?.taskId === task.id)) return { tasks: instructionReviewFollowup(task,state) };
  const advance = task.stage === "criteria" ? advanceCriteria(task, receipt, state, inputs)
    : task.stage === "attribution" && (state.manifest.config as EvalConfig).standardAnswerReview === true &&
      (receipt.evaluation as AttributionResult).standard_conflict && !(task.data as TaskData).standardConflictReview
      ? advanceStandardConflict(task, receipt, state, inputs) : { tasks: [] };
  const retargeted = (advance.replace ?? []).some(replacement => replacement.stage === "rewrite" &&
    state.manifest.tasks.some(previous => previous.id === replacement.id && (previous.data as TaskData).rewriteOf?.taskId === task.id) &&
    (replacement.data as TaskData).rewriteOf?.taskId !== task.id);
  const grouped = retargeted ? { tasks: [] } : planAttributionRewriteGroups(task, receipt, state);
  return { tasks: [...advance.tasks, ...grouped.tasks, ...instructionReviewFollowup(task, state)],
    ...((advance.replace?.length || grouped.replace?.length) ? { replace: [...advance.replace ?? [], ...grouped.replace ?? []] } : {}) };
};
import { instructionReviewFollowup } from "./instruction-review.js";
