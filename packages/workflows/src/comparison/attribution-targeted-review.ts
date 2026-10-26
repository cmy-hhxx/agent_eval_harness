import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PlannedTask } from "@eval/contracts";
import { runLock } from "@eval/data";
import type { AttributionJobConfig } from "./attribution-job.js";
import { readRunState, writeRunState } from "./run-data.js";
import { pendingTaskProgress } from "../review/task-progress.js";
import type { TaskData } from "./types.js";
import { planAttributionUnit } from "@eval/workflows/attribution";
import { attributionRewritePlaceholder } from "./attribution-rewrite-planning.js";

export interface AttributionTargetedReviewSelection {
  reviews: { taskId: string; reasons: string[] }[];
  apply?: boolean;
}

/** Reassess selected answers from their original evidence without changing accepted work. */
export async function prepareAttributionTargetedReviews(run: string, selection: AttributionTargetedReviewSelection) {
  if (!selection.reviews.length) throw new Error("归因复核至少选择一份已接受回答");
  for (const review of selection.reviews)
    if (!review.reasons.length || review.reasons.some(reason => !reason.trim())) throw new Error("归因复核原因不能为空");
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks;
    if (!(state.manifest.config as AttributionJobConfig).attributionJob) throw new Error("只能准备独立归因作业的定向复核");
    const latest = new Map<string, PlannedTask>();
    for (const task of tasks) if (task.stage === "attribution-session" && state.receipts[task.id] && state.manifest.states[task.id]?.status === "succeeded") {
      const inputId = (task.data as TaskData).candidate!.input_id, previous = latest.get(inputId);
      if (!previous || state.receipts[previous.id]!.acceptedAt <= state.receipts[task.id]!.acceptedAt) latest.set(inputId, task);
    }
    const chosen = new Set<string>();
    const plans = selection.reviews.map(({ taskId, reasons }) => {
      const requested = tasks.find(task => task.id === taskId);
      if (requested?.stage !== "attribution-session" || !state.receipts[taskId] || state.manifest.states[taskId]?.status !== "succeeded")
        throw new Error("只能复核已接受归因任务：" + taskId);
      const original = (requested.data as TaskData).candidate!, source = latest.get(original.input_id)!;
      const candidate = (source.data as TaskData).candidate!;
      if (candidate.version !== original.version || candidate.batch_id !== original.batch_id || candidate.case_id !== original.case_id ||
        source.inputIds.answer !== candidate.input_id) throw new Error("同一输入的归因身份不一致：" + taskId);
      if (chosen.has(candidate.input_id)) throw new Error("重复选择同一回答：" + candidate.input_id);
      chosen.add(candidate.input_id);
      const pending = tasks.filter(task => task.stage === "attribution-session" && !state.receipts[task.id] &&
        (task.data as TaskData).reviewOf?.taskId === source.id);
      if (pending.length > 1 || pending.some(task => !isDeepStrictEqual((task.data as TaskData).reviewOf!.reasons, reasons)))
        throw new Error("该回答已有其他未完成归因复核：" + source.id);
      return { requested: taskId, source, review: pending[0], reasons: [...reasons] };
    });
    const selected = plans.map(plan => {
      const data = plan.source.data as TaskData, candidate = data.candidate!;
      return { requested_task_id: plan.requested, source_task_id: plan.source.id, review_task_id: plan.review?.id ?? null,
        input_id: candidate.input_id, model: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id,
        round: data.reviewOf ? data.reviewOf.round + 1 : 1, reasons: plan.reasons,
        status: plan.review ? state.manifest.states[plan.review.id].status : "new" };
    });
    const protectedAccepted = Object.keys(state.receipts).length;
    if (selection.apply) {
      const scope = state.manifest.executionScope && new Set(state.manifest.executionScope);
      for (const [index, plan] of plans.entries()) {
        let review = plan.review;
        if (!plan.review) {
          const sourceData = plan.source.data as TaskData, candidate = sourceData.candidate!;
          const unit = planAttributionUnit(candidate, { data: { ...structuredClone(sourceData),
            candidates: { A: candidate }, revision: 1,
            reviewOf: { taskId: plan.source.id, round: selected[index]!.round, reasons: plan.reasons } },
            dependencies: { ...(plan.source.dependencies.criteria ? { criteria: plan.source.dependencies.criteria } : {}) },
            identity: randomUUID() });
          review = unit.session; tasks.push(...unit.tasks);
          for (const task of unit.tasks) state.manifest.states[task.id] = { ...pendingTaskProgress(), revision: 1 };
          const config = state.manifest.config as AttributionJobConfig;
          if (config.rewrite.attribution) {
            const polish = attributionRewritePlaceholder(review.id, {
              rewriteNames: { A: candidate.name },
              case: { batch_id: candidate.batch_id, case_id: candidate.case_id, question: candidate.question },
            });
            tasks.push(polish); state.manifest.states[polish.id] = { ...pendingTaskProgress(), revision: 1 };
          }
        }
        scope?.add(review.id);
        selected[index]!.review_task_id = review.id;
        selected[index]!.status = state.manifest.states[review.id].status;
      }
      if (scope) state.manifest.executionScope = [...scope];
      state.manifest.status = "interrupted";
      delete state.manifest.finishedAt;
      await writeRunState(run, state);
    }
    return { applied: !!selection.apply, count: selected.length, protected_accepted: protectedAccepted, selected };
  } finally { await release(); }
}
