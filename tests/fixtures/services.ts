import { compactAgent } from "@eval/agents/compact";
import { compactReceipt } from "./compact.js";
import { compactFieldResult } from "@eval/workflows/attribution";
import { attributionDimensions } from "@eval/workflows/review";
import { services as appServices } from "@eval/host-app/composition";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { attributionAgent } from "@eval/agents/attribution";
import { rewriteAgent } from "@eval/agents/rewrite";
import { clusteringAgent } from "@eval/agents/clustering";
import { criteriaAgent } from "@eval/agents/criteria";
import { criteriaResultForTask, criteriaTaskFor, emptyAudit, fakeEvaluatorVersion, fakeJudge } from "./comparison.js";
import {
  comparisonWorkflow,
  comparisonRepository,
  reportRun,
  validateRun as validateStoredRun,
} from "@eval/workflows/comparison";
import type { PlannedTask, SubmissionReceipt, ToolAudit } from "@eval/contracts";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const agents = new AgentRegistry([compactAgent,...Object.values(attributionDimensions).map(dimension => dimension.agent),
  criteriaAgent, comparisonAgent, attributionAgent, rewriteAgent, clusteringAgent]);
/** A fixed rubric for focused binding tests that do not schedule its preparation. */
function testDependencies(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>) {
  if (task.stage === "attribution-compact") {
    const count = ((task.data as { candidate?: { turns?: unknown[] } }).candidate?.turns?.length ?? 1), receipt = compactReceipt(count);
    dependencies = { ...Object.fromEntries(Object.entries(task.dependencies).map(([label,id]) => {
      const [index, field] = label.includes(":") ? label.split(":") : [undefined, label];
      return [label, { ...receipt, taskId: id, evaluation: compactFieldResult(receipt.evaluation as Record<string, unknown>, field!, index === undefined ? undefined : Number(index)) }];
    })), ...dependencies };
  }
  if (task.dependencies.compact && !dependencies.compact) dependencies = { ...dependencies, compact: compactReceipt() };
  if (!task.dependencies.criteria || dependencies.criteria?.evaluation && "requirements" in (dependencies.criteria.evaluation as object)) return dependencies;
  return { ...dependencies, criteria: { taskId: task.dependencies.criteria, attemptId: "criteria", submissionId: "criteria",
    status: "succeeded", acceptedAt: 1, evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge,
    evaluation: criteriaResultForTask(task, inputs), audit: emptyAudit() } as SubmissionReceipt };
}
export const services = {
  snapshots: appServices.snapshots,
  agents,
  taskSource: comparisonWorkflow,
  repository: comparisonRepository,
  report: reportRun,
  runtime: {
    root: ROOT,
    workerEntry: path.join(ROOT, "dist/apps/worker/src/cli.js"),
  },
};
export const prepare = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt>,
  tasks?: PlannedTask[],
) => agents.prepare(comparisonWorkflow.bind(task, inputs, testDependencies(task, inputs, dependencies), {
  tasks: tasks ?? (task.dependencies.criteria ? [criteriaTaskFor(task), task] : [task]),
}));
export const validateEvaluation = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  result: unknown,
  audit: ToolAudit,
  dependencies: Record<string, SubmissionReceipt | undefined>,
  tasks?: PlannedTask[],
) => agents.validate(comparisonWorkflow.bind(task, inputs, testDependencies(task, inputs, dependencies), {
  tasks: tasks ?? (task.dependencies.criteria ? [criteriaTaskFor(task), task] : [task]),
}), result, audit);
export const validateRun = (run: string) =>
  validateStoredRun(run, (binding, result, audit) => agents.validate(binding, result, audit));
