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
import { statisticsSource, type StatisticsDeliveryStore } from "./statistics-delivery.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
export interface AutomationMonitorSettings { evaluatorVersion: string; concurrency: number }
export interface AutomationDashboardSource {
  name: string; config: AutomationConfig; output: string; state: () => AutomationState; settings: AutomationMonitorSettings;
  monitor?: ReturnType<typeof createAutomationMonitor>;
}

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
    sampledAt: Date.now(), sourceUrl: config.sourceUrl, logFile: config.publication.logFile, publishMongo: config.publishMongo, publishStatisticsLog: config.publishStatisticsLog,
    cache: cacheUsage([...measuredRuns.values()]),
    execution: { ...settings, ...liveExecution(activeRuns),
      ...(activeRuns.length ? { evaluatorVersion: activeRuns[0].evaluatorVersion,
        concurrency: activeRuns.reduce((total, run) => total + (run.concurrency ?? settings.concurrency), 0) } : {}) },
    mongoCollection: config.publication.mongoCollection, statistics: snapshot.statistics, jobs,
  };
}

/** The command owns scheduling; this loopback UI allocates only model request capacity. */
export async function startAutomationDashboard(options: {
  sources: () => readonly AutomationDashboardSource[]; port: number;
  llm: Pick<ReturnType<typeof createAutomationLlm>, "snapshot" | "setConcurrency">;
  statistics?: StatisticsDeliveryStore;
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
      if (!host || ![`http://${host}`, `https://${host}`].includes(req.headers.origin ?? ""))
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
    const statisticsSources = sources.filter(source => source.config.publishStatisticsLog).map(source => statisticsSource(source.config));
    const relayParts = url.pathname.split("/").filter(Boolean);
    if (relayParts[0] === "api" && relayParts[1] === "relay" && relayParts[2] === "records") {
      if (!options.statistics) throw new HttpError(503, "Statistics relay store is unavailable");
      const all = await options.statistics.list(statisticsSources);
      if (req.method === "GET" && relayParts.length === 3)
        return send(all.filter(item => item.status === "pending"));
      throw new HttpError(404, "Not found");
    }
    if (req.method === "POST" && relayParts[0] === "api" && relayParts[1] === "relay" && relayParts[2] === "records" &&
        relayParts[4] === "claim" && relayParts.length === 5 && options.statistics) {
      const traceId = decodeURIComponent(relayParts[3]!);
      const entry = await options.statistics.claim(traceId);
      const listed = await options.statistics.list(statisticsSources);
      const record = listed.find(item => item.traceId === traceId)?.record;
      if (!record) throw new HttpError(409, "Statistics delivery record is unavailable");
      return send({ ...entry, record });
    }
    if (req.method === "POST" && relayParts[0] === "api" && relayParts[1] === "relay" && relayParts[2] === "records" &&
        relayParts[4] === "receipt" && relayParts.length === 5 && options.statistics) {
      const traceId = decodeURIComponent(relayParts[3]!);
      const raw = await body(req, 16 * 1024);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).status !== "string")
        throw new HttpError(400, "Invalid statistics receipt");
      const value = raw as Record<string, unknown>;
      if (value.status === "uploaded" && typeof value.requestId === "string" && value.requestId.trim() && Object.keys(value).length === 2)
        return send(await options.statistics.receipt(traceId, { status: "uploaded", requestId: value.requestId.trim() }));
      if ((value.status === "pending" || value.status === "uncertain") && typeof value.error === "string" && value.error.trim() && Object.keys(value).length === 2)
        return send(await options.statistics.receipt(traceId, { status: value.status, error: value.error.trim() }));
      throw new HttpError(400, "Invalid statistics receipt");
    }
    if (req.method === "POST" && relayParts[0] === "api" && relayParts[1] === "relay" && relayParts[2] === "records" &&
        relayParts[4] === "resolve" && relayParts.length === 5 && options.statistics) {
      const traceId = decodeURIComponent(relayParts[3]!);
      const raw = await body(req, 16 * 1024);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).outcome !== "string")
        throw new HttpError(400, "Invalid statistics resolution");
      const value = raw as Record<string, unknown>;
      if (value.outcome === "written" && typeof value.requestId === "string" && value.requestId.trim() && Object.keys(value).length === 2)
        return send(await options.statistics.resolve(traceId, { outcome: "written", requestId: value.requestId.trim() }));
      if (value.outcome === "retry" && Object.keys(value).length === 1)
        return send(await options.statistics.resolve(traceId, { outcome: "retry" }));
      throw new HttpError(400, "Invalid statistics resolution");
    }
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    if (url.pathname === "/api/health") return json(res, { ok: true, sources: sources.length });
    if (url.pathname === "/api/status" || url.pathname === "/api/errors") {
      const id = url.searchParams.get("source");
      const source = id ? sources.find(source => source.config.id === id) : sources[0];
      if (!source) throw new HttpError(sources.length ? 404 : 503, sources.length ? "Unknown automation source" : "自动化来源正在初始化");
      const { config, output, state, settings } = source;
      const sourceName = source.name;
      let observation = observations.get(source);
      if (!observation) {
        observation = { sampledAt: 0, monitor: source.monitor ?? createAutomationMonitor(output, config.dailyComparisonLimitPerTier),
          errors: automationErrors(options.runtimeLogFile ?? path.resolve(process.env.EVAL_LOG_DIR || path.join(ROOT, "log"), "runtime.log"), state) };
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
        send({ ...result, sourceName, llm: options.llm.snapshot(),
          statisticsDeliveries: options.statistics ? await options.statistics.list(statisticsSources, false) : [],
          sources: sources.map(source => {
          const current = source.state();
          return { id: source.config.id, name: source.name,
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
