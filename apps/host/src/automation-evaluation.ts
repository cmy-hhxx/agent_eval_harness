import path from "node:path";
import { REMOTE_MODELS, type RemoteDay, type WorkflowDefinition } from "@eval/contracts";
import { hasLiveRunOwner, readJson } from "@eval/data";
import { runEvaluation } from "@eval/host";
import type { AutomationJob, AutomationState, EvaluationOutcome, EvaluationSummary } from "@eval/automations";
import { comparisonWorkflow, publishableComparisons, reconcileRun, type Checkpoint, type EvalConfig } from "@eval/workflows/comparison";
import { boundProfiles, createModelResolver, loadConfig } from "./config.js";
import { services, logger } from "./composition.js";
import { automationEvaluationConfig, type AutomationConfig } from "./automation-config.js";

export const automationWorkflow: WorkflowDefinition = {
  ...comparisonWorkflow,
  reconcile: async (run, state, current) => {
    const plan = await reconcileRun(run, state, current, { extendVersions: true });
    const active = new Set(plan.tasks.filter(isAutomationTask).map((task) => task.id));
    state.manifest.pausedStages = (state.manifest.pausedStages ?? []).map((pause) => ({
      ...pause, taskIds: pause.taskIds.filter((id) => active.has(id)),
    })).filter((pause) => pause.taskIds.length);
    return plan;
  },
};

export function isAutomationTask(task: { stage: string; data: unknown }): boolean {
  return task.stage !== "clustering" && (task.data as { rewriteOf?: { stage: string } }).rewriteOf?.stage !== "clustering";
}

function automationPauses(state: Checkpoint) {
  return (state.pausedStages ?? []).map((pause) => ({ ...pause,
    taskIds: pause.taskIds.filter((id) => state.tasks[id] && isAutomationTask(state.tasks[id])),
  })).filter((pause) => pause.taskIds.length);
}

