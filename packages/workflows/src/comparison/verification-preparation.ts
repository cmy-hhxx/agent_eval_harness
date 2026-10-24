import { randomUUID } from "node:crypto";
import type { PlannedTask } from "@eval/contracts";
import { runLock } from "@eval/data";
import { readRunState, writeRunState } from "./run-data.js";
import { pendingTaskProgress } from "../review/task-progress.js";
import type { ComparisonResult, TaskData } from "./types.js";

export interface ComparisonVerificationSelection {
  resultIds?: string[];
  apply?: boolean;
}

/** Prepare an independent optional audit; accepted comparisons and their dependants stay immutable. */
export async function prepareComparisonVerification(run: string, selection: ComparisonVerificationSelection = {}) {
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks;
    const sources = tasks.filter(task => {
      const data = task.data as TaskData;
      return task.stage === "comparison" && !data.verificationOf &&
        !data.verificationAudit;
    });
    const chosen = new Set(selection.resultIds);
    for (const id of chosen)
      if (!sources.some(task => (task.data as TaskData).comparisonId === id)) throw new Error("未知正式对比结果：" + id);
    const plans: { source: PlannedTask; verification?: PlannedTask }[] = [];
    for (const source of sources) {
      const data = source.data as TaskData;
      if (chosen.size && !chosen.has(data.comparisonId!)) continue;
      const receipt = state.receipts[source.id];
      if (!receipt || (receipt.evaluation as ComparisonResult).status !== "decided") {
        if (chosen.size) throw new Error("对比尚无正式裁决，不能准备可选复核：" + source.id);
        continue;
      }
      const checks = tasks.filter(task => (task.data as TaskData).verificationAudit &&
        (task.data as TaskData).verificationOf?.taskId === source.id);
      if (checks.some(task => state.receipts[task.id])) continue;
      if (checks.length > 1) throw new Error("重复的未完成对比复核任务：" + source.id);
      for (const id of Object.values(source.dependencies))
        if (!state.receipts[id]) throw new Error("正式对比缺少已接受依赖：" + id);
      plans.push({ source, verification: checks[0] });
    }
    const selected = plans.map(({ source, verification }) => ({
      source_task_id: source.id,
      result_id: (source.data as TaskData).comparisonId!,
      verification_task_id: verification?.id ?? null,
      status: verification ? state.manifest.states[verification.id]?.status ?? "pending" : "new",
    }));
    const protectedAccepted = Object.keys(state.receipts).length;
    if (selection.apply && plans.length) {
      const scope: string[] = [];
      for (const [index, plan] of plans.entries()) {
        const verification = plan.verification ?? {
          id: randomUUID(), stage: "comparison", inputIds: { ...plan.source.inputIds },
          dependencies: { ...plan.source.dependencies, draft: plan.source.id },
          data: { ...structuredClone(plan.source.data as TaskData),
            verificationOf: { taskId: plan.source.id }, verificationAudit: true,
          } satisfies TaskData,
        };
        if (!plan.verification) tasks.push(verification);
        state.manifest.states[verification.id] = pendingTaskProgress(state.manifest.states[verification.id]);
        scope.push(verification.id);
        selected[index]!.verification_task_id = verification.id;
      }
      state.manifest.executionScope = scope;
      state.manifest.status = "interrupted";
      delete state.manifest.finishedAt;
      await writeRunState(run, state);
    }
    return { applied: !!selection.apply, count: selected.length, protected_accepted: protectedAccepted, selected };
  } finally { await release(); }
}
