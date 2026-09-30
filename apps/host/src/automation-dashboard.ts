import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorText, HttpError, redact } from "@eval/contracts";
import { json, listen } from "@eval/runtime/http";
import type { AutomationState } from "@eval/automations";
import { hasLiveRunOwner } from "@eval/data";
import { publishableComparisons, type Checkpoint } from "@eval/workflows/comparison";
import type { AutomationConfig } from "./automation-config.js";
import { checkpoint, summarize, isAutomationTask } from "./automation-evaluation.js";
import { automationErrors } from "./automation-errors.js";
import { ROOT } from "./paths.js";

const HOUR = 60 * 60 * 1000;
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
export interface AutomationMonitorSettings { evaluatorVersion: string; concurrency: number }

function cacheUsage(runs: Checkpoint[]) {
  let readTokens = 0, inputTokens = 0;
  for (const run of runs) {
    readTokens += run.usage.cacheRead;
    inputTokens += run.usage.input + run.usage.cacheRead + run.usage.cacheWrite;
  }
  return { readTokens, inputTokens, hitRate: inputTokens ? readTokens / inputTokens : null };
}

/** Counts attempts and distinct cases separately; a case can have several active stages. */
function liveExecution(runs: Checkpoint[]) {
  const cases = new Set<string>(), stages: Record<string, number> = { attribution: 0, comparison: 0, rewrite: 0 };
  const retryingStages: Record<string, number> = { attribution: 0, comparison: 0, rewrite: 0 };
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
  return { runningTasks: Object.values(stages).reduce((a, b) => a + b, 0), runningCases: cases.size,
    stages, retryingStages, readyTasks, waitingDependencies, retryingTasks, nextRetryAt };
}

/** Derived from persisted Host receipts, so refreshes and restarts never increment counters. */
export function completionTimeline(runs: Checkpoint[], requireItems = true) {
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
    for (const at of publishableComparisons(run, requireItems).values()) bucket(at).completed++;
  }
  return [...hours.values()].sort((a, b) => b.start - a.start);
}

export async function automationSnapshot(config: AutomationConfig, output: string, state: AutomationState, settings: AutomationMonitorSettings) {
  const snapshot = structuredClone(state);
  const jobs = [], activeRuns: Checkpoint[] = [], measuredRuns = new Map<string, Checkpoint>();
  for (const job of Object.values(snapshot.jobs).sort((a, b) => b.date.localeCompare(a.date))) {
    const runs: Checkpoint[] = [], liveRuns: Checkpoint[] = [], errors: string[] = [];
    for (const id of job.runIds) {
      try {
        const run = await checkpoint(output, id);
        if (run) {
          runs.push(run);
          measuredRuns.set(run.runId, run);
          if (snapshot.status === "running" && job.evaluation === "evaluating" && run.status === "running" &&
              await hasLiveRunOwner(path.join(output, id))) liveRuns.push(run);
        }
        else if (job.evaluation === "completed") errors.push(`${id}: 评测状态文件缺失`);
      } catch (error) { errors.push(`${id}: ${errorText(error)}`); }
    }
    jobs.push({ ...job, summary: runs.length ? summarize(runs, !job.adopted) : job.summary,
      cache: cacheUsage(runs), execution: liveExecution(liveRuns), hours: completionTimeline(runs, !job.adopted), monitorError: errors.join("\n") || undefined });
    activeRuns.push(...liveRuns);
  }
  return {
    id: snapshot.id, status: snapshot.status, startedAt: snapshot.startedAt, updatedAt: snapshot.updatedAt,
    lastPollAt: snapshot.lastPollAt, pollError: snapshot.pollError, reportError: snapshot.reportError,
    sampledAt: Date.now(), sourceUrl: config.sourceUrl, logFile: config.publication.logFile,
    cache: cacheUsage([...measuredRuns.values()]),
    execution: { ...settings, ...liveExecution(activeRuns),
      ...(activeRuns.length ? { evaluatorVersion: activeRuns[0].evaluatorVersion,
        concurrency: activeRuns.reduce((total, run) => total + (run.concurrency ?? settings.concurrency), 0) } : {}) },
    mongoCollection: config.publication.mongoCollection, publication: snapshot.publication, publicationHistory: snapshot.publicationHistory, jobs,
  };
}

/** Read-only monitor; the automation command owns the scheduler and both lifetimes. */
export async function startAutomationDashboard(options: {
  config: AutomationConfig; output: string; state: () => AutomationState; port: number; settings: AutomationMonitorSettings;
  runtimeLogFile?: string;
}) {
  let sampledAt = 0, snapshot: ReturnType<typeof automationSnapshot> | undefined;
  const assets: Record<string, [string, string]> = {
    "/": ["automations.html", "text/html"],
    "/dashboard.css": ["dashboard.css", "text/css"],
    "/automations.css": ["automations.css", "text/css"],
    "/automations.js": ["automations.js", "text/javascript"],
    "/errors": ["automation-errors.html", "text/html"],
    "/automation-errors.js": ["automation-errors.js", "text/javascript"],
  };
  const errors = automationErrors(options.runtimeLogFile ?? path.join(ROOT, "log/runtime.log"), options.state);
  return listen(async (req, res, url) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET") throw new HttpError(405, "Read-only dashboard");
    const send = (value: unknown) => json(res, JSON.parse(redact(JSON.stringify(value),
      [process.env[options.config.publication.mongoUriEnv] ?? "", process.env.EVAL_API_KEY ?? ""])));
    if (url.pathname === "/api/errors") return send(await errors(url.searchParams));
    if (url.pathname === "/api/status") {
      if (!snapshot || Date.now() - sampledAt >= 1000) {
        sampledAt = Date.now();
        snapshot = automationSnapshot(options.config, options.output, options.state(), options.settings);
      }
      try {
        const result = await snapshot;
        send(result);
      } catch (error) { snapshot = undefined; throw error; }
      return;
    }
    const asset = assets[url.pathname];
    if (!asset) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": asset[1] + "; charset=utf-8" });
    res.end(await readFile(path.join(ASSETS, asset[0]), "utf8"));
  }, options.port);
}
