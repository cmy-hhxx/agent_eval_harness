import { runEvaluation, type ModelRequestControl } from "@eval/host";
import { exists, runLayout } from "@eval/data";
import {
  answerReviewWorkflow, answerReviewRepository, answerReviewPilotTaskIds, planAnswerReview,
  reportAnswerReview, validateAnswerReview, type AnswerReviewConfig,
} from "@eval/workflows/answer-review";
import { createModelResolver, type HostConfig } from "./config.js";
import { createBalancedModels } from "./balanced-models.js";
import { services } from "./composition.js";

/** Saved runs select their own reader; reporting does not require current model credentials. */
export async function readAnswerReviewCommand(command: "report" | "status" | "validate", run: string) {
  const state = await answerReviewRepository.readRun(run);
  if (command === "validate") return validateAnswerReview(state);
  if (command === "report") return reportAnswerReview(run, state);
  return { run_id: state.manifest.runId, status: state.manifest.status, stages: state.manifest.states };
}

interface AnswerReviewOptions {
  command: string;
  runId?: string;
  engine: string;
  debug?: boolean;
  stage?: string;
  signal?: AbortSignal;
  workers?: string[];
  skipFailed?: boolean;
  discoverInputs?: boolean;
  resumeStages?: string[];
  pilotCases?: number;
  balanceChannels?: boolean;
  modelRequests?: ModelRequestControl;
  pauseSignal?: AbortSignal;
  resumeTaskIds?: string[];
}

export async function runAnswerReviewCommand(host: HostConfig, options: AnswerReviewOptions) {
  if (options.stage && !["score", "attribution"].includes(options.stage)) throw Error("独立评审只可选择score或attribution");
  if (!["pi", "prime"].includes(options.engine)) throw Error("engine必须为pi或prime");
  const config: AnswerReviewConfig = { ...host.evaluation, workflow: "answer-review", comparisons: [],
    clustering: { ...host.evaluation.clustering, enabled: false },
    ...(options.resumeTaskIds&&{reviewTaskIds:options.resumeTaskIds}),
    reviewStages: options.stage ? [options.stage as "score" | "attribution"] : ["score", "attribution"] };
  if (options.command === "preflight") {
    const plan = await planAnswerReview(config);
    console.log(JSON.stringify({ evaluator_version: host.evaluatorVersion, ...plan.summary }, null, 2));
    return (plan.summary.issues as unknown[]).length ? 2 : 0;
  }
  if (options.command !== "run" || !options.runId) throw Error("独立评审使用run --run-id，或preflight");
  const layout = runLayout(config.output, options.runId), saved = await exists(layout.stateFile);
  if (options.pilotCases !== undefined && (saved || options.discoverInputs))
    throw Error("--pilot-cases 只用于新 run；通过验收后用 --discover-inputs 释放其余任务");
  const plan = saved ? { tasks: [], inputs: {}, summary: {} } : await planAnswerReview(config);
  if (!saved && !plan.tasks.length) throw Error("没有可评回答，请先查看 preflight");
  const taskIds = !saved && options.pilotCases !== undefined ? answerReviewPilotTaskIds(plan, options.pilotCases) : undefined;
  const routing = options.balanceChannels ? createBalancedModels(host.models) : { modelForStage: createModelResolver(host.models) };
  for (const stage of [...config.reviewStages!, ...(config.reviewStages!.includes("attribution") ? ["instruction-review"] : []), ...(config.reviewStages!.includes("attribution") && config.rewrite.attribution ? ["rewrite"] : [])])
    routing.modelForStage(stage);
  const controller = new AbortController(), stop = () => controller.abort(Error("User interrupted"));
  if (options.signal) {
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
  } else {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  try {
    const result = await runEvaluation({ ...services, ...routing, taskSource: answerReviewWorkflow,
      repository: answerReviewRepository, report: reportAnswerReview, runId: options.runId,
      output: config.output, engine: options.engine as "pi" | "prime", evaluatorVersion: host.evaluatorVersion,
      config, plan, taskIds, policy: config.execution, concurrency: config.execution.concurrency,
      retries: config.execution.retries, retryDelaySeconds: config.execution.retryDelaySeconds,
      skipFailed: options.skipFailed, discoverInputs: options.discoverInputs, resumeStages: options.resumeStages,
      workerUrls: options.workers, failureGuard: config.execution.failureGuard, signal: controller.signal,
      modelRequests: options.modelRequests, pauseSignal: options.pauseSignal,
      debug: options.debug, onProgress: console.log });
    console.log(JSON.stringify(result, null, 2));
    return controller.signal.aborted ? 130 : result.paused_stages.length ||
      ["pending", "running", "failed", "blocked", "timed_out", "cancelled"].some(status => result.execution_task_statuses[status]) ? 2 : 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
  }
}
