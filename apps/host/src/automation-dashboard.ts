import { configurationSecrets } from "./settings.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorText, HttpError, redact } from "@eval/contracts";
import { json, listen } from "@eval/runtime/http";
import type { AutomationState } from "@eval/automations";
import { hasLiveRunOwner } from "@eval/data";
import type { AutomationConfig } from "./automation-config.js";
import { cacheUsage, liveExecution, createAutomationMonitor } from "./automation-monitor.js";
import { automationErrors } from "./automation-errors.js";
import { ROOT } from "./paths.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
export interface AutomationMonitorSettings { evaluatorVersion: string; concurrency: number }

export async function automationSnapshot(config: AutomationConfig, output: string, state: AutomationState, settings: AutomationMonitorSettings,
  monitor = createAutomationMonitor(output, config.dailyComparisonLimitPerTier),
) {
  const snapshot = structuredClone(state);
  type Observation = Awaited<ReturnType<typeof monitor>>;
  const jobs = [], activeRuns: Observation["runs"] = [], measuredRuns = new Map<string, Observation["runs"][number]>();
  for (const job of Object.values(snapshot.jobs).sort((a, b) => b.date.localeCompare(a.date))) {
    let view: Observation | undefined;
    const liveRuns: Observation["runs"] = [], errors: string[] = [];
    try {
      view = await monitor(job);
      for (const run of view.runs) {
        measuredRuns.set(run.runId, run);
        if (snapshot.status === "running" && job.evaluation === "evaluating" && run.status === "running" &&
            await hasLiveRunOwner(path.join(output, run.runId))) liveRuns.push(run);
      }
      if (job.evaluation === "completed") for (const id of job.runIds)
        if (!view.runs.some(run => run.runId === id)) errors.push(`${id}: 评测状态文件缺失`);
    } catch (error) { errors.push(errorText(error)); }
    jobs.push({ ...job, summary: view?.summary ?? job.summary,
      cache: cacheUsage(view?.runs ?? []), execution: liveExecution(liveRuns), hours: view?.hours ?? [], monitorError: errors.join("\n") || undefined });
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
  monitor?: ReturnType<typeof createAutomationMonitor>;
}) {
  let sampledAt = 0, snapshot: ReturnType<typeof automationSnapshot> | undefined;
  const monitor = options.monitor ?? createAutomationMonitor(options.output, options.config.dailyComparisonLimitPerTier);
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
      [process.env[options.config.publication.mongoUriEnv] ?? "", ...configurationSecrets()])));
    if (url.pathname === "/api/errors") return send(await errors(url.searchParams));
    if (url.pathname === "/api/status") {
      if (!snapshot || Date.now() - sampledAt >= 1000) {
        sampledAt = Date.now();
        snapshot = automationSnapshot(options.config, options.output, options.state(), options.settings, monitor);
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
