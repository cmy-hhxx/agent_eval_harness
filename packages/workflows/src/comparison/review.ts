import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ValidationError, type PlannedTask, type RunState, type WorkflowDefinition } from "@eval/contracts";
import { attributionProfile } from "@eval/agents/attribution";
import type { ComparisonResult, TaskData } from "./types.js";
import { bindTask } from "./binding.js";

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
          attributionProfile.validate!(bindTask(check, inputs, { criteria: receipt }).request, source.evaluation, source.audit);
          continue;
        } catch (error) { if (!(error instanceof ValidationError)) throw error; }
      }
      let review = reviews.get(sourceId);
      if (!review) {
        review = { id: randomUUID(), stage: "attribution", dependencies: { criteria: task.id }, inputIds: { answer: candidate.input_id },
          data: { stage: "attribution", candidates: { A: candidate }, reference: data.reference, criteriaScope: data.criteriaScope,
            initialContextChars: compared.initialContextChars, revision: 1,
            reviewOf: { taskId: sourceId, round: 1, reasons: ["本次共同标准、标准答案或当前材料证据与原归因不一致，按本次材料独立核验。"] } } satisfies TaskData };
        reviews.set(sourceId, review); tasks.push(review);
        const polish = state.manifest.tasks.find((item) => item.stage === "rewrite" && item.dependencies.source === sourceId);
        if (polish) tasks.push({ ...polish, id: randomUUID(), dependencies: { source: review.id },
          data: { ...(polish.data as TaskData), rewriteOf: { stage: "attribution", taskId: review.id, resultId: review.id }, revision: 1 } satisfies TaskData });
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

/** One independent review; unresolved cases stay outside verdicts and the problem library. */
export const advanceReview: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state: RunState, inputs) => {
  if (task.stage === "criteria") return advanceCriteria(task, receipt, state, inputs);
  if (task.stage !== "comparison") return { tasks: [] };
  const data = task.data as TaskData, result = receipt.evaluation as ComparisonResult;
  if (result.status !== "needs_review") return { tasks: [] };
  const dependents = state.manifest.tasks.filter((item) =>
    item.stage === "clustering" && Object.values(item.dependencies).includes(task.id));
  const rewrites = state.manifest.tasks.filter((item) => item.stage === "rewrite" && item.dependencies.source === task.id);
  if ((data.reviewOf?.round ?? 0) >= 1) return { tasks: [], blocked: [...dependents, ...rewrites].map((item) => item.id) };
  const tasks: PlannedTask[] = [], dependencies = { ...task.dependencies };
  for (const label of new Set(result.review_requests.map((request) => request.candidate))) {
    const candidate = data.candidates[label]!;
    const reasons = result.review_requests.filter((request) => request.candidate === label).map((request) => request.reason);
    const originalId = task.dependencies[label]!;
    const review: PlannedTask = {
      id: randomUUID(), stage: "attribution", inputIds: { answer: candidate.input_id },
      dependencies: { criteria: task.dependencies.criteria! },
      data: { stage: "attribution", candidates: { A: candidate }, reference: data.reference,
        criteriaScope: data.criteriaScope, initialContextChars: data.initialContextChars,
        reviewOf: { taskId: originalId, round: 1, reasons }, revision: 1 } satisfies TaskData,
    };
    tasks.push(review);
    const polish = state.manifest.tasks.find((item) => item.stage === "rewrite" && item.dependencies.source === originalId);
    if (polish) {
      const polishData = polish.data as TaskData;
      tasks.push({ ...polish, id: randomUUID(), dependencies: { source: review.id },
        data: { ...polishData, rewriteOf: { stage: "attribution", taskId: review.id, resultId: review.id }, revision: 1 } satisfies TaskData });
    }
    dependencies[label] = review.id;
  }
  const followup: PlannedTask = { ...task, id: randomUUID(), dependencies,
    data: { ...data, comparisonId: "cmp_" + randomUUID(), supersededBy: undefined,
      reviewOf: { taskId: task.id, round: 1, reasons: result.review_requests.map((request) => request.reason) }, revision: 1 } satisfies TaskData };
  tasks.push(followup);
  const replace: PlannedTask[] = [{ ...task, data: { ...data, supersededBy: followup.id } }];
  for (const item of rewrites) {
    const source = item.data as TaskData;
    replace.push({ ...item, dependencies: { source: followup.id }, data: { ...source,
      rewriteOf: { stage: "comparison", taskId: followup.id, resultId: (followup.data as TaskData).comparisonId! } } });
  }
  for (const item of dependents) {
    const deps = { ...item.dependencies };
    for (const [label, candidate] of Object.entries(data.candidates))
      if (deps[candidate.input_id] === task.dependencies[label]) deps[candidate.input_id] = dependencies[label]!;
    for (const [key, id] of Object.entries(deps)) if (id === task.id) deps[key] = followup.id;
    replace.push({ ...item, dependencies: deps });
  }
  return { tasks, replace };
};
