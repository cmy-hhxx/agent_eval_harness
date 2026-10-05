import path from "node:path";
import { REMOTE_MODELS, type PlannedTask, type RemoteDay, type TaskPlan, type WorkflowDefinition } from "@eval/contracts";
import { hasLiveRunOwner, readJson } from "@eval/data";
import { runEvaluation } from "@eval/host";
import type { AutomationJob, AutomationState, EvaluationOutcome, EvaluationSummary } from "@eval/automations";
import { comparisonWorkflow, expandComparisonPairs, publishableComparisons, reconcileRun, taskIdentity, type BatchPreflight, type Checkpoint, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import { boundProfiles, createModelResolver, loadConfig } from "./config.js";
import { services, logger } from "./composition.js";
import { automationEvaluationConfig, type AutomationConfig } from "./automation-config.js";

/** A daily run reserves battles separately for each pair; accepted work always survives the cap. */
function automationSelection(
  tasks: Pick<PlannedTask, "id" | "stage" | "dependencies" | "data">[], accepted: ReadonlySet<string>, limit: number,
): Set<string> {
  const selected = new Set(accepted), counts = new Map<string, number>();
  const comparisons = tasks.filter((task) => task.stage === "comparison");
  const group = (task: typeof tasks[number]) => (task.data as TaskData).group!.slice().sort().join("+");
  for (const task of comparisons.filter((task) => accepted.has(task.id)))
    counts.set(group(task), (counts.get(group(task)) ?? 0) + 1);
  for (const task of comparisons) {
    if (accepted.has(task.id)) continue;
    const key = group(task), count = counts.get(key) ?? 0;
    if (count >= limit) continue;
    selected.add(task.id); counts.set(key, count + 1);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // Include attribution dependencies, including those of retained historical results.
  for (const id of selected)
    for (const dependency of Object.values(byId.get(id)?.dependencies ?? {})) selected.add(dependency);
  for (const task of tasks) {
    const source = (task.data as TaskData).rewriteOf;
    if (source && source.stage !== "clustering" && selected.has(source.taskId)) selected.add(task.id);
  }
  return selected;
}

function limitAutomationPlan(plan: TaskPlan, limit: number, accepted = new Set<string>(), previous: PlannedTask[] = []) {
  const current = new Map(plan.tasks.map((task) => [task.id, task]));
  const previousIds = new Set(previous.map((task) => task.id));
  // Keep reserved battles ahead of newly discovered cases, even when source order changes.
  const ordered = [...previous.flatMap((task) => current.has(task.id) ? [current.get(task.id)!] : []),
    ...plan.tasks.filter((task) => !previousIds.has(task.id))];
  const selected = automationSelection(ordered, accepted, limit);
  plan.tasks = plan.tasks.filter((task) => selected.has(task.id));
  for (const stage of ["attribution", "comparison", "rewrite", "clustering"])
    plan.summary[stage + "_tasks"] = plan.tasks.filter((task) => task.stage === stage).length;
  const groups: Record<string, number> = {};
  for (const task of plan.tasks.filter((task) => task.stage === "comparison")) {
    const key = (task.data as TaskData).group!.join("+");
    groups[key] = (groups[key] ?? 0) + 1;
  }
  plan.summary.group_counts = groups;
  for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, BatchPreflight>)) {
    const tasks = plan.tasks.filter((task) => taskIdentity(task.data as TaskData).batch_id === batch);
    counts.attribution_tasks = tasks.filter((task) => task.stage === "attribution").length;
    counts.comparison_tasks = tasks.filter((task) => task.stage === "comparison").length;
  }
  return plan;
}

