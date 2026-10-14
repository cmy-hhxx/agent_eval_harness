import path from "node:path";
import { canonical, safeId, type Engine } from "@eval/contracts";
import { exists, runLayout } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { clusteringJobRepository, clusteringJobWorkflow, prepareClusteringJob, reportClusteringJob, type ClusteringJobConfig } from "@eval/workflows/comparison";
import { createModelResolver, type HostConfig } from "./config.js";
import { services } from "./composition.js";
import { createBalancedModels } from "./balanced-models.js";

export async function runClusteringCommand(host: HostConfig, options: {
  runs?: string[]; runId?: string; output?: string; apply?: boolean;
  engine: string; debug?: boolean; workers?: string[]; resumeStages?: string[]; balanceChannels?: boolean;
}): Promise<number> {
  if (!["pi", "prime"].includes(options.engine)) throw new Error("--engine must be pi or prime");
  if (options.apply && !options.runId) throw new Error("cluster --apply 需要 --run-id 保存独立进度");
  if (options.runId) safeId(options.runId);
  const output = { kind: "directory" as const,
    path: options.output ? path.resolve(options.output) : path.resolve(host.evaluation.output.path, "../clustering") };
  const layout = options.runId ? runLayout(output, options.runId) : undefined;
  const saved = layout && await exists(layout.stateFile) ? await clusteringJobRepository.readRun(layout.directory) : undefined;
  if (saved && options.runs && canonical([...new Set(options.runs.map(run => path.resolve(run)))].sort()) !==
    canonical((saved.manifest.config as ClusteringJobConfig).clusteringJob.runs))
    throw new Error("续跑沿用该作业已保存的来源选择；处理其他 run 请使用新的 --run-id");
  if (layout && options.runs?.some(run => path.resolve(run) === layout.directory))
    throw new Error("聚类作业目录不能覆盖来源 run");
  const prepared = saved ? undefined : await prepareClusteringJob(options.runs ?? [], { ...host.evaluation, output });
  const config: ClusteringJobConfig = saved
    ? { ...host.evaluation, output, inputs: { versions: [] }, comparisons: [],
      clusteringJob: (saved.manifest.config as ClusteringJobConfig).clusteringJob }
    : prepared!.config;
  if (!options.apply) {
    console.log(JSON.stringify(saved ? { run_id: saved.manifest.runId, ...saved.manifest.preflight,
      states: saved.manifest.states } : prepared!.plan.summary, null, 2));
    return 0;
  }
  const routing = options.balanceChannels ? createBalancedModels(host.models) : { modelForStage: createModelResolver(host.models) };
  const { modelForStage } = routing;
  for (const stage of new Set((saved?.manifest.tasks ?? prepared!.plan.tasks).map(task => task.stage))) {
    const model = modelForStage(stage);
    if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}; configure the model key in config.ini`);
  }
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("User interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await runEvaluation({ ...services, ...routing, taskSource: clusteringJobWorkflow, repository: clusteringJobRepository,
      report: reportClusteringJob, snapshots: {}, runId: options.runId!, output, engine: options.engine as Engine,
      evaluatorVersion: host.evaluatorVersion, config,
      plan: prepared?.plan ?? { tasks: [], inputs: {}, summary: {} },
      policy: config.execution, modelForStage, concurrency: config.execution.concurrency,
      retries: config.execution.retries, retryDelaySeconds: config.execution.retryDelaySeconds,
      failureGuard: config.execution.failureGuard, resumeStages: options.resumeStages,
      workerUrls: options.workers, signal: controller.signal, debug: options.debug, onProgress: console.log,
    });
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.paused_stages.length ||
      ["failed", "blocked", "timed_out", "cancelled", "pending", "running"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
