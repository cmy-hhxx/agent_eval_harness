import { services as appServices } from "@eval/host-app/composition";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { attributionAgent } from "@eval/agents/attribution";
import { rewriteAgent } from "@eval/agents/rewrite";
import { clusteringAgent } from "@eval/agents/clustering";
import { criteriaAgent } from "@eval/agents/criteria";
import { criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeJudge } from "./comparison.js";
import {
  comparisonWorkflow,
  comparisonRepository,
  reportRun,
  validateRun as validateStoredRun,
} from "@eval/workflows/comparison";
import type { PlannedTask, SubmissionReceipt, ToolAudit } from "@eval/contracts";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const agents = new AgentRegistry([criteriaAgent, comparisonAgent, attributionAgent, rewriteAgent, clusteringAgent]);
/** A fixed rubric for focused binding tests that do not schedule its preparation. */
function testDependencies(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>) {
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
) => agents.prepare(comparisonWorkflow.bind(task, inputs, testDependencies(task, inputs, dependencies)));
export const validateEvaluation = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  result: unknown,
  audit: ToolAudit,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) => agents.validate(comparisonWorkflow.bind(task, inputs, testDependencies(task, inputs, dependencies)), result, audit);
export const validateRun = (run: string) =>
  validateStoredRun(run, (binding, result, audit) => agents.validate(binding, result, audit));
