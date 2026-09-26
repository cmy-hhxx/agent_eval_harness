import { services as appServices } from "@eval/host-app/composition";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { attributionAgent } from "@eval/agents/attribution";
import {
  comparisonWorkflow,
  comparisonRepository,
  reportRun,
  validateRun as validateStoredRun,
} from "@eval/workflows/comparison";
import type { PlannedTask, SubmissionReceipt, ToolAudit } from "@eval/contracts";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const agents = new AgentRegistry([comparisonAgent, attributionAgent]);
export const services = {
  snapshots: appServices.snapshots,
  agents,
  workflow: comparisonWorkflow,
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
) => agents.prepare(comparisonWorkflow.bind(task, inputs, dependencies));
export const validateEvaluation = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  result: unknown,
  audit: ToolAudit,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) => agents.validate(comparisonWorkflow.bind(task, inputs, dependencies), result, audit);
export const resolveSubmission = (
  task: PlannedTask,
  inputs: Record<string, unknown>,
  draft: unknown,
  audit: ToolAudit,
) => agents.resolve(comparisonWorkflow.bind(task, inputs, {}), draft, audit);
export const validateRun = (run: string) =>
  validateStoredRun(run, (binding, result, audit) => agents.validate(binding, result, audit));
