import { exists, runLayout } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { createChannelRequests } from "@eval/host";
import { attributionRepository } from "@eval/workflows/attribution";
import { comparisonRepository, comparisonWorkflow, type EvalConfig } from "@eval/workflows/comparison";
import { createRoundWorkflow, loadInputSchedule } from "./rounds.js";
import { businessResultRepository } from "@eval/workflows/review";
import { createBalancedModels, type HostConfig } from "@eval/host-app/config";
import { services, logger } from "@eval/host-app/composition";
const businessAttributionRepository = businessResultRepository(attributionRepository);
const businessComparisonRepository = businessResultRepository(comparisonRepository);

export type Gate = ReturnType<typeof createChannelRequests>;
interface Execution {
  host: HostConfig; id: string; gate: Gate; pause: AbortSignal; channels: string[];
  inputSchedule: string;
  progress(message: string): void;
}

async function logInputIssues(id: string, issues: Record<string, unknown>[]) {
  for (const issue of issues) await logger.error(new Error("输入异常：" + (issue.source ? issue.source + ":" + (issue.line ?? "") + " " : "") +
    String(issue.reason ?? "记录无效"), { cause: issue }), { component: "console", event: "console_input_rejected", run_id: id });
}

export async function executeConsoleTask({ host, id, gate, pause, channels, progress, inputSchedule }: Execution) {
  const config = host.evaluation as EvalConfig;
  const workflow = host.workflow === "comparison" && (config.clustering.enabled || config.prediction || config.inputs.records) ? comparisonWorkflow :
    createRoundWorkflow(host, await loadInputSchedule(host, inputSchedule, pause));
  const repository = host.workflow === "attribution" ? businessAttributionRepository : businessComparisonRepository;
  const routing = createBalancedModels(host.models, channels);
  for (const stage of Object.keys(host.models.bindings)) routing.modelRoutesForTask({ stage });
  const saved = await exists(runLayout(host.evaluation.output, id).stateFile);
  const pausedStages = saved ? (await repository.readRun(runLayout(host.evaluation.output, id).directory)).manifest.pausedStages : [];
  const plan = saved ? { tasks: [], inputs: {}, summary: {} } : await workflow.plan(host.evaluation);
  if (!saved && !plan.tasks.length && !plan.summary.sharded) {
    await logInputIssues(id, plan.summary.issues as Record<string, unknown>[] ?? []);
    throw new Error("输入中没有可评测记录，请查看输入异常日志");
  }
  const result = await runEvaluation({ ...services, ...routing, report: undefined, taskSource: workflow, repository,
    runtime: { ...services.runtime, workerSlots: host.evaluation.execution.workerSlots ?? 4 },
    runId: id, output: host.evaluation.output, engine: "pi", evaluatorVersion: host.evaluatorVersion,
    config: host.evaluation, plan, policy: host.evaluation.execution,
    concurrency: gate.concurrency(), modelRequests: gate,
    retries: host.evaluation.execution.retries, retryDelaySeconds: host.evaluation.execution.retryDelaySeconds,
    failureGuard: host.evaluation.execution.failureGuard, resumeStages: pausedStages?.map(entry => entry.stage), pauseSignal: pause, onProgress: progress });
  if (result.input_issue_count) {
    const state = await repository.readRun(runLayout(host.evaluation.output, id).directory);
    await logInputIssues(id, state.manifest.preflight.issues as Record<string, unknown>[] ?? []);
  }
  return result;
}