export function createAutomationWorkflow(limit: number): WorkflowDefinition {
  return {
    ...comparisonWorkflow,
    plan: async (config) => limitAutomationPlan(await comparisonWorkflow.plan(config), limit),
    reconcile: async (run, state, current) => {
      const previous = state.manifest.tasks;
      const plan = limitAutomationPlan(await reconcileRun(run, state, current, { extendVersions: true }),
        limit, new Set(Object.keys(state.receipts)), previous);
      state.manifest.tasks = plan.tasks;
      const active = new Set(plan.tasks.filter(isAutomationTask).map((task) => task.id));
      state.manifest.pausedStages = (state.manifest.pausedStages ?? []).map((pause) => ({
        ...pause, taskIds: pause.taskIds.filter((id) => active.has(id)),
      })).filter((pause) => pause.taskIds.length);
      return plan;
    },
  };
}

function limitedCheckpoint(state: Checkpoint, limit: number): Checkpoint {
  const tasks = Object.entries(state.tasks).map(([id, task]) => ({ ...task, id }));
  const selected = automationSelection(tasks, new Set(tasks.filter((task) => task.receipt).map((task) => task.id)), limit);
  return { ...state, tasks: Object.fromEntries(Object.entries(state.tasks).filter(([id]) => selected.has(id))),
    pausedStages: (state.pausedStages ?? []).map((pause) => ({ ...pause, taskIds: pause.taskIds.filter((id) => selected.has(id)) }))
      .filter((pause) => pause.taskIds.length),
  };
}

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
function exhaustedContentReason(states: Checkpoint[], repairAttempts: number): string | undefined {
  const cap = 1 + repairAttempts;
  const exhausted = states.flatMap(state => Object.entries(state.tasks).flatMap(([id, task]) => {
    const count = task.failure?.contentSubmissions;
    return isAutomationTask(task) && !task.receipt && Number.isSafeInteger(count) && count! >= cap
      ? [`${state.runId ?? "run"}/${id}: content submissions ${count}/${cap}`] : [];
  }));
  return exhausted.length ? `Content submission budget exhausted: ${exhausted.join("; ")}. Adjust the cumulative cap or resolve the unfinished work.` : undefined;
}
function unavailableLedgerReason(states: Checkpoint[]): string | undefined {
  const unknown = states.flatMap(state => Object.entries(state.tasks).filter(([, task]) =>
    isAutomationTask(task) && !task.receipt && task.failure?.errors.some(issue => issue.code === "submission_ledger_unavailable"))
    .map(([id]) => `${state.runId ?? "run"}/${id}`));
  return unknown.length ? `Final content submission ledger is unavailable: ${unknown.join(", ")}; explicit recovery is required.` : undefined;
}
export function automaticResumeStages(state: Checkpoint, repairAttempts: number): string[] {
  if (exhaustedContentReason([state], repairAttempts) || unavailableLedgerReason([state])) return [];
  return automationPauses(state).filter((pause) => temporary(pause.category)).map((pause) => pause.stage);
}

/** Authority comes from Host receipts and failure categories, never the dashboard's old error text. */
export function checkpointRecovery(states: Checkpoint[], repairAttempts: number): "interrupted" | "transient" | undefined {
  if (exhaustedContentReason(states, repairAttempts) || unavailableLedgerReason(states)) return;
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

/** Final accepted uncertainty only stops retries when every unfinished task is its blocked descendant. */
function terminalReviewReason(states: Checkpoint[]): string | undefined {
  const reviews: string[] = [];
  for (const state of states) {
    const entries = Object.entries(state.tasks);
    const final = entries.filter(([, task]) => task.stage === "comparison" && !task.data.verificationPending && !task.data.supersededBy &&
      (task.data.reviewOf?.round ?? 0) >= 1 && task.status === "succeeded" && task.receipt?.status === "succeeded" &&
      task.receipt.exported?.file === "comparison-review.jsonl");
    const descendants = new Set(final.map(([id]) => id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, task] of entries) {
        if (!descendants.has(id) && Object.values(task.dependencies ?? {}).some((parent) => descendants.has(parent))) {
          descendants.add(id); changed = true;
        }
      }
    }
    if (entries.some(([id, task]) => isAutomationTask(task) && (task.status !== "succeeded" || !task.receipt) &&
      (task.status !== "blocked" || !descendants.has(id)))) return;
    reviews.push(...final.map(([id]) => id));
  }
  return reviews.length ? `Independent review is unresolved after the final review: ${reviews.join(", ")}` : undefined;
}

