import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ValidationError, type PlannedTask, type WorkflowDefinition } from "@eval/contracts";
import { attributionProfile } from "@eval/agents/attribution";
import type { TaskData } from "./types.js";
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
          attributionProfile.validate!(bindTask(check, inputs, { criteria: receipt }, { tasks: state.manifest.tasks }).request, source.evaluation, source.audit);
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

/** Shared-standard changes may require a new attribution; comparative checks never reopen it automatically. */
export const advanceReview: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) =>
  task.stage === "criteria" ? advanceCriteria(task, receipt, state, inputs) : { tasks: [] };
