import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorText, HttpError, redact } from "@eval/contracts";
import { json, listen } from "@eval/runtime/http";
import type { AutomationState } from "@eval/automations";
import { completedComparisons, type Checkpoint } from "@eval/workflows/comparison";
import type { AutomationConfig } from "./automation-config.js";
import { checkpoint, summarize } from "./automation-evaluation.js";

const HOUR = 60 * 60 * 1000;
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");

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
      if (task.status !== "succeeded" || !task.receipt?.exported || !Number.isFinite(task.receipt.acceptedAt)) continue;
      const counts = bucket(task.receipt.acceptedAt).stages;
      counts[task.stage] = (counts[task.stage] ?? 0) + 1;
    }
    for (const at of completedComparisons(run).values()) bucket(at).completed++;
  }
  return [...hours.values()].sort((a, b) => b.start - a.start);
}

export async function automationSnapshot(config: AutomationConfig, output: string, state: AutomationState) {
  const snapshot = structuredClone(state);
  const jobs = [];
  for (const job of Object.values(snapshot.jobs).sort((a, b) => b.date.localeCompare(a.date))) {
    const runs: Checkpoint[] = [], errors: string[] = [];
    for (const id of job.runIds) {
      try {
        const run = await checkpoint(output, id);
        if (run) runs.push(run);
        else if (job.evaluation === "completed") errors.push(`${id}: 评测状态文件缺失`);
      } catch (error) { errors.push(`${id}: ${errorText(error)}`); }
    }
    jobs.push({ ...job, summary: runs.length ? summarize(runs) : job.summary,
      hours: completionTimeline(runs), monitorError: errors.join("\n") || undefined });
  }
  return {
    id: snapshot.id, status: snapshot.status, startedAt: snapshot.startedAt, updatedAt: snapshot.updatedAt,
    lastPollAt: snapshot.lastPollAt, pollError: snapshot.pollError, reportError: snapshot.reportError,
    sampledAt: Date.now(), sourceUrl: config.sourceUrl, logFile: config.publication.logFile,
    mongoCollection: config.publication.mongoCollection, publication: snapshot.publication, publicationHistory: snapshot.publicationHistory, jobs,
  };
}

/** Read-only monitor; the automation command owns the scheduler and both lifetimes. */
export async function startAutomationDashboard(options: {
  config: AutomationConfig; output: string; state: () => AutomationState; port: number;
}) {
  let sampledAt = 0, snapshot: ReturnType<typeof automationSnapshot> | undefined;
  const assets: Record<string, [string, string]> = {
    "/": ["automations.html", "text/html"],
    "/dashboard.css": ["dashboard.css", "text/css"],
    "/automations.css": ["automations.css", "text/css"],
    "/automations.js": ["automations.js", "text/javascript"],
  };
  return listen(async (req, res, url) => {
    res.setHeader("cache-control", "no-store");
    if (req.method !== "GET") throw new HttpError(405, "Read-only dashboard");
    if (url.pathname === "/api/status") {
      if (!snapshot || Date.now() - sampledAt >= 5000) {
        sampledAt = Date.now();
        snapshot = automationSnapshot(options.config, options.output, options.state());
      }
      try {
        const result = await snapshot;
        const secrets = [process.env[options.config.publication.mongoUriEnv] ?? "", process.env.EVAL_API_KEY ?? ""];
        json(res, JSON.parse(redact(JSON.stringify(result), secrets)));
      } catch (error) { snapshot = undefined; throw error; }
      return;
    }
    const asset = assets[url.pathname];
    if (!asset) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": asset[1] + "; charset=utf-8" });
    res.end(await readFile(path.join(ASSETS, asset[0]), "utf8"));
  }, options.port);
}
