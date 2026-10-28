import path from "node:path";
import { safeId } from "@eval/contracts";
import { exists, runLayout } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { attributionJobWorkflow, comparisonRepository, prepareAttributionJob, prepareAttributionPilotExpansion, reportRun, type AttributionJobConfig } from "@eval/workflows/comparison";
import { createModelResolver, testEvaluationOutput, type HostConfig } from "./config.js";
import { createBalancedModels } from "./balanced-models.js";
import { services } from "./composition.js";

export async function runAttributionCommand(host: HostConfig, options: {
  runs?: string[]; runId?: string; output?: string; fromDate?: string; pilotAnswers?: number; pilotPerModel?: number;
  apply?: boolean; debug?: boolean; workers?: string[]; resumeStages?: string[];
  discoverInputs?: boolean; balanceChannels?: boolean;
}): Promise<number> {
  if (host.workflow !== "comparison") throw new Error("重归因作业需要对战工作流配置");
  if (options.apply && !options.runId) throw new Error("reattribute --apply 需要 --run-id 保存独立进度");
  if (options.runId) safeId(options.runId);
  const pilot = options.pilotAnswers !== undefined || options.pilotPerModel !== undefined;
  const output = { ...host.evaluation.output, path: pilot
    ? testEvaluationOutput(host.evaluation.output, options.output ?? path.join(testEvaluationOutput(host.evaluation.output), "attribution"))
    : options.output ? path.resolve(options.output) : path.resolve(host.evaluation.output.path, "attribution") };
  const layout = options.runId ? runLayout(output, options.runId) : undefined;
  if (layout && options.runs?.some(run => path.resolve(run) === layout.directory))
    throw new Error("重归因作业目录不能覆盖来源 run");
  const saved = layout && await exists(layout.stateFile) ? await comparisonRepository.readRun(layout.directory) : undefined;
  const source = saved?.manifest.config as AttributionJobConfig | undefined;
  if (saved && !source?.attributionJob) throw new Error("该目录不是独立重归因作业");
  if (saved && (options.pilotAnswers !== undefined || options.fromDate || options.runs?.length))
    throw new Error("续跑沿用已保存的来源和试跑范围，不重复指定 --run、--from-date 或 --pilot-answers");
  if (options.pilotPerModel !== undefined && (!saved || options.discoverInputs || options.pilotAnswers !== undefined || options.fromDate || options.runs?.length))
    throw new Error("--pilot-per-model 仅扩大已有试跑，不能与 --discover-inputs、来源或初次抽样参数同用");
  if (options.discoverInputs && (!saved || options.pilotAnswers !== undefined))
    throw new Error("--discover-inputs 仅用于验收后释放已有作业的完整计划");
  const prepared = saved ? undefined : await prepareAttributionJob(options.runs ?? [], { ...host.evaluation, output },
    { fromBatch: options.fromDate, pilotAnswers: options.pilotAnswers });
  const config = saved ? { ...source!, execution: host.evaluation.execution } : prepared!.config;
  const expansion = options.pilotPerModel === undefined ? undefined : await prepareAttributionPilotExpansion(layout!.directory,
    { answersPerModel: options.pilotPerModel, apply: options.apply });
  if (!options.apply) {
    console.log(JSON.stringify(expansion ?? (saved ? { run_id: saved.manifest.runId, ...saved.manifest.preflight,
      execution_scope: saved.manifest.executionScope, states: saved.manifest.states } : prepared!.plan.summary), null, 2));
    return 0;
  }
  const routing = options.balanceChannels ? createBalancedModels(host.models) : { modelForStage: createModelResolver(host.models) };
  for (const stage of ["criteria", "attribution", "rewrite"]) {
    const model = routing.modelForStage(stage);
    if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}; configure the model key in config.ini`);
  }
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("User interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await runEvaluation({ ...services, ...routing, taskSource: attributionJobWorkflow,
      repository: comparisonRepository, report: reportRun, runId: options.runId!, output,
      engine: "pi", evaluatorVersion: host.evaluatorVersion, config,
      plan: prepared?.plan ?? { tasks: [], inputs: {}, summary: {} }, policy: config.execution,
      concurrency: config.execution.concurrency, retries: config.execution.retries,
      retryDelaySeconds: config.execution.retryDelaySeconds, failureGuard: config.execution.failureGuard,
      taskIds: prepared?.executionScope, discoverInputs: options.discoverInputs, resumeStages: options.resumeStages,
      workerUrls: options.workers, signal: controller.signal, debug: options.debug, onProgress: console.log,
    });
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.paused_stages.length ||
      ["failed", "blocked", "timed_out", "cancelled", "pending", "running"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
