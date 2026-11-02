import { exists, runLayout } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { createChannelRequests } from "@eval/host";
import { attributionWorkflow, attributionRepository } from "@eval/workflows/attribution";
import { comparisonWorkflow, comparisonRepository } from "@eval/workflows/comparison";
import { businessResultRepository } from "@eval/workflows/review";
import { createBalancedModels, type HostConfig } from "@eval/host-app/config";
import { services, logger } from "@eval/host-app/composition";
const businessAttributionRepository = businessResultRepository(attributionRepository);
const businessComparisonRepository = businessResultRepository(comparisonRepository);

export type Gate = ReturnType<typeof createChannelRequests>;
interface Execution {
  host: HostConfig; id: string; gate: Gate; pause: AbortSignal; channels: string[];
  progress(message: string): void;
}

export async function executeConsoleTask({ host, id, gate, pause, channels, progress }: Execution) {
  const workflow = host.workflow === "attribution" ? attributionWorkflow : comparisonWorkflow;
  const repository = host.workflow === "attribution" ? businessAttributionRepository : businessComparisonRepository;
  const routing = createBalancedModels(host.models, channels);
  for (const stage of Object.keys(host.models.bindings)) routing.modelRoutesForTask({ stage });
  const saved = await exists(runLayout(host.evaluation.output, id).stateFile);
  const plan = saved ? { tasks: [], inputs: {}, summary: {} } : await workflow.plan(host.evaluation);
  if (!saved && !plan.tasks.length && !plan.summary.sharded) throw new Error("输入中没有可评测记录");
  const result = await runEvaluation({ ...services, ...routing, report: undefined, taskSource: workflow, repository,
    runtime: { ...services.runtime, workerSlots: host.evaluation.execution.workerSlots ?? 4 },
    runId: id, output: host.evaluation.output, engine: "pi", evaluatorVersion: host.evaluatorVersion,
    config: host.evaluation, plan, policy: host.evaluation.execution,
    concurrency: gate.concurrency(), modelRequests: gate,
    retries: host.evaluation.execution.retries, retryDelaySeconds: host.evaluation.execution.retryDelaySeconds,
    failureGuard: host.evaluation.execution.failureGuard, skipFailed: true, pauseSignal: pause, onProgress: progress });
  if (result.input_issue_count) {
    const state = await repository.readRun(runLayout(host.evaluation.output, id).directory);
    for (const issue of state.manifest.preflight.issues as Record<string, unknown>[] ?? [])
      await logger.error(new Error(String(issue.reason ?? "输入记录异常")), { component: "console", event: "console_input_rejected",
        run_id: id, detail: JSON.stringify(issue) });
  }
  return result;
}
