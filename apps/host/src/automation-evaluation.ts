import path from "node:path";
import { type PlannedTask, type RemoteDay, type TaskPlan, type WorkflowDefinition, type Policy } from "@eval/contracts";
import { hasLiveRunOwner, readJson } from "@eval/data";
import { runEvaluation, type ModelRequestControl } from "@eval/host";
import type { AutomationJob, AutomationState, EvaluationOutcome, EvaluationSummary } from "@eval/automations";
import { comparisonWorkflow, expandComparisonPairs, publishableComparisons, reconcileRun, taskIdentity, type BatchPreflight, type Checkpoint, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import { configurationSecrets, loadConfig } from "./config.js";
import { createAutomationModels } from "./automation-models.js";
import { services, logger } from "./composition.js";
import { automationEvaluationConfig, type AutomationConfig } from "./automation-config.js";
import { predictionEvaluationConfig } from "./automation-prediction.js";

/** A daily run reserves battles separately for each pair; accepted work always survives the cap. */
function automationSelection(
  tasks: Pick<PlannedTask, "id" | "stage" | "dependencies" | "data">[], accepted: ReadonlySet<string>, limit: number,
  groups: readonly (readonly string[])[],
): Set<string> {
  const selected = new Set(accepted), counts = new Map<string, number>();
  const allowed = new Set(expandComparisonPairs(groups).map(pair => pair.slice().sort().join("+")));
  const comparisons = tasks.filter((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit);
  const group = (task: typeof tasks[number]) => (task.data as TaskData).group!.slice().sort().join("+");
  for (const task of comparisons.filter((task) => accepted.has(task.id)))
    counts.set(group(task), (counts.get(group(task)) ?? 0) + 1);
  for (const task of comparisons) {
    if (accepted.has(task.id)) continue;
    const key = group(task), count = counts.get(key) ?? 0;
    if (!allowed.has(key)) continue;
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

function executionSelection(tasks: Pick<PlannedTask, "id" | "stage" | "dependencies" | "data">[], accepted: ReadonlySet<string>,
  limit: number, groups: readonly (readonly string[])[]) {
  const allowed = new Set(expandComparisonPairs(groups).map(pair => pair.slice().sort().join("+")));
  const retained = new Set(tasks.filter(task => task.stage === "comparison" && accepted.has(task.id) &&
    allowed.has(((task.data as TaskData).group ?? []).slice().sort().join("+"))).map(task => task.id));
  const selected = automationSelection(tasks, retained, limit, groups);
  for (const id of accepted) selected.add(id);
  return selected;
}

function limitAutomationPlan(plan: TaskPlan, limit: number, allowedGroups: readonly (readonly string[])[],
  accepted = new Set<string>(), previous: PlannedTask[] = []) {
  const current = new Map(plan.tasks.map((task) => [task.id, task]));
  const previousIds = new Set(previous.map((task) => task.id));
  // Keep reserved battles ahead of newly discovered cases, even when source order changes.
  const ordered = [...previous.flatMap((task) => current.has(task.id) ? [current.get(task.id)!] : []),
    ...plan.tasks.filter((task) => !previousIds.has(task.id))];
  const selected = automationSelection(ordered, accepted, limit, allowedGroups);
  plan.tasks = plan.tasks.filter((task) => selected.has(task.id)).sort((a, b) =>
    Number((b.data as TaskData).rewriteOf?.stage === "comparison") -
    Number((a.data as TaskData).rewriteOf?.stage === "comparison"));
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
    plan: async (config) => limitAutomationPlan(await comparisonWorkflow.plan(config), limit, (config as EvalConfig).comparisons),
    reconcile: async (run, state, current) => {
      delete state.manifest.executionScope;
      const previous = state.manifest.tasks;
      const plan = limitAutomationPlan(await reconcileRun(run, state, current, { extendVersions: true, preserveCompletedResults: true }),
        limit, (current as EvalConfig).comparisons, new Set(Object.keys(state.receipts)), previous);
      state.manifest.tasks = plan.tasks;
      // Retain old receipts and unfinished polish declarations for publication validation,
      // while dispatching new work only for the currently requested model pairs.
      const executable = executionSelection(plan.tasks, new Set(Object.keys(state.receipts)), limit, (current as EvalConfig).comparisons);
      state.manifest.executionScope = plan.tasks.filter(task => executable.has(task.id)).map(task => task.id);
      const active = new Set(plan.tasks.filter(task => executable.has(task.id) && isAutomationTask(task)).map((task) => task.id));
      state.manifest.pausedStages = (state.manifest.pausedStages ?? []).map((pause) => ({
        ...pause, taskIds: pause.taskIds.filter((id) => active.has(id)),
      })).filter((pause) => pause.taskIds.length);
      return plan;
    },
  };
}

function limitedCheckpoint(state: Checkpoint, limit: number, groups = (state.config as EvalConfig).comparisons): Checkpoint {
  const tasks = Object.entries(state.tasks).map(([id, task]) => ({ ...task, id }));
  const selected = executionSelection(tasks, new Set(tasks.filter(task => task.receipt).map(task => task.id)), limit, groups);
  return { ...state, tasks: Object.fromEntries(Object.entries(state.tasks).filter(([id]) => selected.has(id))),
    pausedStages: (state.pausedStages ?? []).map((pause) => ({ ...pause, taskIds: pause.taskIds.filter((id) => selected.has(id)) }))
      .filter((pause) => pause.taskIds.length),
  };
}

export function isAutomationTask(task: { stage: string; data: unknown }): boolean {
  const data = task.data as { verificationAudit?: boolean; rewriteOf?: { stage: string } };
  return task.stage !== "clustering" && !data.verificationAudit && data.rewriteOf?.stage !== "clustering";
}

function automationPauses(state: Checkpoint) {
  return (state.pausedStages ?? []).map((pause) => ({ ...pause,
    taskIds: pause.taskIds.filter((id) => state.tasks[id] && isAutomationTask(state.tasks[id]) &&
      (state.tasks[id].stage !== "rewrite" || state.tasks[id].data.rewriteOf?.stage === "comparison" || temporary(pause.category))),
  })).filter((pause) => pause.taskIds.length);
}

export async function checkpoint(output: string, runId: string): Promise<Checkpoint | undefined> {
  try { return await readJson<Checkpoint>(path.join(output, runId, "state.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function summarize(checkpoints: Checkpoint[]): EvaluationSummary {
  const summary: EvaluationSummary = { stages: {}, skipped: 0, issues: 0, readyComparisons: 0 };
  for (const state of checkpoints) {
    summary.readyComparisons += publishableComparisons(state).size;
    summary.skipped += (state.preflight.skipped as unknown[]).length;
    summary.issues += (state.preflight.issues as unknown[]).length;
    for (const [id, task] of Object.entries(state.tasks)) {
      if (state.executionScope && !state.executionScope.includes(id)) continue;
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

type RepairPolicy = Pick<Policy, "repairAttempts" | "stageRepairAttempts" | "maxTaskAttempts">;

/** Exhausted samples are terminal only after all other selected work has drained. */
function terminalAttemptLimitReason(states: Checkpoint[], policy: RepairPolicy): string | undefined {
  if (policy.maxTaskAttempts === undefined) return;
  let exhausted = 0;
  for (const state of states) {
    const scope = state.executionScope && new Set(state.executionScope);
    const entries = Object.entries(state.tasks).filter(([id, task]) => (!scope || scope.has(id)) && isAutomationTask(task));
    const terminal = new Set(entries.filter(([, task]) => {
      if (task.receipt?.exported?.file === "comparison-review.jsonl") return true;
      if (!task.receipt && ["failed", "timed_out", "cancelled"].includes(task.status) && task.attempts >= policy.maxTaskAttempts!) {
        exhausted++; return true;
      }
      return false;
    }).map(([id]) => id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, task] of entries) if (!terminal.has(id) && task.status === "blocked" &&
        Object.values(task.dependencies).some(parent => terminal.has(parent))) {
        terminal.add(id); changed = true;
      }
    }
    if (entries.some(([id, task]) => !(task.status === "succeeded" && task.receipt) && !terminal.has(id))) return;
  }
  return exhausted ? `Task attempt limit reached for ${exhausted} tasks; other selected work is complete.` : undefined;
}

const temporary = (category: string) => category === "transport" || category === "interruption";
function exhaustedContentReason(states: Checkpoint[], policy: RepairPolicy): string | undefined {
  const exhausted = states.flatMap(state => Object.entries(state.tasks).flatMap(([id, task]) => {
    const count = task.failure?.contentSubmissions;
    const cap = 1 + (policy.stageRepairAttempts?.[task.stage] ?? policy.repairAttempts);
    return isAutomationTask(task) && (task.stage !== "rewrite" || task.data.rewriteOf?.stage === "comparison") &&
      !task.receipt && Number.isSafeInteger(count) && count! >= cap
      ? [`${state.runId ?? "run"}/${id}: content submissions ${count}/${cap}`] : [];
  }));
  return exhausted.length ? `Content submission budget exhausted: ${exhausted.join("; ")}. Adjust the cumulative cap or resolve the unfinished work.` : undefined;
}
export function automaticResumeStages(state: Checkpoint, policy: RepairPolicy): string[] {
  if (terminalAttemptLimitReason([state], policy)) return [];
  if (exhaustedContentReason([state], policy)) return [];
  return automationPauses(state).filter((pause) => temporary(pause.category)).map((pause) => pause.stage);
}

/** Authority comes from Host receipts and failure categories, never the dashboard's old error text. */
export function checkpointRecovery(states: Checkpoint[], policy: RepairPolicy): "interrupted" | "transient" | undefined {
  if (terminalAttemptLimitReason(states, policy)) return;
  if (exhaustedContentReason(states, policy)) return;
  if (!states.length || states.some((state) => automationPauses(state).some((pause) => !temporary(pause.category)))) return;
  const tasks = states.flatMap((state) => Object.values(state.tasks).filter(task => isAutomationTask(task) &&
    (task.stage !== "rewrite" || task.status === "pending" || task.status === "running" ||
      task.failure?.errors.length && task.failure.errors.every(issue => temporary(issue.category)))));
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
    const final = entries.filter(([, task]) => task.stage === "comparison" && !task.data.verificationAudit &&
      task.status === "succeeded" && task.receipt?.status === "succeeded" &&
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
    if (entries.some(([id, task]) => isAutomationTask(task) && task.stage !== "rewrite" && (task.status !== "succeeded" || !task.receipt) &&
      (task.status !== "blocked" || !descendants.has(id)))) return;
    reviews.push(...final.map(([id]) => id));
  }
  return reviews.length ? `Comparison remains unresolved: ${reviews.join(", ")}` : undefined;
}

function waitingForInputs(states: Checkpoint[], summary: EvaluationSummary, limit: number, empty = false): boolean {
  if (empty || !summary.stages.comparison?.total || summary.issues) return true;
  if (!summary.skipped) return false;
  const counts = new Map<string, number>(), groupKey = (group: string[]) => [...group].sort().join("+");
  for (const state of states) for (const task of Object.values(state.tasks)) {
    if (task.stage !== "comparison" || task.data.verificationAudit || !task.receipt) continue;
    const key = groupKey(task.data.group!);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return states.some(state => (state.preflight.skipped as { versions: string[] }[])
    .some(skipped => (counts.get(groupKey(skipped.versions)) ?? 0) < limit));
}

function evaluationComplete(states: Checkpoint[], summary: EvaluationSummary): boolean {
  return Object.entries(summary.stages).every(([name, stage]) => name === "rewrite"
    ? states.every(state => !Object.values(state.tasks).some(task => isAutomationTask(task) && task.stage === "rewrite" &&
      (task.data.rewriteOf?.stage === "comparison" && task.status !== "succeeded" ||
        task.status === "running" || task.status === "pending" && !state.pausedStages?.some(pause => pause.stage === "rewrite") ||
        task.status === "failed" && task.failure?.errors.length && task.failure.errors.every(issue => temporary(issue.category)))))
    : stage.completed === stage.total);
}

export function evaluationOutcome(states: Checkpoint[], summary: EvaluationSummary, policy: RepairPolicy, limit: number, empty = false): EvaluationOutcome {
  const attempts = terminalAttemptLimitReason(states, policy);
  if (attempts) return { status: "blocked", summary, transient: false, error: attempts };
  const blocked = exhaustedContentReason(states, policy);
  if (blocked) return { status: "blocked", summary, transient: false, error: blocked };
  const review = terminalReviewReason(states);
  if (review) return { status: "blocked", summary, transient: false, error: review };
  const pauses = states.flatMap(automationPauses);
  if (pauses.length) {
    const transient = pauses.every((pause) => temporary(pause.category));
    return { status: transient ? "retry" : "blocked", summary, transient,
      error: incompleteReason(states, summary) };
  }
  if (!evaluationComplete(states, summary))
    return { status: "retry", summary, transient: checkpointRecovery(states, policy) !== undefined,
      error: incompleteReason(states, summary) };
  if (waitingForInputs(states, summary, limit, empty))
    return { status: "waiting_inputs", summary };
  return { status: "completed", summary };
}

export async function recoverEvaluation(config: AutomationConfig, output: string, job: AutomationJob, policy: RepairPolicy,
  groups?: EvalConfig["comparisons"],
) {
  job.runIds = [`${config.runPrefix}${job.date}`];
  const saved = await checkpoint(output, job.runIds[0]);
  if (!saved) return;
  const limited = limitedCheckpoint(saved, config.dailyComparisonLimitPerTier, groups);
  if (Object.entries(saved.tasks).some(([id, task]) => task.stage === "comparison" && !task.data.verificationAudit && !limited.tasks[id]) &&
      !automationPauses(limited).some((pause) => !temporary(pause.category))) return "interrupted";
  const visible = groups || saved.executionScope ? limited : saved;
  job.summary = summarize([{ ...saved, executionScope: Object.keys(visible.tasks) }]);
  const exhausted = exhaustedContentReason([visible], policy);
  if (exhausted) {
    job.evaluation = "blocked"; job.nextEvaluationAt = 0;
    job.evaluationError = exhausted;
    return;
  }
  const selection = saved.config as EvalConfig;
  if (!config.prediction && ["completed", "waiting_inputs"].includes(job.evaluation) &&
      config.remoteModels.some((id) => !selection.inputs.versions.some((version) => version.id === id))) return "interrupted";
  const review = terminalReviewReason([visible]);
  if (review) {
    job.evaluation = "blocked"; job.nextEvaluationAt = 0;
    job.evaluationError = review;
    return;
  }
  const complete = publishableComparisons(saved);
  const allowed = new Set(expandComparisonPairs(groups ?? (saved.config as EvalConfig).comparisons).map(pair => pair.slice().sort().join("+")));
  const finalComparisons = Object.values(limited.tasks).filter((task) => task.stage === "comparison" && !task.data.verificationAudit &&
    allowed.has(task.data.group!.slice().sort().join("+")));
  if (finalComparisons.some(task => !complete.has(task.data.comparisonId!)) &&
      evaluationComplete([visible], job.summary)) return "interrupted";
  if (evaluationComplete([visible], job.summary) && !automationPauses(visible).length) {
    job.evaluation = waitingForInputs([visible], job.summary, config.dailyComparisonLimitPerTier) ? "waiting_inputs" : "completed";
    job.evaluationAttempts = 0; job.nextEvaluationAt = 0;
    delete job.evaluationError;
    return;
  }
  const recovery = checkpointRecovery([visible], policy);
  if (recovery === "transient" || automationPauses(visible).length) job.evaluationError = incompleteReason([visible], job.summary);
  return recovery;
}

export async function evaluationTargets(config: AutomationConfig, output: string, day: RemoteDay) {
  const primary = `${config.runPrefix}${day.date}`, saved = await checkpoint(output, primary);
  const previousConfig = saved?.config as EvalConfig | undefined;
  if (!config.prediction && previousConfig && (previousConfig.inputs.limit || previousConfig.inputs.case_ids?.length ||
    previousConfig.inputs.batches?.some((batch) => batch !== day.date)))
    throw new Error(`${primary} has a restricted input selection; choose an unrestricted daily run`);
  const runIds = [primary];
  const adopted = config.completedDates.includes(day.date);
  if (adopted) {
    if (!saved || saved.status !== "finished" ||
        Object.values(saved.tasks).some((task) => task.status !== "succeeded" || !task.receipt))
      throw new Error(`Historical run is not complete: ${primary}`);
    const counts = Object.fromEntries(Object.keys(day.rows).map((model) =>
      [model, Object.values(saved.inputs).filter((input) => input.version === model).length]));
    // Do not hide newly arrived rows behind a historical completion marker.
    const matched = Object.keys(day.rows).every((model) => counts[model] === day.rows[model] &&
      previousConfig!.inputs.versions.some(version => version.id === model));
    return { runIds, adopted: matched, summary: summarize([saved]) };
  }
  return { runIds, adopted: false };
}

export async function evaluateDay(config: AutomationConfig, job: AutomationJob, signal: AbortSignal, exhaustedChannels: Set<string>,
  modelRequests?: ModelRequestControl,
): Promise<EvaluationOutcome> {
  const resumePaused = job.resumePaused;
  delete job.resumePaused;
  const host = await loadConfig(config.hostConfigs), output = host.evaluation.output.path;
  const workflow = createAutomationWorkflow(config.dailyComparisonLimitPerTier);
  const routing = createAutomationModels(host.models, host.automation.channels, exhaustedChannels, config.channelConcurrency);
  logger.addSecrets(...configurationSecrets());
  let empty = false, skipped = 0, issues = 0;
  const checkpoints: Checkpoint[] = [];
  for (const runId of job.runIds) {
    signal.throwIfAborted();
    const previous = await checkpoint(output, runId);
    const evaluation = config.prediction ? await predictionEvaluationConfig(config, output, host.evaluation, job.date)
      : automationEvaluationConfig(host.evaluation, config.sourceDirectory, job.date, config.remoteModels);
    const resumable = previous && limitedCheckpoint(previous, config.dailyComparisonLimitPerTier, evaluation.comparisons);
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
      config: evaluation, plan, policy: evaluation.execution, ...routing,
      concurrency: modelRequests?.concurrency() || evaluation.execution.concurrency, modelRequests, retries: evaluation.execution.retries,
      retryDelaySeconds: evaluation.execution.retryDelaySeconds, failureGuard: evaluation.execution.failureGuard,
      discoverInputs: true, signal,
      resumeStages: resumable ? (resumePaused ? automationPauses(resumable).map((pause) => pause.stage) : automaticResumeStages(resumable, evaluation.execution)) : [],
    });
    signal.throwIfAborted();
    checkpoints.push((await checkpoint(output, runId))!);
  }
  const summary = summarize(checkpoints);
  summary.skipped += skipped; summary.issues += issues;
  return evaluationOutcome(checkpoints.map(state => limitedCheckpoint(state, config.dailyComparisonLimitPerTier)),
    summary, host.evaluation.execution, config.dailyComparisonLimitPerTier, empty);
}

const emptyPairCounts = () => ({
  total_cases: 0, completed_cases: 0, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0,
});

export function remoteDateProgress(date: string, runs: Checkpoint[], limit: number) {
  const planned = expandComparisonPairs(runs.flatMap((run) => [
    ...(run.config as EvalConfig).comparisons,
    ...Object.values(run.tasks).flatMap((task) => task.stage === "comparison" && !task.data.verificationAudit && task.receipt && task.data.group ? [task.data.group] : []),
  ]));
  const pairName = (group: string[]) => [...group].sort().join("__vs__");
  const pairs = Object.fromEntries(planned.map((pair) => [pairName(pair), emptyPairCounts()]));
  const statuses = new Map<string, { pair: string; statuses: string[] }>();
  const add = (group: string[], batch: string, id: string, status: string) => {
    if (group.length !== 2) throw new Error("Remote progress requires two-candidate comparison tasks");
    const pair = pairName(group);
    if (!Object.hasOwn(pairs, pair)) throw new Error("Remote progress comparison pair is not configured: " + pair);
    const key = JSON.stringify([pair, batch, id]), value = statuses.get(key) ?? { pair, statuses: [] };
    value.statuses.push(status); statuses.set(key, value);
  };
  for (const saved of runs) {
    // A queued date may still hold its unlimited plan until the evaluator reaches it.
    const run = limitedCheckpoint(saved, limit);
    for (const task of Object.values(run.tasks)) {
      if (task.stage !== "comparison" || task.data.verificationAudit) continue;
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
  return { date, pairs };
}

export function remoteProgress(state: AutomationState, engine: AutomationConfig["engine"], dates: ReturnType<typeof remoteDateProgress>[]) {
  const sourcePath = new URL(state.sourceUrl).pathname.replace(/\/+$/, "");
  const namedPairs = ["/data/gpt", "/data/post_training_model"].includes(sourcePath);
  const active = Object.values(state.jobs).some((job) => job.download !== "ready" ||
    ["pending", "evaluating", "retry"].includes(job.evaluation));
  return {
    run_id: `automation-${state.id}`, engine, started_at: state.startedAt, updated_at: Date.now(),
    dates: dates.map(({ date, pairs }) => ({ date, pairs: namedPairs ? { ...pairs } : {
      fast: pairs.a_fast__vs__b_fast ?? emptyPairCounts(),
      expert: pairs.a_expert__vs__b_expert ?? emptyPairCounts(),
    } })),
    status: active ? (state.status === "stopped" ? "interrupted" : "running") :
      Object.values(state.jobs).some((job) => job.evaluation === "blocked") ? "interrupted" : "finished",
  };
}