export function evaluationOutcome(states: Checkpoint[], summary: EvaluationSummary, repairAttempts: number, empty = false): EvaluationOutcome {
  const blocked = exhaustedContentReason(states, repairAttempts) ?? unavailableLedgerReason(states);
  if (blocked) return { status: "blocked", summary, transient: false, error: blocked };
  const review = terminalReviewReason(states);
  if (review) return { status: "blocked", summary, transient: false, error: review };
  const pauses = states.flatMap(automationPauses);
  if (pauses.length) {
    const transient = pauses.every((pause) => temporary(pause.category));
    return { status: transient ? "retry" : "blocked", summary, transient,
      error: incompleteReason(states, summary) };
  }
  if (Object.values(summary.stages).some((stage) => stage.completed !== stage.total))
    return { status: "retry", summary, transient: checkpointRecovery(states, repairAttempts) !== undefined,
      error: incompleteReason(states, summary) };
  if (empty || !summary.stages.comparison?.total || summary.skipped || summary.issues)
    return { status: "waiting_inputs", summary };
  return { status: "completed", summary };
}

export async function recoverEvaluation(config: AutomationConfig, output: string, job: AutomationJob, repairAttempts: number) {
  job.runIds = [`${config.runPrefix}${job.date}`];
  const saved = await checkpoint(output, job.runIds[0]);
  if (!saved) return;
  const limited = limitedCheckpoint(saved, config.dailyComparisonLimitPerTier);
  if (Object.entries(saved.tasks).some(([id, task]) => task.stage === "comparison" && !limited.tasks[id]) &&
      !automationPauses(limited).some((pause) => !temporary(pause.category))) return "interrupted";
  job.summary = summarize([saved]);
  const exhausted = exhaustedContentReason([saved], repairAttempts), unknown = unavailableLedgerReason([saved]);
  if (exhausted || unknown && !job.resumePaused) {
    job.evaluation = "blocked"; job.nextEvaluationAt = 0;
    job.evaluationError = exhausted ?? unknown;
    return;
  }
  if (unknown && job.resumePaused) return "interrupted";
  const selection = saved.config as EvalConfig;
  if (job.mongo?.synced && Object.values(saved.tasks).some((task) =>
    task.data.rewriteOf?.stage === "comparison" && task.data.comparisonRewriteScope !== "all"))
    delete job.mongo.synced;
  if (["completed", "waiting_inputs"].includes(job.evaluation) &&
      REMOTE_MODELS.some((id) => !selection.inputs.versions.some((version) => version.id === id))) return "interrupted";
  const review = terminalReviewReason([saved]);
  if (review) {
    job.evaluation = "blocked"; job.nextEvaluationAt = 0;
    job.evaluationError = review;
    return;
  }
  const complete = publishableComparisons(saved, true);
  const finalComparisons = Object.values(saved.tasks).filter((task) => task.stage === "comparison" && !task.data.verificationPending && !task.data.supersededBy);
  if (finalComparisons.length > complete.size &&
      Object.values(job.summary.stages).every((stage) => stage.completed === stage.total)) return "interrupted";
  if (Object.values(job.summary.stages).every((stage) => stage.completed === stage.total) && !automationPauses(saved).length) {
    job.evaluation = job.summary.skipped || job.summary.issues || !job.summary.stages.comparison?.total ? "waiting_inputs" : "completed";
    job.evaluationAttempts = 0; job.nextEvaluationAt = 0;
    delete job.evaluationError;
    return;
  }
  const recovery = checkpointRecovery([saved], repairAttempts);
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
  const workflow = createAutomationWorkflow(config.dailyComparisonLimitPerTier);
  const modelForStage = createModelResolver(host.models);
  for (const stage of ["criteria", "attribution", "comparison", "rewrite"]) modelForStage(stage);
  for (const profile of boundProfiles(host.models)) {
    if (!process.env[profile.apiKeyEnv]) throw new Error(`Missing ${profile.apiKeyEnv}`);
    logger.addSecrets(process.env[profile.apiKeyEnv]!);
  }
  let empty = false, skipped = 0, issues = 0;
  const checkpoints: Checkpoint[] = [];
  for (const runId of job.runIds) {
    signal.throwIfAborted();
    const previous = await checkpoint(output, runId);
    const resumable = previous && limitedCheckpoint(previous, config.dailyComparisonLimitPerTier);
    const evaluation = automationEvaluationConfig(host.evaluation, config.sourceDirectory, job.date);
    if (await hasLiveRunOwner(path.join(output, runId))) throw new Error(`${runId} is owned by another live Host`);
    const plan = previous ? { tasks: [], inputs: {}, summary: {} } : await workflow.plan(evaluation);
    if (!previous && !plan.tasks.length && !plan.summary.valid_inputs) {
      empty = true;
      skipped += (plan.summary.skipped as unknown[]).length;
      issues += (plan.summary.issues as unknown[]).length;
      continue;
    }
    await runEvaluation({
      ...services, runId, output: evaluation.output, engine: config.engine, evaluatorVersion: host.evaluatorVersion,
      taskSource: workflow,
      config: evaluation, plan, policy: evaluation.execution, modelForStage,
      concurrency: evaluation.execution.concurrency, retries: evaluation.execution.retries,
      retryDelaySeconds: evaluation.execution.retryDelaySeconds, failureGuard: evaluation.execution.failureGuard,
      discoverInputs: true, signal,
      resumeStages: resumable ? (resumePaused ? automationPauses(resumable).map((pause) => pause.stage) : automaticResumeStages(resumable, evaluation.execution.repairAttempts)) : [],
    });
    signal.throwIfAborted();
    checkpoints.push((await checkpoint(output, runId))!);
  }
  const summary = summarize(checkpoints);
  summary.skipped += skipped; summary.issues += issues;
  return evaluationOutcome(checkpoints, summary, host.evaluation.execution.repairAttempts, empty);
}

