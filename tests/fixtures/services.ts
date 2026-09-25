import { services as appServices } from "@eval/host-app/composition";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { critiqueAgent } from "@eval/agents/critique";
import {
  pairwiseWorkflow,
  pairwiseRepository,
  reportRun,
  validateRun as validateStoredRun,
} from "@eval/workflows/pairwise";
import type { PlannedTask, SubmissionReceipt, ToolAudit } from "@eval/contracts";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const agents = new AgentRegistry([comparisonAgent, critiqueAgent]);
export const services = {
  snapshots: appServices.snapshots,
  agents,
  workflow: pairwiseWorkflow,
  repository: pairwiseRepository,
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
) => agents.prepare(pairwiseWorkflow.bind(task, inputs, dependencies));
export const validateEvaluation = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  result: unknown,
  audit: ToolAudit,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) => agents.validate(pairwiseWorkflow.bind(task, inputs, dependencies), result, audit);
export const resolveSubmission = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  draft: unknown,
  audit: ToolAudit,
) => agents.resolve(pairwiseWorkflow.bind(task, inputs, {}), draft, audit);
export const validateRun = (run: string) =>
  validateStoredRun(run, (binding, result, audit) => agents.validate(binding, result, audit));
