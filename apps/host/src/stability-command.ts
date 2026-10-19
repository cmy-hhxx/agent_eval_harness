import path from "node:path";
import { safeId, type Engine, type ModelConfig, type PlannedTask } from "@eval/contracts";
import { exists, readJson, runLayout } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { createStabilityWorkflow, prepareStability, reportStability, stabilityRepository,
  type StabilityCase, type StabilityConfig, type StabilityTaskData } from "@eval/workflows/comparison";
import { createModelResolver, type HostConfig } from "./config.js";
import { services } from "./composition.js";

export function createStabilityModelResolver(modelForStage: (stage: string) => ModelConfig,
  engine: Engine, execution: StabilityConfig["execution"]) {
  return (task: PlannedTask): ModelConfig => {
    const model = modelForStage(task.stage);
    (task.data as StabilityTaskData).stability.condition = { engine, execution: structuredClone(execution), model: {
      provider: model.provider, baseUrl: model.baseUrl, api: model.api, model: model.model, thinking: model.thinking,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
      ...(model.supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole: model.supportsDeveloperRole }),
      ...(model.supportsExplicitPromptCaching === undefined ? {} : { supportsExplicitPromptCaching: model.supportsExplicitPromptCaching }),
    } };
    return model;
  };
}

export async function runStabilityCommand(host: HostConfig, options: {
  cases?: string; sourceRun?: string; runId?: string; output?: string; apply?: boolean; engine: string;
  debug?: boolean; workers?: string[]; resumeStages?: string[]; maxAttempts?: number; stopStartingAt?: number; seed?: number;
}): Promise<number> {
  if (!["pi", "prime"].includes(options.engine)) throw new Error("--engine must be pi or prime");
  if (options.apply && !options.runId) throw new Error("validate-stability --execute requires --run-id");
  if (options.runId) safeId(options.runId);
  const output = { kind: "directory" as const, path: options.output ? path.resolve(options.output) :
    path.resolve(host.evaluation.output.path, "../validation") };
  const layout = options.runId ? runLayout(output, options.runId) : undefined;
  const sourceRun = options.sourceRun ? path.resolve(options.sourceRun) : undefined;
  if (sourceRun && sourceRun === layout?.directory) throw new Error("Experiment directory must differ from the source run");
  const saved = layout && await exists(layout.stateFile) ? await stabilityRepository.readRun(layout.directory) : undefined;
  if (saved && (options.cases || sourceRun || options.seed !== undefined || options.maxAttempts !== undefined || options.stopStartingAt !== undefined))
    throw new Error("Resume retains the saved sample, seed and limits; omit selection and limit options");
  const cases = options.cases ? await readJson<StabilityCase[]>(path.resolve(options.cases)) : undefined;
  const prepared = saved ? undefined : await prepareStability({ ...host.evaluation, output }, cases,
    { sourceRun, seed: options.seed, maxAttempts: options.maxAttempts, stopStartingAt: options.stopStartingAt });
  const config: StabilityConfig = saved ? { ...(saved.manifest.config as StabilityConfig), execution: host.evaluation.execution } : prepared!.config;
  if (!options.apply) {
    console.log(JSON.stringify(saved ? { run_id: saved.manifest.runId, ...saved.manifest.preflight,
      attempts: saved.manifest.cumulativeAttempts ?? Object.values(saved.manifest.states).reduce((sum, task) => sum + task.attempts, 0),
      execution_limits: saved.manifest.executionLimits } : prepared!.plan.summary, null, 2));
    return 0;
  }
  const modelForStage = createModelResolver(host.models);
  const stages = new Set((prepared?.plan.tasks ?? saved!.manifest.tasks).map(task => task.stage));
  for (const stage of stages) {
    const model = modelForStage(stage);
    if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}; configure the model key in config.ini`);
  }
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("User interrupted"));
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await runEvaluation({ ...services, taskSource: await createStabilityWorkflow(config), repository: stabilityRepository,
      report: reportStability, runId: options.runId!, output, engine: options.engine as Engine,
      evaluatorVersion: host.evaluatorVersion, config, plan: prepared?.plan ?? { tasks: [], inputs: {}, summary: {} },
      modelForStage, modelForTask: createStabilityModelResolver(modelForStage, options.engine as Engine, config.execution),
      policy: config.execution, concurrency: config.execution.concurrency, retries: config.execution.retries,
      retryDelaySeconds: config.execution.retryDelaySeconds, failureGuard: config.execution.failureGuard,
      maxAttempts: config.stability.maxAttempts, stopStartingAt: config.stability.stopStartingAt,
      resumeStages: options.resumeStages, workerUrls: options.workers, signal: controller.signal, debug: options.debug,
      onProgress: console.log });
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.paused_stages.length ||
      ["failed", "blocked", "timed_out", "cancelled", "pending", "running"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