export function remoteProgress(state: AutomationState, engine: AutomationConfig["engine"], runs: Map<string, Checkpoint[]>, limit: number) {
  const dates = Object.values(state.jobs).map((job) => {
    const planned = expandComparisonPairs((runs.get(job.date) ?? []).flatMap((run) => [
      ...(run.config as EvalConfig).comparisons,
      ...Object.values(run.tasks).flatMap((task) => task.stage === "comparison" && !task.data.verificationPending && task.receipt && task.data.group ? [task.data.group] : []),
    ]));
    const pairName = (group: string[]) => [...group].sort().join("__vs__");
    const pairs = Object.fromEntries(planned.map((pair) => [pairName(pair), {
      total_cases: 0, completed_cases: 0, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0,
    }]));
    const statuses = new Map<string, { pair: string; statuses: string[] }>();
    const add = (group: string[], batch: string, id: string, status: string) => {
      if (group.length !== 2) throw new Error("Remote progress requires two-candidate comparison tasks");
      const pair = pairName(group);
      if (!Object.hasOwn(pairs, pair)) throw new Error("Remote progress comparison pair is not configured: " + pair);
      const key = JSON.stringify([pair, batch, id]), value = statuses.get(key) ?? { pair, statuses: [] };
      value.statuses.push(status); statuses.set(key, value);
    };
    for (const saved of runs.get(job.date) ?? []) {
      // A queued date may still hold its unlimited plan until the evaluator reaches it.
      const run = limitedCheckpoint(saved, limit);
      for (const task of Object.values(run.tasks)) {
        if (task.stage !== "comparison" || task.data.verificationPending || task.data.supersededBy) continue;
        const input = run.inputs[Object.values(task.inputIds)[0]];
        if (input) add(task.data.group!, input.batch_id, input.case_id,
          task.receipt?.exported?.file === "comparison-review.jsonl" ? "pending" : task.status);
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