export async function checkpoint(output: string, runId: string): Promise<Checkpoint | undefined> {
  try { return await readJson<Checkpoint>(path.join(output, runId, "state.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function summarize(checkpoints: Checkpoint[], requireItems = true): EvaluationSummary {
  const summary: EvaluationSummary = { stages: {}, skipped: 0, issues: 0, readyComparisons: 0 };
  for (const state of checkpoints) {
    summary.readyComparisons += publishableComparisons(state, requireItems).size;
    summary.skipped += (state.preflight.skipped as unknown[]).length;
    summary.issues += (state.preflight.issues as unknown[]).length;
    for (const task of Object.values(state.tasks)) {
      if (!isAutomationTask(task)) continue;
      const stage = summary.stages[task.stage] ??= { total: 0, completed: 0, failed: 0, pending: 0, running: 0, cancelled: 0, blocked: 0 };
      stage.total++;
      if (task.status === "succeeded" && task.receipt) stage.completed++;
      else if (task.status === "running") stage.running++;
      else if (task.status === "pending") stage.pending++;
      else if (task.status === "cancelled") stage.cancelled++;
      else if (task.status === "blocked") stage.blocked++;
      else stage.failed++;
    }
  }
  return summary;
}

const temporary = (category: string) => category === "transport" || category === "interruption";
export function automaticResumeStages(state: Checkpoint): string[] {
  return automationPauses(state).filter((pause) => temporary(pause.category)).map((pause) => pause.stage);
}

/** Authority comes from Host receipts and failure categories, never the dashboard's old error text. */
export function checkpointRecovery(states: Checkpoint[]): "interrupted" | "transient" | undefined {
  if (!states.length || states.some((state) => automationPauses(state).some((pause) => !temporary(pause.category)))) return;
  const tasks = states.flatMap((state) => Object.values(state.tasks).filter(isAutomationTask));
  const failures = tasks.filter((task) => task.status === "failed" || task.status === "timed_out");
  if (!failures.length && tasks.some((task) => ["cancelled", "running", "pending"].includes(task.status))) return "interrupted";
  if (failures.length && failures.every((task) => task.failure?.errors.length
    ? task.failure.errors.every((issue) => temporary(issue.category))
    : task.status === "timed_out")) return "transient";
  if (!failures.length && states.some((state) => automationPauses(state).length)) return "transient";
}

function incompleteReason(states: Checkpoint[], summary: EvaluationSummary): string {
  const pauses = states.flatMap(automationPauses);
  if (pauses.length) return pauses.map((pause) => `${pause.stage}: ${pause.category}/${pause.code} ${pause.path}`).join("; ");
  return Object.entries(summary.stages).filter(([, stage]) => stage.completed !== stage.total)
    .map(([name, stage]) => `${name}: ${stage.completed}/${stage.total}, failed=${stage.failed}, interrupted=${stage.cancelled}, blocked=${stage.blocked}`).join("; ");
}

export async function recoverEvaluation(config: AutomationConfig, output: string, job: AutomationJob) {
  job.runIds = [`${config.runPrefix}${job.date}`];
  const saved = await checkpoint(output, job.runIds[0]);
  if (!saved) return;
  job.summary = summarize([saved]);
  const selection = saved.config as EvalConfig;
  if (job.mongo?.synced && Object.values(saved.tasks).some((task) =>
    task.data.rewriteOf?.stage === "comparison" && task.data.comparisonRewriteScope !== "all"))
    delete job.mongo.synced;
  if (["completed", "waiting_inputs"].includes(job.evaluation) &&
      REMOTE_MODELS.some((id) => !selection.inputs.versions.some((version) => version.id === id))) return "interrupted";
  const complete = publishableComparisons(saved, true);
  if (job.summary.stages.comparison?.completed > complete.size &&
      Object.values(job.summary.stages).every((stage) => stage.completed === stage.total)) return "interrupted";
  if (Object.values(job.summary.stages).every((stage) => stage.completed === stage.total) && !automationPauses(saved).length) {
    job.evaluation = job.summary.skipped || job.summary.issues || !job.summary.stages.comparison?.total ? "waiting_inputs" : "completed";
    job.evaluationAttempts = 0; job.nextEvaluationAt = 0;
    delete job.evaluationError;
    return;
  }
  const recovery = checkpointRecovery([saved]);
  if (recovery === "transient" || automationPauses(saved).length) job.evaluationError = incompleteReason([saved], job.summary);
  return recovery;
}

export async function evaluationTargets(config: AutomationConfig, output: string, day: RemoteDay) {
  const primary = `${config.runPrefix}${day.date}`, saved = await checkpoint(output, primary);
  const previousConfig = saved?.config as EvalConfig | undefined;
  if (previousConfig && (previousConfig.inputs.limit || previousConfig.inputs.case_ids?.length ||
    previousConfig.inputs.batches?.some((batch) => batch !== day.date)))
    throw new Error(`${primary} has a restricted input selection; choose an unrestricted daily run`);
  const runIds = [primary];
  const adopted = config.completedDates.includes(day.date);
  if (adopted) {
    if (!saved || saved.status !== "finished" ||
        Object.values(saved.tasks).some((task) => task.status !== "succeeded" || !task.receipt))
      throw new Error(`Historical run is not complete: ${primary}`);
    const counts = Object.fromEntries(REMOTE_MODELS.map((model) =>
      [model, Object.values(saved.inputs).filter((input) => input.version === model).length]));
    // Do not hide newly arrived rows behind a historical completion marker.
    const matched = REMOTE_MODELS.every((model) => counts[model] === day.rows[model]);
    return { runIds, adopted: matched, summary: summarize([saved], !matched) };
  }
  return { runIds, adopted: false };
}

export async function evaluateDay(config: AutomationConfig, job: AutomationJob, signal: AbortSignal): Promise<EvaluationOutcome> {
  const resumePaused = job.resumePaused;
  delete job.resumePaused;
  const host = await loadConfig(config.hostConfigs), output = host.evaluation.output.path;
  const modelForStage = createModelResolver(host.models);
  for (const stage of ["attribution", "comparison", "rewrite"]) modelForStage(stage);
  for (const profile of boundProfiles(host.models)) {
    if (!process.env[profile.apiKeyEnv]) throw new Error(`Missing ${profile.apiKeyEnv}`);
    logger.addSecrets(process.env[profile.apiKeyEnv]!);
  }
  let empty = false, skipped = 0, issues = 0;
  const checkpoints: Checkpoint[] = [];
  for (const runId of job.runIds) {
    signal.throwIfAborted();
    const previous = await checkpoint(output, runId);
    const evaluation = automationEvaluationConfig(host.evaluation, config.sourceDirectory, job.date);
    if (await hasLiveRunOwner(path.join(output, runId))) throw new Error(`${runId} is owned by another live Host`);
    const plan = previous ? { tasks: [], inputs: {}, summary: {} } : await comparisonWorkflow.plan(evaluation);
    if (!previous && !plan.tasks.length && !plan.summary.valid_inputs) {
      empty = true;
      skipped += (plan.summary.skipped as unknown[]).length;
      issues += (plan.summary.issues as unknown[]).length;
      continue;
    }
    await runEvaluation({
      ...services, runId, output: evaluation.output, engine: config.engine, evaluatorVersion: host.evaluatorVersion,
      taskSource: automationWorkflow,
      config: evaluation, plan, policy: evaluation.execution, modelForStage,
      concurrency: evaluation.execution.concurrency, retries: evaluation.execution.retries,
      retryDelaySeconds: evaluation.execution.retryDelaySeconds, failureGuard: evaluation.execution.failureGuard,
      discoverInputs: true, signal,
      resumeStages: previous ? (resumePaused ? automationPauses(previous).map((pause) => pause.stage) : automaticResumeStages(previous)) : [],
    });
    signal.throwIfAborted();
    checkpoints.push((await checkpoint(output, runId))!);
  }
  const summary = summarize(checkpoints);
  summary.skipped += skipped; summary.issues += issues;
  const pauses = checkpoints.flatMap(automationPauses);
  if (pauses.length) {
    const transient = pauses.every((pause) => temporary(pause.category));
    return { status: transient ? "retry" : "blocked", summary, transient,
      error: incompleteReason(checkpoints, summary) };
  }
  if (Object.values(summary.stages).some((stage) => stage.completed !== stage.total))
    return { status: "retry", summary, transient: checkpointRecovery(checkpoints) !== undefined,
      error: incompleteReason(checkpoints, summary) };
  if (empty || !summary.stages.comparison?.total || summary.skipped || summary.issues)
    return { status: "waiting_inputs", summary };
  return { status: "completed", summary };
}

export function remoteProgress(state: AutomationState, engine: AutomationConfig["engine"], runs: Map<string, Checkpoint[]>) {
  const dates = Object.values(state.jobs).map((job) => {
    const pairs = Object.fromEntries(["fast", "expert"].map((pair) => [pair, {
      total_cases: 0, completed_cases: 0, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0,
    }]));
    const statuses = new Map<string, { pair: string; statuses: string[] }>();
    const add = (group: string[], batch: string, id: string, status: string) => {
      const pair = group.length === 2 && group.includes("a_fast") && group.includes("b_fast") ? "fast" :
        group.length === 2 && group.includes("a_expert") && group.includes("b_expert") ? "expert" : undefined;
      if (!pair) return;
      const key = JSON.stringify([pair, batch, id]), value = statuses.get(key) ?? { pair, statuses: [] };
      value.statuses.push(status); statuses.set(key, value);
    };
    for (const run of runs.get(job.date) ?? []) {
      for (const task of Object.values(run.tasks)) {
        if (task.stage !== "comparison") continue;
        const input = run.inputs[Object.values(task.inputIds)[0]];
        if (input) add(task.data.group!, input.batch_id, input.case_id, task.status);
      }
      for (const skipped of run.preflight.skipped as { versions: string[]; batch_id: string; case_id: string }[])
        add(skipped.versions, skipped.batch_id, skipped.case_id, "skipped");
    }
    for (const { pair, statuses: items } of statuses.values()) {
      const counts = pairs[pair]; counts.total_cases++;
      if (items.includes("running")) counts.running_cases++;
      else if (items.some((status) => ["failed", "timed_out"].includes(status))) counts.failed_cases++;
      else if (items.includes("succeeded")) counts.completed_cases++;
      else if (items.includes("skipped")) counts.skipped_cases++;
      else counts.queued_cases++;
    }
    return { date: job.date, pairs };
  });
  const active = Object.values(state.jobs).some((job) => job.download !== "ready" ||
    ["pending", "evaluating", "retry"].includes(job.evaluation));
  return {
    run_id: `automation-${state.id}`, engine, started_at: state.startedAt, updated_at: Date.now(), dates,
    status: active ? (state.status === "stopped" ? "interrupted" : "running") :
      Object.values(state.jobs).some((job) => job.evaluation === "blocked") ? "interrupted" : "finished",
  };
}
