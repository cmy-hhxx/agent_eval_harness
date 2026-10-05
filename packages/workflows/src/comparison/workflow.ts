import type { WorkflowDefinition } from "@eval/contracts";
import { buildPlan, type PlanOptions } from "./input.js";
import type { EvalConfig, TaskData } from "./types.js";
import { reconcileRun } from "./run-data.js";
import { bindTask } from "./binding.js";
import { advanceReview } from "./review.js";
export { bindTask } from "./binding.js";

export const comparisonWorkflow: WorkflowDefinition = {
  id: "comparison",
  plan: (config, options) => buildPlan(config as EvalConfig, undefined, options as PlanOptions),
  reconcile: reconcileRun,
  bind: bindTask,
  advance: advanceReview,
  observesFailures: task => !(task.data as TaskData).verificationAudit,
  canStart: (task, manifest) => task.stage !== "clustering" || manifest.tasks
    .filter(item => item.stage === "attribution" && !(item.data as TaskData).reviewOf)
    .every(item => !["pending", "running"].includes(manifest.states[item.id].status)),
  blockedReason: (task, dependencies) => {
    if (task.stage !== "rewrite") return undefined;
    return Object.values(dependencies).some((receipt) =>
      (receipt.evaluation as { status?: string }).status === "needs_review")
      ? "Independent review is unresolved" : undefined;
  },
};
