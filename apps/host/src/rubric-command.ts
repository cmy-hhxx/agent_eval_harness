import { runEvaluation } from "@eval/host";
import { exists, runLayout } from "@eval/data";
import { planRubric, rubricRepository, rubricWorkflow } from "@eval/workflows/rubric";
import type { RubricHostConfig } from "./config.js";
import { evaluationRouting } from "./evaluation-routing.js";
import { services } from "./composition.js";

/** Rubric uses accepted attribution for generic items and QA-only material for category items. */
export async function runRubricWorkflowCommand(host: RubricHostConfig, options: {
  command: string; runId?: string; debug?: boolean; workers?: string[]; resumeStages?: string[]; balanceChannels?: boolean;
  limitCases?: number; signal?: AbortSignal;
}) {
  if (!["preflight", "run"].includes(options.command)) throw new Error("Rubric 只支持 preflight 或 run");
  const evaluation = {...host.evaluation, inputs: {...host.evaluation.inputs,
    ...(options.limitCases ? {limit: options.limitCases} : {})}};
  if (options.command === "preflight") {
    const plan = await planRubric(evaluation);
    console.log(JSON.stringify({evaluator_version: host.evaluatorVersion, ...plan.summary}, null, 2));
    return 0;
  }
  if (!options.runId) throw new Error("Rubric run 需要 --run-id");
  const layout = runLayout(evaluation.output, options.runId);
  const saved = await exists(layout.stateFile);
  const routing = evaluationRouting(host, options.balanceChannels);
  const controller = new AbortController(), stop = () => controller.abort(new Error("User interrupted"));
  if (options.signal) { options.signal.addEventListener("abort", stop, {once: true}); if (options.signal.aborted) stop(); }
  else { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  try {
    const {report: _report, ...baseServices} = services;
    const result = await runEvaluation({...baseServices, ...routing, taskSource: rubricWorkflow,
      runtime: {...baseServices.runtime, workerSlots: evaluation.execution.workerSlots ?? 4},
      repository: rubricRepository, runId: options.runId, output: evaluation.output, engine: "pi",
      evaluatorVersion: host.evaluatorVersion, config: evaluation,
      plan: saved ? {tasks: [], inputs: {}, summary: {}} : await planRubric(evaluation),
      policy: evaluation.execution, concurrency: evaluation.execution.concurrency,
      taskConcurrency: evaluation.execution.taskConcurrency, retries: evaluation.execution.retries,
      retryDelaySeconds: evaluation.execution.retryDelaySeconds, resumeStages: options.resumeStages,
      workerUrls: options.workers, failureGuard: evaluation.execution.failureGuard,
      signal: controller.signal, debug: options.debug, onProgress: console.log});
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.outcome === "partial" || result.input_issue_count || result.input_rejected ||
      result.resource_pause || result.paused_stages.length ||
      ["pending", "running", "failed", "blocked", "timed_out", "cancelled"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally { options.signal?.removeEventListener("abort", stop); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
