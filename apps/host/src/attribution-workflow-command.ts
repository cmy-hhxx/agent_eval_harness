import { runEvaluation } from "@eval/host";
import { exists, runLayout } from "@eval/data";
import { attributionRepository, attributionWorkflow, planAttribution, validateAttributionRun } from "@eval/workflows/attribution";
import type { AttributionHostConfig } from "./config.js";
import { evaluationRouting } from "./evaluation-routing.js";
import { services } from "./composition.js";

export async function readAttributionWorkflowCommand(command: "status" | "validate", run: string) {
  const state = await attributionRepository.readRun(run);
  if (command === "validate") return validateAttributionRun(state);
  return { run_id: state.manifest.runId, status: state.manifest.status, outcome: state.manifest.outcome, stages: state.manifest.states };
}

export async function runAttributionWorkflowCommand(host: AttributionHostConfig, options: {
  command: string; runId?: string; debug?: boolean; workers?: string[]; discoverInputs?: boolean;
  skipFailed?: boolean;
  resumeStages?: string[]; balanceChannels?: boolean; signal?: AbortSignal;
}) {
  if (!["preflight", "run"].includes(options.command)) throw new Error("Attribution 只支持 preflight 或 run");
  const plan = options.command === "preflight" ? await planAttribution(host.evaluation) : undefined;
  if (plan) {
    console.log(JSON.stringify({ evaluator_version: host.evaluatorVersion, ...plan.summary }, null, 2));
    return (plan.summary.issues as unknown[]).length ? 2 : 0;
  }
  if (!options.runId) throw new Error("Attribution run 需要 --run-id");
  const layout = runLayout(host.evaluation.output, options.runId), saved = await exists(layout.stateFile);
  const initial = saved ? { tasks: [], inputs: {}, summary: {} } : await planAttribution(host.evaluation);
  if (!saved && !initial.tasks.length) throw new Error("没有可评 session，请先查看 preflight");
  const routing = evaluationRouting(host, options.balanceChannels);
  const controller = new AbortController(), stop = () => controller.abort(new Error("User interrupted"));
  if (options.signal) { options.signal.addEventListener("abort", stop, { once: true }); if (options.signal.aborted) stop(); }
  else { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  try {
    const { report: _report, ...baseServices } = services;
    const result = await runEvaluation({ ...baseServices, ...routing, taskSource: attributionWorkflow,
      runtime: { ...baseServices.runtime, workerSlots: host.evaluation.execution.workerSlots ?? 4 },
      repository: attributionRepository, runId: options.runId, output: host.evaluation.output, engine: "pi",
      evaluatorVersion: host.evaluatorVersion, config: host.evaluation, plan: initial,
      policy: host.evaluation.execution, concurrency: host.evaluation.execution.concurrency,
      taskConcurrency: host.evaluation.execution.taskConcurrency, retries: host.evaluation.execution.retries,
      retryDelaySeconds: host.evaluation.execution.retryDelaySeconds, discoverInputs: options.discoverInputs,
      skipFailed: options.skipFailed,
      resumeStages: options.resumeStages, workerUrls: options.workers, failureGuard: host.evaluation.execution.failureGuard,
      signal: controller.signal, debug: options.debug, onProgress: console.log });
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.outcome === "partial" || result.input_issue_count || result.input_rejected || result.resource_pause || result.paused_stages.length ||
      ["pending", "running", "failed", "blocked", "timed_out", "cancelled"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
