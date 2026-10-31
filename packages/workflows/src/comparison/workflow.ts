import type { WorkflowDefinition } from "@eval/contracts";
import { buildPlan, type PlanOptions } from "./input.js";
import type { EvalConfig, TaskData } from "./types.js";
import { reconcileRun } from "./run-data.js";
import { bindTask } from "./binding.js";
import { advanceReview } from "./review.js";
import { attributionWorkflow } from "../attribution/index.js";
import { attributionDimension } from "../review/dimensions.js";
export { bindTask } from "./binding.js";

const isDeferred = (stage: string) => stage === "rewrite" || stage === "clustering" || !!attributionDimension(stage);

export const comparisonWorkflow: WorkflowDefinition = {
  id: "comparison",
  isComputedTask: task => attributionWorkflow.isComputedTask!(task),
  plan: (config, options) => buildPlan(config as EvalConfig, undefined, options as PlanOptions),
  reconcile: reconcileRun,
  bind: bindTask,
  advance: advanceReview,
  observesFailures: task => !(task.data as TaskData).verificationAudit,
  scheduling: {
    stagePriority: stage => {
      if (attributionDimension(stage)) return 5;
      return ({ comparison: 0, "attribution-session": 1, "attribution-trace": 2,
        "attribution-compact": 3, criteria: 4, rewrite: 6, clustering: 7 } as Record<string, number>)[stage] ?? 4;
    },
  },
  canStart: (task, manifest) => task.stage === "comparison"
    ? Object.values(task.dependencies).every(id => manifest.states[id]?.status === "succeeded")
    : task.stage === "rewrite" || !!attributionDimension(task.stage)
    ? !manifest.tasks.some(item => !isDeferred(item.stage) &&
      (!manifest.executionScope || manifest.executionScope.includes(item.id)) &&
      ["pending", "running"].includes(manifest.states[item.id].status))
    : task.stage !== "clustering" || manifest.tasks
    .filter(item => item.stage === "attribution-session" && (!(item.data as TaskData).reviewOf ||
      (item.data as TaskData).standardConflictReview))
    .every(item => !["pending", "running"].includes(manifest.states[item.id].status)),
  blockedReason: (task, dependencies) => {
    if (task.stage !== "rewrite") return undefined;
    return Object.values(dependencies).some((receipt) =>
      (receipt.evaluation as { status?: string }).status === "needs_review")
      ? "Comparison remains unresolved" : undefined;
  },
};
