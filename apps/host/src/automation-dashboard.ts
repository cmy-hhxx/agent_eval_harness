import { configurationSecrets } from "./settings.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { errorText, HttpError, redact } from "@eval/contracts";
import { body, json, listen } from "@eval/runtime/http";
import type { AutomationState } from "@eval/automations";
import { hasLiveRunOwner } from "@eval/data";
import type { AutomationConfig } from "./automation-config.js";
import { cacheUsage, liveExecution, createAutomationMonitor } from "./automation-monitor.js";
import { automationErrors } from "./automation-errors.js";
import { ROOT } from "./paths.js";
import { automationMongoTarget } from "./automation-sources.js";
import { validLlmConcurrency, type createAutomationLlm } from "./automation-llm.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
export interface AutomationMonitorSettings { evaluatorVersion: string; concurrency: number }
export interface AutomationDashboardSource {
  config: AutomationConfig; output: string; state: () => AutomationState; settings: AutomationMonitorSettings;
  monitor?: ReturnType<typeof createAutomationMonitor>;
}
const sourceNames: Record<string, string> = {
  "remote-evaluation": "普通四路",
  "remote-six-model-evaluation": "GPT 六路",
  "remote-post-training-evaluation": "后训练三路",
  "prediction-evaluation": "预测类自动评测",
};

export async function automationSnapshot(config: AutomationConfig, output: string, state: AutomationState, settings: AutomationMonitorSettings,
  monitor = createAutomationMonitor(output, config.dailyComparisonLimitPerTier),
) {
  const snapshot = structuredClone(state);
  const mongoTarget = automationMongoTarget(config);
  type Observation = Awaited<ReturnType<typeof monitor>>;
  const jobs = [], activeRuns: Observation["runs"] = [], measuredRuns = new Map<string, Observation["runs"][number]>();
  for (const job of Object.values(snapshot.jobs).sort((a, b) => b.date.localeCompare(a.date))) {
    if (job.mongo?.target !== mongoTarget) delete job.mongo;
    job.mongoHistory = job.mongoHistory?.filter(receipt => receipt.target === mongoTarget);
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
    sampledAt: Date.now(), sourceUrl: config.sourceUrl, logFile: config.publication.logFile, publishStatisticsLog: config.publishStatisticsLog,
    cache: cacheUsage([...measuredRuns.values()]),
    execution: { ...settings, ...liveExecution(activeRuns),
      ...(activeRuns.length ? { evaluatorVersion: activeRuns[0].evaluatorVersion,
        concurrency: activeRuns.reduce((total, run) => total + (run.concurrency ?? settings.concurrency), 0) } : {}) },
    mongoCollection: config.publication.mongoCollection, publication: snapshot.publication, publicationHistory: snapshot.publicationHistory, jobs,
  };
}

/** The command owns scheduling; this loopback UI allocates only model request capacity. */
export async function startAutomationDashboard(options: {
  sources: () => readonly AutomationDashboardSource[]; port: number;
  llm: Pick<ReturnType<typeof createAutomationLlm>, "snapshot" | "setConcurrency">;
  runtimeLogFile?: string;
}) {
  const observations = new Map<AutomationDashboardSource, {
    sampledAt: number; snapshot?: ReturnType<typeof automationSnapshot>;
    monitor: ReturnType<typeof createAutomationMonitor>; errors: ReturnType<typeof automationErrors>;
  }>();
  const assets: Record<string, [string, string]> = {
    "/": ["automations.html", "text/html"],
    "/dashboard.css": ["dashboard.css", "text/css"],
    "/automations.css": ["automations.css", "text/css"],
    "/automations.js": ["automations.js", "text/javascript"],
    "/errors": ["automation-errors.html", "text/html"],
    "/automation-errors.js": ["automation-errors.js", "text/javascript"],
  };
  return listen(async (req, res, url) => {
    res.setHeader("cache-control", "no-store");
    const sources = options.sources();
    const send = (value: unknown) => json(res, JSON.parse(redact(JSON.stringify(value),
      [...sources.map(source => process.env[source.config.publication.mongoUriEnv] ?? ""), ...configurationSecrets()])));
    if (req.method === "POST" && url.pathname === "/api/llm-concurrency") {
      const host = (req.headers.host ?? "").toLowerCase();
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || req.headers.origin !== `http://${host}`)
        throw new HttpError(403, "Request origin does not match the dashboard");
      const value = await body(req, 1024);
      if (!value || typeof value !== "object" || Array.isArray(value) || !("sourceId" in value) ||
          typeof value.sourceId !== "string" || !("concurrency" in value) || !validLlmConcurrency(value.concurrency) ||
          Object.keys(value).length !== 2)
        throw new HttpError(400, "Expected sourceId and non-negative integer concurrency");
      if (!sources.length) throw new HttpError(503, "自动化来源正在初始化");
      if (!sources.some(source => source.config.id === value.sourceId))
        throw new HttpError(404, "Unknown automation source");
      await options.llm.setConcurrency(value.sourceId, value.concurrency);
      return send(options.llm.snapshot());
    }
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    if (url.pathname === "/api/status" || url.pathname === "/api/errors") {
      const id = url.searchParams.get("source");
      const source = id ? sources.find(source => source.config.id === id) : sources[0];
      if (!source) throw new HttpError(sources.length ? 404 : 503, sources.length ? "Unknown automation source" : "自动化来源正在初始化");
      const { config, output, state, settings } = source;
      const sourceName = sourceNames[config.id] ?? config.id;
      let observation = observations.get(source);
      if (!observation) {
        observation = { sampledAt: 0, monitor: source.monitor ?? createAutomationMonitor(output, config.dailyComparisonLimitPerTier),
          errors: automationErrors(options.runtimeLogFile ?? path.join(ROOT, "log/runtime.log"), state) };
        observations.set(source, observation);
      }
      if (url.pathname === "/api/errors")
        return send({ ...await observation.errors(url.searchParams), sourceId: config.id, sourceName });
      if (!observation.snapshot || Date.now() - observation.sampledAt >= 1000) {
        observation.sampledAt = Date.now();
        observation.snapshot = automationSnapshot(config, output, state(), settings, observation.monitor);
      }
      const snapshot = observation.snapshot;
      try {
        const result = await snapshot;
        send({ ...result, sourceName, llm: options.llm.snapshot(), sources: sources.map(source => {
          const current = source.state();
          return { id: source.config.id, name: sourceNames[source.config.id] ?? source.config.id,
            status: current.status, dateCount: Object.keys(current.jobs).length };
        }) });
      } catch (error) { if (observation.snapshot === snapshot) observation.snapshot = undefined; throw error; }
      return;
    }
    const asset = assets[url.pathname];
    if (!asset) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": asset[1] + "; charset=utf-8" });
    res.end(await readFile(path.join(ASSETS, asset[0]), "utf8"));
  }, options.port);
}
