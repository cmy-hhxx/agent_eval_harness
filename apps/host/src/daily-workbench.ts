import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, errorText, redact } from "@eval/contracts";
import { body, json } from "@eval/runtime/http";
import { configurationSecrets } from "./settings.js";
import { automationSnapshot, type AutomationDashboardSource, type AutomationUnavailableSource } from "./automation-dashboard.js";
import type { createAutomationControl } from "./automation-control.js";
import type { automationLlm } from "./automation-llm.js";
import { dailySettingsView, saveDailySettings } from "./daily-settings.js";
import { dataRequest, sourceCatalog, stopSourceCleaning, type CatalogPage } from "./daily-ingestion.js";
import { discoverDashboardModels } from "./dashboard-models.js";
import { dailyPackageReport } from "./daily-coverage.js";
import { combineEvaluationAnalytics } from "./daily-evaluation-analytics.js";

export function dailyWorkbench(options: {
  sources: () => readonly AutomationDashboardSource[];
  unavailable?: () => readonly AutomationUnavailableSource[];
  control: ReturnType<typeof createAutomationControl>;
  llm: Awaited<ReturnType<typeof automationLlm>>;
}) {
  const activeSettings = new Map<string, unknown>();
  const wencai = () => options.sources().find(source => new URL(source.config.sourceUrl).pathname === "/data/wencai");
  const sourceId = (id: string) => id === "wencai" ? wencai()?.config.id : undefined;
  const packages = async (_id: string, page = 1, pageSize = 50) => {
    const source = wencai();
    if (!source) throw new HttpError(404, "日常来源未登记");
    const sourceUrl = source.config.sourceUrl;
    const data = await sourceCatalog({ sourceUrl }, page, pageSize);
    const task = data.tasks.find(task => task.dataset === new URL(sourceUrl).pathname);
    return { items: data.batches.map(item => ({ ...item, name: item.name, accepted: (item.summary as any)?.accepted ?? 0,
      excluded: (item.summary as any)?.excluded ?? 0 })), total: data.total, page: data.page, pageSize: data.page_size, archiveDirectory: task?.archive_dir };
  };
  async function view(id: string, pageSize = 50): Promise<Record<string, any>> {
    const runtimeId = sourceId(id);
    if (!runtimeId) throw new HttpError(404, "日常来源未登记");
    const allocation = options.llm.snapshot().sources.find(source => source.sourceId === runtimeId)!;
    let result: Record<string, any>;
    {
      const source = wencai()!;
      const snapshot = await automationSnapshot(source.config, source.output, source.state(), source.settings, source.monitor);
      const stages: Record<string, Record<string, number>> = {};
      for (const job of snapshot.jobs) for (const [stage, counts] of Object.entries(job.summary?.stages ?? {}))
        for (const [key, count] of Object.entries(counts)) (stages[stage] ??= {})[key] = (stages[stage][key] ?? 0) + count;
      const deliveries = snapshot.jobs.map(job => job.mongo).filter(item => item !== undefined);
      const coverage = snapshot.jobs.every(job => job.coverage && !job.monitorError)
        ? combineEvaluationAnalytics("comparisons", snapshot.jobs.map(job => job.coverage!)) : undefined;
      const delivered = snapshot.jobs.every(job => job.mongo?.status === "completed" && job.mongo.synced &&
        job.mongo.synced.inputsUpdatedAt === (job.inputsUpdatedAt ?? 0) &&
        job.mongo.synced.comparisons === (job.summary?.readyComparisons ?? 0));
      result = { id, name: "问财日常四路", workflow: "comparison", outputDirectory: source.output,
        archiveDirectory: path.join("/mnt/fin_bench/eval_data", "0_wencai/1_7z_data/A_AA_comparision_data"),
        settings: await dailySettingsView(source.config), stages, comparisonCounts: coverage?.totals, error: snapshot.pollError,
        runs: snapshot.jobs.flatMap(job => job.runIds.map(run_id => ({ run_id, date: job.date, status: job.evaluation,
          completed: Object.values(job.summary?.stages ?? {}).reduce((n, stage) => n + stage.completed, 0),
          total: Object.values(job.summary?.stages ?? {}).reduce((n, stage) => n + stage.total, 0), output_dir: path.join(source.output, run_id) }))),
        mongo: { status: !snapshot.jobs.length ? "idle" : deliveries.some(item => item.status === "retry") ? "retry" : delivered ? "completed" : "pending",
          inputs: deliveries.reduce((n, item) => n + (item.counts?.inputs ?? 0), 0), outputs: deliveries.reduce((n, item) => n + (item.counts?.comparisons ?? 0), 0),
          error: deliveries.map(item => item.error).filter(Boolean).join("\n") } };
    }
    try { result.packages = await packages(id, 1, pageSize); result.archiveDirectory = result.packages.archiveDirectory ?? result.archiveDirectory; }
    catch (error) { result.packageError = errorText(error); result.error = [result.error, result.packageError].filter(Boolean).join("\n"); result.packages = { items: [], total: 0, page: 1, pageSize: 50 }; }
    let modelCatalog: unknown[] = [];
    try { modelCatalog = await discoverDashboardModels(); } catch (error) { result.modelCatalogError = errorText(error); }
    const control = options.control.snapshot(runtimeId);
    return { ...result, id: "wencai", status: control.status, error: control.error ?? result.error, concurrency: allocation.concurrency,
      activeRequests: allocation.active, waitingRequests: allocation.waiting, activeSettings: activeSettings.get(id), modelCatalog };
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/daily" && !url.pathname.startsWith("/api/daily/")) return false;
    const send = (value: unknown) => json(res, JSON.parse(redact(JSON.stringify(value),
      [...configurationSecrets(), ...options.sources().map(source => process.env[source.config.publication.mongoUriEnv] ?? "")])));
    if (req.method === "POST") {
      const host = req.headers.host;
      if (!host || ![`http://${host}`, `https://${host}`].includes(req.headers.origin ?? "")) throw new HttpError(403, "Request origin does not match the dashboard");
    }
    if (req.method === "GET" && url.pathname === "/api/daily") {
      const pageSize = Number(url.searchParams.get("page_size") ?? 50);
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "批次分页参数无效");
      const sources = await Promise.all([...(wencai() ? ["wencai"] : [])].map(async id => {
        try { return await view(id, pageSize); }
        catch (error) {
          const runtimeId = sourceId(id)!;
          const allocation = options.llm.snapshot().sources.find(source => source.sourceId === runtimeId)!;
          return { id, name: "问财日常四路", ...options.control.snapshot(runtimeId),
            error: errorText(error), concurrency: allocation.concurrency, activeRequests: allocation.active, waitingRequests: allocation.waiting,
            settings: {}, stages: {}, runs: [], packages: { items: [], total: 0, page: 1, pageSize: 50 }, readError: true };
        }
      }));
      sources.push(...(options.unavailable?.() ?? []).map(source => {
        const allocation = options.llm.snapshot().sources.find(item => item.sourceId === source.id);
        return { id: source.id, name: source.name, status: "failed", error: source.error, readError: true,
          concurrency: allocation?.concurrency ?? 0, activeRequests: allocation?.active ?? 0, waitingRequests: allocation?.waiting ?? 0,
          settings: {}, stages: {}, runs: [], packages: { items: [], total: 0, page: 1, pageSize: 50 } };
      }));
      const llm = options.llm.snapshot();
      const requests = llm.active.map(call => ({ ...call, sourceId: call.sourceId === wencai()?.config.id ? "wencai" : call.sourceId }));
      send({ sampledAt: Date.now(), sources, requests, waitingRequests: llm.waiting }); return true;
    }
    const [, , , id, action, ...parts] = url.pathname.split("/");
    const runtimeId = sourceId(id);
    if (!runtimeId) throw new HttpError(404, "日常来源未登记");
    if (req.method === "GET" && action === "analytics" && !parts.length) {
      const source = wencai()!;
      const config = { sourceUrl: source.config.sourceUrl };
      const intake = async () => {
        const catalog = await dataRequest(config, "/data/workbench/catalog?page_size=1") as CatalogPage;
        const task = catalog.tasks.find(task => task.dataset === new URL(config.sourceUrl).pathname);
        if (!task) throw new HttpError(409, "日常收包任务尚未登记");
        return dataRequest(config, `/data/workbench/analytics?task_id=${encodeURIComponent(task.id)}`);
      };
      const evaluation = async () => {
        const snapshot = await automationSnapshot(source!.config, source!.output, source!.state(), source!.settings, source!.monitor);
        const error = snapshot.jobs.find(job => job.monitorError)?.monitorError;
        if (error) throw new HttpError(409, error);
        if (snapshot.jobs.some(job => !job.coverage)) throw new HttpError(409, "日常运行覆盖统计不可用");
        return combineEvaluationAnalytics("comparisons", snapshot.jobs.map(job => job.coverage!));
      };
      const [inputs, coverage] = await Promise.all([intake(), evaluation()]);
      send({ source: id, sampledAt: Date.now(), intake: inputs, evaluation: coverage }); return true;
    }
    if (req.method === "GET" && action === "packages") {
      if (parts.length === 2 && parts[1] === "report") {
        const source = wencai();
        send(await dailyPackageReport({ source: "wencai", sourceUrl: source!.config.sourceUrl,
          output: source!.output, automationState: source!.state() }, parts[0], url.searchParams));
      } else if (!parts.length) send(await packages(id, Number(url.searchParams.get("page") ?? 1), Number(url.searchParams.get("page_size") ?? 50)));
      else throw new HttpError(404, "Not found");
      return true;
    }
    if (req.method === "POST" && action === "control") {
      const value = await body(req, 1024) as { action: "run" | "pause" | "resume" | "stop" };
      if (!value || Object.keys(value).length !== 1 || !["run", "pause", "resume", "stop"].includes(value.action)) throw new HttpError(400, "操作无效");
      if (value.action === "run" || value.action === "resume") activeSettings.set(id, (await view(id)).settings);
      const state = options.control[value.action](runtimeId);
      if (id === "wencai" && (value.action === "pause" || value.action === "stop")) await stopSourceCleaning(wencai()!.config, value.action === "stop");
      send(state); return true;
    }
    if (req.method === "POST" && action === "concurrency") {
      const value = await body(req, 1024) as { concurrency: number };
      if (!value || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.concurrency) || value.concurrency < 1) throw new HttpError(400, "并发必须是正整数");
      await options.llm.setConcurrency(runtimeId, value.concurrency);
      send(options.llm.snapshot()); return true;
    }
    if (req.method === "POST" && action === "settings") {
      const value = await body(req, 64 * 1024);
      send(await saveDailySettings(wencai()!.config, value)); return true;
    }
    throw new HttpError(404, "Not found");
  };
}
