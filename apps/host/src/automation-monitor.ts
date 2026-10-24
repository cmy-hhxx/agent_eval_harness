import path from "node:path";
import { fileSourceReader } from "@eval/data";
import type { AutomationJob } from "@eval/automations";
import { publishableComparisons, type Checkpoint } from "@eval/workflows/comparison";
import { checkpoint, summarize, isAutomationTask, remoteDateProgress } from "./automation-evaluation.js";
import { comparisonEvaluationAnalytics, type EvaluationAnalytics } from "./daily-evaluation-analytics.js";

const HOUR = 60 * 60 * 1000;

export function cacheUsage(runs: { usage: Checkpoint["usage"] }[]) {
  let readTokens = 0, inputTokens = 0;
  for (const run of runs) {
    readTokens += run.usage.cacheRead;
    inputTokens += run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;
  }
  return { readTokens, inputTokens, hitRate: inputTokens ? readTokens / inputTokens : null };
}

/** Counts attempts and distinct cases separately; a case can have several active stages. */
function projectExecution(runs: Checkpoint[]) {
  const cases = new Set<string>(), stages: Record<string, number> = { criteria: 0, attribution: 0, comparison: 0, rewrite: 0 };
  const retryingStages: Record<string, number> = { criteria: 0, attribution: 0, comparison: 0, rewrite: 0 };
  let retryingTasks = 0, readyTasks = 0, waitingDependencies = 0, nextRetryAt: number | undefined;
  for (const run of runs) for (const task of Object.values(run.tasks)) {
    if (!isAutomationTask(task)) continue;
    if (task.nextRetryAt !== undefined) {
      retryingTasks++;
      retryingStages[task.stage]++;
      nextRetryAt = Math.min(nextRetryAt ?? Infinity, task.nextRetryAt);
    }
    if (task.status === "pending" && task.nextRetryAt === undefined && !run.pausedStages?.some(pause => pause.stage === task.stage)) {
      if (Object.values(task.dependencies).every(id => run.tasks[id]?.status === "succeeded")) readyTasks++;
      else waitingDependencies++;
    }
    if (task.status !== "running") continue;
    stages[task.stage]++;
    for (const id of Object.values(task.inputIds)) {
      const input = run.inputs[id];
      if (input) cases.add(JSON.stringify([input.batch_id, input.case_id]));
    }
  }
  return { runningTasks: Object.values(stages).reduce((a, b) => a + b, 0), runningCases: cases.size, cases: [...cases],
    stages, retryingStages, readyTasks, waitingDependencies, retryingTasks, nextRetryAt };
}

/** Derived from persisted Host receipts, so refreshes and restarts never increment counters. */
export function completionTimeline(runs: Checkpoint[]) {
  const hours = new Map<number, { start: number; completed: number; stages: Record<string, number> }>();
  const bucket = (at: number) => {
    const start = Math.floor(at / HOUR) * HOUR;
    if (!hours.has(start)) hours.set(start, { start, completed: 0, stages: {} });
    return hours.get(start)!;
  };
  for (const run of runs) {
    for (const task of Object.values(run.tasks)) {
      if (!isAutomationTask(task)) continue;
      if (task.status !== "succeeded" || !task.receipt?.exported || !Number.isFinite(task.receipt.acceptedAt)) continue;
      const counts = bucket(task.receipt.acceptedAt).stages;
      counts[task.stage] = (counts[task.stage] ?? 0) + 1;
    }
    for (const at of publishableComparisons(run).values()) bucket(at).completed++;
  }
  return [...hours.values()].sort((a, b) => b.start - a.start);
}

function project(job: AutomationJob, runs: Checkpoint[], limit: number) {
  const coverage: { coverage?: EvaluationAnalytics } = { coverage: comparisonEvaluationAnalytics(job.date, runs) };
  return {
    ...coverage,
    summary: runs.length ? summarize(runs) : undefined,
    hours: completionTimeline(runs),
    progress: remoteDateProgress(job.date, runs, limit),
    runs: runs.map(run => ({ runId: run.runId, status: run.status, evaluatorVersion: run.evaluatorVersion,
      concurrency: run.concurrency, usage: run.usage, execution: projectExecution([run]) })),
  };
}
type RunObservation = ReturnType<typeof project>["runs"][number];

export function liveExecution(runs: RunObservation[]) {
  const combined = projectExecution([]), cases = new Set<string>();
  for (const { execution } of runs) {
    for (const key of ["runningTasks", "readyTasks", "waitingDependencies", "retryingTasks"] as const)
      combined[key] += execution[key];
    for (const stage of Object.keys(combined.stages)) {
      combined.stages[stage] += execution.stages[stage];
      combined.retryingStages[stage] += execution.retryingStages[stage];
    }
    for (const id of execution.cases) cases.add(id);
    if (execution.nextRetryAt !== undefined)
      combined.nextRetryAt = Math.min(combined.nextRetryAt ?? Infinity, execution.nextRetryAt);
  }
  const { cases: _cases, ...view } = combined;
  return { ...view, runningCases: cases.size };
}

/** Shared read-only monitoring projections, keyed by filesystem identity and timestamps.
 * Never retains checkpoints, drafts, answers or results; evaluation and publication read their own authority. */
export function createAutomationMonitor(output: string, limit: number,
  dependencies = { checkpoint, revision: fileSourceReader.revision },
) {
  const entries = new Map<string, { key: string; value: Promise<ReturnType<typeof project>> }>();
  return async (job: AutomationJob) => {
    const revisions = () => Promise.all(job.runIds.map(async id => {
      try { return await dependencies.revision(path.join(output, id, "state.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }));
    try {
      const before = await revisions(), key = JSON.stringify([job.runIds, job.adopted, before]);
      let entry = entries.get(job.date);
      if (entry?.key !== key) {
        const read = async () => {
          const runs: Checkpoint[] = [];
          for (const id of job.runIds) {
            const run = await dependencies.checkpoint(output, id);
            if (run) runs.push(run);
          }
          const view = project(job, runs, limit);
          const after = await revisions();
          // A concurrent atomic replacement is a valid snapshot, but must be reread next time.
          if (JSON.stringify(before) !== JSON.stringify(after) && entries.get(job.date) === current)
            entries.delete(job.date);
          return view;
        };
        const current = { key, value: read() };
        entry = current;
        entries.set(job.date, current);
      }
      return structuredClone(await entry.value);
    } catch (error) {
      entries.delete(job.date);
      throw error;
    }
  };
}
