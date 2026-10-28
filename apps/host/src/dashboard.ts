import type { ServerResponse } from "node:http";
import { readSettings, type ApplicationSettings } from "./settings.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { body, json, listen } from "@eval/runtime/http";
import { errorText, HttpError, safeId } from "@eval/contracts";
import { deleteRun, exists, localFiles, listRunArtifacts, locateRun, runLock, readJson, RunDeletionError } from "@eval/data";
import { editableDashboardSettings, loadComparisonEvaluation, loadConfig, createModelResolver, readConfigSources } from "./config.js";
import {
  clearUnavailableDashboardModels,
  discoverDashboardModels,
  type DashboardModel,
  type DashboardModelLoader,
  type DashboardModelFailure,
} from "./dashboard-models.js";
import { readLock, previewRun, startRun } from "./dashboard-launch.js";
import { createDashboardInputs } from "./dashboard-inputs.js";
import { DashboardBatches, type BatchRun } from "./dashboard-batches.js";
import { DashboardAnalysis } from "./dashboard-analysis.js";
import { DashboardErrors } from "./dashboard-errors.js";
import { prepareFailedTasks, type ClusteringJobConfig } from "@eval/workflows/comparison";
import { ROOT } from "./paths.js";
import { listClusteringTasks, listConfiguredProblemLibrary, listRunCases, readCaseDetail, readConfiguredProblemClass, readRegisteredInput, readTaskResult } from "@eval/workflows/comparison";

interface DashboardOptions {
  configPaths: string[];
  port: number;
  /** Test seam; production discovery always uses the configured config.ini channels. */
  modelCatalog?: DashboardModelLoader;
  batchDirectory?: string;
  dataUrl?: string;
  /** Test seam; production journals always use the shared project log directory. */
  logs?: { directory: string; lockDirectory: string };
}

interface CheckpointTask {
  stage?: string;
  status?: string;
  failure?: { draft?: unknown; errors?: { category?: string }[] };
  receipt?: { incompleteDependencies?: string[] };
}

interface DashboardCheckpoint {
  format?: string;
  runId?: string;
  status?: string;
  engine?: { engine?: string };
  evaluatorVersion?: string;
  startedAt?: number;
  finishedAt?: number;
  concurrency?: number;
  tasks?: Record<string, CheckpointTask>;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, message);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelReadiness(source: Record<string, unknown>, configuration?: ApplicationSettings) {
  const profiles = isRecord(source.models) ? source.models : {};
  const bindings = Object.values(isRecord(source.bindings) ? source.bindings : {});
  if (!bindings.length) return { base_url_configured: false, api_key_configured: false };
  let baseUrl = true, apiKey = true;
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.profile !== "string") {
      baseUrl = apiKey = false;
      continue;
    }
    const profile = profiles[binding.profile];
    if (!isRecord(profile)) {
      baseUrl = apiKey = false;
      continue;
    }
    const channel = configuration?.channels[String(binding.channel ?? profile.channel)];
    if (!channel?.baseUrl) baseUrl = false;
    if (!channel || !configuration?.environment[channel.apiKeyEnv]) apiKey = false;
  }
  return { base_url_configured: baseUrl, api_key_configured: apiKey };
}

function fallbackProgress(checkpoint: DashboardCheckpoint) {
  const tasks = Object.values(checkpoint.tasks || {});
  const accepted = tasks.filter((task) => task.status === "succeeded").length;
  const partial = tasks.filter(task => task.status === "succeeded" && task.receipt?.incompleteDependencies?.length).length;
  const running = tasks.filter((task) => task.status === "running");
  const failures: Record<string, number> = {};
  for (const task of tasks)
    if (["failed", "timed_out"].includes(task.status || "")) {
      const category = task.failure?.errors?.[0]?.category || "interruption";
      failures[category] = (failures[category] || 0) + 1;
    }
  return {
    queued: tasks.filter((task) => task.status === "pending").length,
    running: running.length,
    accepted,
    complete: accepted - partial,
    partial,
    repairing: running.filter((task) => task.failure?.draft !== undefined).length,
    failures,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    concurrency: checkpoint.concurrency || 1,
    recent_completed_per_minute: 0,
    longest_without_progress: null,
    eta: null,
    eta_status: "insufficient_samples",
  };
}

async function inspectRun(outputDir: string, runId: string) {
  const run = path.join(outputDir, runId);
  const statsFile = locateRun(run).stats;
  const [lock, checkpoint, stats] = await Promise.all([
    readLock(run),
    readJson<DashboardCheckpoint>(locateRun(run).stateFile),
    readJson<Record<string, unknown>>(statsFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  if (checkpoint.format !== "evaluation-run" || checkpoint.runId !== runId || !checkpoint.tasks ||
      typeof checkpoint.evaluatorVersion !== "string" || !checkpoint.evaluatorVersion.trim())
    throw new Error("运行状态身份、任务索引或评测器版本无效");
  let progress = fallbackProgress(checkpoint);
  let live = false;
  if (lock?.url) {
    try {
      const response = await fetch(`${lock.url}/api/progress`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const current = await response.json() as typeof progress;
        if (Number.isInteger(current.running) && Number.isInteger(current.accepted) &&
            Number.isInteger(current.concurrency) && current.concurrency > 0) {
          progress = current;
          live = true;
        }
      }
    } catch { /* A saved snapshot remains useful while the Host is starting or disconnected. */ }
  }
  const savedStatus = checkpoint.status || "unknown";
  const stages: Record<string, Record<string, number>> = {};
  for (const task of Object.values(checkpoint.tasks || {})) {
    const counts = (stages[task.stage || "unknown"] ??= {});
    const status = task.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return {
    run_id: runId,
    status: lock ? "running" : savedStatus === "running" ? "interrupted" : savedStatus,
    engine: checkpoint.engine?.engine || "unknown",
    evaluator_version: checkpoint.evaluatorVersion,
    started_at: checkpoint.startedAt || 0,
    finished_at: checkpoint.finishedAt,
    concurrency: progress.concurrency,
    progress,
    live,
    stages,
    ...(stats?.problem_library ? { problem_library: stats.problem_library } : {}),
    ...(lock ? { process_id: lock.pid } : {}),
  };
}

async function allRuns(outputDir: string) {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], errors: [] };
    throw error;
  }
  const inspected = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(async (entry) => {
    try { return { run: await inspectRun(outputDir, entry.name) }; }
    catch (error) { return { error: { run_id: entry.name, message: errorText(error) } }; }
  }));
  const runs = inspected.flatMap((entry) => entry.run ? [entry.run] : []);
  return {
    runs: runs.sort((a, b) => b.started_at - a.started_at),
    errors: inspected.flatMap((entry) => entry.error ? [entry.error] : []),
  };
}

async function controlRun(outputDir: string, runId: string, action: "stop" | "concurrency", value?: number) {
  const lock = await readLock(path.join(outputDir, runId));
  if (!lock?.url || !lock.token) throw new HttpError(409, "运行尚未准备好控制接口");
  const response = await fetch(`${lock.url}/api/control/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-run-token": lock.token,
    },
    body: action === "concurrency" ? JSON.stringify({ concurrency: value }) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new HttpError(response.status, String((result as { error?: unknown }).error || response.statusText));
  return result;
}

async function runArtifacts(res: ServerResponse, directory: string, requested: string | null) {
  const files = await listRunArtifacts(directory);
  if (!requested) return {directory,files};
  if (!files.some(file=>file.name===requested)) throw new HttpError(404,"产物不存在");
  res.writeHead(200,{"content-type":"application/octet-stream","content-disposition":`attachment; filename="${path.basename(requested)}"`});
  res.end(await localFiles.read(path.join(directory,requested)));
  return undefined;
}

export async function startDashboard(options: DashboardOptions) {
  const source = await readConfigSources(options.configPaths);
  const output = source.output;
  if (!isRecord(output) || typeof output.path !== "string")
    throw new Error("Invalid output target in dashboard config");
  const outputDir = path.resolve(output.path);
  const logs = options.logs ?? { directory: path.resolve(process.env.EVAL_LOG_DIR || path.join(ROOT, "log")),
    lockDirectory: path.resolve(process.env.EVAL_LOG_LOCK_DIR || path.join(ROOT, ".runtime/log-writer")) };
  // A spawned child has not acquired its run lock yet, and may write its final error after releasing it.
  const changingRuns = new Map<string, number | undefined>();
  const reserveRun = (runId: string) => {
    if (changingRuns.has(runId)) {
      const pid = changingRuns.get(runId);
      if (pid === undefined) throw new HttpError(409, "运行正在启动或删除，请稍后重试");
      try { process.kill(pid, 0); throw new HttpError(409, "运行进程尚未退出，请停止运行后重试"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    changingRuns.set(runId, undefined);
  };
  const inputs = createDashboardInputs();
  const batches = new DashboardBatches(options.batchDirectory ?? process.env.EVAL_WORKBENCH_RUNS_DIR ?? path.join(ROOT, ".runtime/workbench-runs"),
    options.dataUrl ?? process.env.EVAL_WORKBENCH_DATA_URL ?? "http://127.0.0.1:8081");
  const errorReader = new DashboardErrors(logs.directory);
  const runOutput = async (id: string) => (await batches.get(id))?.outputDir ?? outputDir;
  let modelCatalogFailures: DashboardModelFailure[] = [];
  const loadModels = options.modelCatalog ?? (() => discoverDashboardModels(failures => { modelCatalogFailures = failures; }));
  let modelCatalogPromise: Promise<DashboardModel[]> | undefined;
  const readModels = async () => {
    modelCatalogPromise ??= loadModels().catch((error) => {
      modelCatalogPromise = undefined;
      throw error;
    });
    return modelCatalogPromise;
  };
  const analysis = new DashboardAnalysis(batches, options.configPaths, readModels);
  const batchOptions = (entry: BatchRun) => ({ configPaths: [...options.configPaths, batches.config(entry.runId)],
    outputDir: entry.outputDir, modelCatalog: readModels, plan: inputs.plan });
  const batchPayload = (entry: BatchRun) => ({ runId: entry.runId, settings: entry.settings });
  const batchSummary = async (entry: BatchRun) => {
    let state, stateError: string | undefined;
    try { state = await inspectRun(entry.outputDir, entry.runId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") stateError = errorText(error); }
    let status = entry.status;
    if (!state && status === "starting") {
      try { if (!entry.pid) throw new Error("no pid"); process.kill(entry.pid, 0); }
      catch { status = "interrupted"; }
    }
    return { ...state, run_id: entry.runId, started_at: state?.started_at ?? entry.createdAt,
      status: state?.status ?? status, launch_error: stateError ?? entry.error, task: entry.scope.task,
      batch_ids: entry.scope.batch_ids, output_dir: path.join(entry.outputDir, entry.runId), batch_run: true, archived_at: entry.archivedAt };
  };
  const server = await listen(async (req, res, url) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // No CSP / X-Frame-Options: local annotation overlays inject styles and need to embed the page.
    const host = (req.headers.host || "").toLowerCase();
    if (!host) throw new HttpError(403, "Host header is required");
    if (["POST", "DELETE"].includes(req.method || "") && ![`http://${host}`, `https://${host}`].includes(req.headers.origin ?? ""))
      throw new HttpError(403, "Request origin does not match the dashboard");
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/dashboard/config") {
      const current = await readConfigSources(options.configPaths);
      let modelCatalog: DashboardModel[] = [];
      let modelCatalogError = false;
      try { modelCatalog = await readModels(); }
      catch { modelCatalogError = true; }
      const configuration = await readSettings().catch(() => undefined);
      const settings = editableDashboardSettings(current);
      for (const binding of Object.values(settings.bindings))
        if (!binding.model) binding.model = configuration?.channels[String(binding.channel)]?.model ?? "";
      clearUnavailableDashboardModels(settings, modelCatalog);
      return json(res, {
        paths: options.configPaths,
        settings,
        model_catalog: modelCatalog,
        model_catalog_failures: modelCatalogFailures,
        ...(modelCatalogError ? { model_catalog_error: "无法读取 config.ini 渠道模型列表" } : {}),
        environment: modelReadiness(current, configuration),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/inputs")
      return json(res, await inputs.read(await loadComparisonEvaluation(options.configPaths)));
    if (req.method === "POST" && url.pathname === "/api/dashboard/batch-runs/preview") {
      const entry = await batches.prepare(record(await body(req, 64 * 1024), "Expected JSON object"));
      try {
        const preview = await previewRun(batchOptions(entry), batchPayload(entry));
        entry.status = "ready"; await batches.save(entry);
        const host = await loadConfig(batchOptions(entry).configPaths, undefined, entry.settings);
        const resolve = createModelResolver(host.models);
        const active = ["criteria", "attribution", ...(Number(preview.summary.comparison_tasks) ? ["comparison"] : []),
          ...(Number(preview.summary.rewrite_tasks) ? ["rewrite"] : [])];
        const evaluatorModels = Object.fromEntries(active.map(stage => { const model = resolve(stage); return [stage, model.model]; }));
        return json(res, { ...preview, evaluator_models: evaluatorModels, evaluator_version: host.evaluatorVersion, run_id: entry.runId, task: entry.scope.task, batch_ids: entry.scope.batch_ids,
          output_dir: path.join(entry.outputDir, entry.runId),
          models: entry.models });
      } catch (error) { entry.status = "preview_failed"; entry.error = errorText(error); await batches.save(entry); throw error; }
    }
    if (url.pathname === "/api/dashboard/analysis/scope" && req.method === "POST") {
      const {page = 1, status = "", ...selection} = record(await body(req,64 * 1024), "Expected scope");
      if (!Number.isSafeInteger(page) || Number(page)<1 || !["","available","included","reserved","unfinished","superseded"].includes(String(status))) throw new HttpError(400,"无效的分页或状态");
      const scope = await analysis.scope(selection), rows = scope.rows.filter(row=>!status || row.status===status);
      return json(res,{...scope,rows:rows.slice((Number(page)-1)*40,Number(page)*40),page,page_size:40,total:rows.length});
    }
    if (url.pathname === "/api/dashboard/analysis/preview" && req.method === "POST")
      return json(res, await analysis.preview(record(await body(req,64 * 1024), "Expected scope")));
    if (url.pathname === "/api/dashboard/analysis" && req.method === "GET") return json(res, { jobs: await analysis.list() });
    if (/^\/api\/dashboard\/analysis\/[^/]+\/(start|resume|sources|artifacts|errors|stop)$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), id = safeId(parts[4]!), action = parts[5];
      const job = await analysis.get(id); if (!job) throw new HttpError(404,"分析作业不存在");
      if (req.method === "POST" && ["start","resume"].includes(action!))
        return json(res, await analysis.launch(id,record(await body(req,64 * 1024),"Expected object")),202);
      if (req.method === "POST" && action === "stop") return json(res, await controlRun(job.output_dir,id,"stop"));
      if (req.method === "GET" && action === "errors") return json(res, await errorReader.read(path.join(job.output_dir,id),url.searchParams));
      if (req.method === "GET" && action === "sources") {
        const page=Number(url.searchParams.get("page") || 1);
        if (!Number.isSafeInteger(page) || page<1) throw new HttpError(400,"Invalid page");
        const selection=await readJson<ClusteringJobConfig["clusteringJob"]>(analysis.selectionFile(id));
        const sources=[...selection.sources.map(source=>({kind:"selected",source})),
          ...(selection.recall ?? []).map(ref=>({kind:"recalled",finding_id:ref.finding_id,source:{...ref.attribution,
            model:ref.version,batch_id:ref.batch_id,case_id:ref.case_id,input_id:ref.input_id,source:ref.source}}))];
        return json(res,{sources:sources.slice((page-1)*40,page*40),page,page_size:40,total:sources.length,
          selected_count:selection.sources.length,recalled_count:selection.recall?.length ?? 0});
      }
      if (req.method === "GET" && action === "artifacts") {
        const result = await runArtifacts(res,path.join(job.output_dir,id),url.searchParams.get("file"));
        if (result) return json(res,result.files); return;
      }
    }
    if (/^\/api\/dashboard\/batch-runs\/[^/]+\/(archive|artifacts)$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), id = safeId(parts[4]!), action = parts[5];
      const entry = await batches.get(id); if (!entry) throw new HttpError(404,"批次运行不存在");
      const directory = path.join(entry.outputDir,id);
      if (req.method === "GET" && action === "artifacts") {
        const result = await runArtifacts(res,directory,url.searchParams.get("file"));
        if (result) return json(res,{...result,archived_at:entry.archivedAt}); return;
      }
      if (req.method === "POST" && action === "archive") {
        reserveRun(id);
        let release: (()=>Promise<void>) | undefined;
        try {
          if (entry.pid) {
            try { process.kill(entry.pid,0); throw new HttpError(409,"运行尚未退出"); }
            catch(error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
          if (!await exists(locateRun(directory).stateFile)) throw new HttpError(409,"暂无可归档结果");
          try { release = await runLock(directory,{createDirectory:false}); }
          catch(error) { throw new HttpError(409,errorText(error)); }
          if (!await exists(locateRun(directory).stateFile) || !(await listRunArtifacts(directory)).length) throw new HttpError(409,"暂无可归档结果");
          entry.archivedAt = Date.now(); await batches.save(entry);
          return json(res,{run_id:id,archived_at:entry.archivedAt,directory});
        } finally { await release?.(); changingRuns.delete(id); }
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/batch-runs") {
      const entries = await batches.list();
      return json(res, { runs: await Promise.all(entries.filter(entry => !["draft", "preview_failed"].includes(entry.status))
        .sort((a,b) => b.createdAt - a.createdAt).map(batchSummary)) });
    }
    if (req.method === "POST" && /^\/api\/dashboard\/batch-runs\/[^/]+\/(start|resume|retry)$/.test(url.pathname)) {
      const parts = url.pathname.split("/"), id = safeId(parts[4]!), action = parts[5];
      const entry = await batches.get(id);
      if (!entry) throw new HttpError(404, "批次运行不存在");
      const value = record(await body(req, 64 * 1024), "Expected JSON object");
      if (Object.keys(value).some(key => !["task_ids", "resume_stages"].includes(key))) throw new HttpError(400, "Unknown recovery field");
      for (const key of ["task_ids", "resume_stages"] as const)
        if (value[key] !== undefined && (!Array.isArray(value[key]) || (value[key] as unknown[]).some(item => typeof item !== "string" || !item)))
          throw new HttpError(400, "Invalid " + key);
      const directory = path.join(entry.outputDir, id);
      if (entry.pid) {
        try { process.kill(entry.pid, 0); throw new HttpError(409, "运行进程尚未退出"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      reserveRun(id);
      try {
        if (await readLock(directory)) throw new HttpError(409, "运行仍在执行");
        const saved = await exists(locateRun(directory).stateFile);
        if (action === "start" && saved) throw new HttpError(409, "运行已存在，请续跑");
        if (action === "retry" && !saved) throw new HttpError(409, "运行尚无失败任务");
        if (saved && value.resume_stages) {
          const checkpoint = await readJson<{ pausedStages?: { stage: string }[] }>(locateRun(directory).stateFile);
          if ((value.resume_stages as string[]).some(stage => !checkpoint.pausedStages?.some(pause => pause.stage === stage)))
            throw new HttpError(400, "只能解除当前已暂停的阶段");
        }
        const settings = batchOptions(entry);
        const preview = await previewRun(settings, batchPayload(entry));
        if (!preview.tasks) throw new HttpError(409, "没有可评任务");
        entry.status = "starting"; delete entry.archivedAt; delete entry.error; await batches.save(entry);
        const result = await startRun({ ...settings, discoverInputs: action === "resume", beforeLaunch: async () => {
          if (action === "retry") {
            const repair = await prepareFailedTasks(directory, { taskIds: value.task_ids as string[] | undefined, apply: true });
            if (!repair.count) throw new HttpError(409, "没有可重试的失败任务");
          }
        }, resumeStages: value.resume_stages as string[] | undefined,
          onExit: (code, signal) => { void (async () => {
            const current = await batches.get(id);
            if (!current || current.pid !== result.pid) return;
            current.status = code === 0 ? "finished" : "interrupted";
            if (code !== 0 && !await exists(locateRun(directory).stateFile)) current.error = `启动进程退出：${signal ?? code}，请查看运行日志`;
            delete current.pid; await batches.save(current);
          })().catch(error => console.error("保存运行退出状态失败：", error)); },
        }, batchPayload(entry));
        entry.pid = result.pid; await batches.save(entry);
        changingRuns.set(id, result.pid);
        return json(res, result, 202);
      } catch (error) {
        changingRuns.delete(id); entry.error = errorText(error); await batches.save(entry); throw error;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/runs") {
      const existing = await allRuns(outputDir), registered = await batches.list();
      const ids = new Set(existing.runs.map(run => run.run_id));
      const extra = await Promise.all(registered.filter(entry => !ids.has(entry.runId) && !["draft","ready","preview_failed"].includes(entry.status)).map(batchSummary));
      return json(res, { ...existing, runs: [...existing.runs, ...extra].sort((a,b) => b.started_at - a.started_at) });
    }
    if (req.method === "POST" && url.pathname === "/api/dashboard/preview")
      return json(res, await previewRun({ configPaths: options.configPaths, outputDir, modelCatalog: readModels, plan: inputs.plan }, record(await body(req, 64 * 1024), "Expected JSON object")));
    if (req.method === "POST" && url.pathname === "/api/dashboard/runs") {
      const value = record(await body(req, 64 * 1024), "Expected JSON object");
      if (typeof value.runId !== "string") throw new HttpError(400, "runId is required");
      let runId: string;
      try { runId = safeId(value.runId); }
      catch { throw new HttpError(400, "Invalid runId"); }
      if (await batches.get(runId)) throw new HttpError(409, "请使用批次运行的继续或重试操作");
      reserveRun(runId);
      try {
        const result = await startRun({ configPaths: options.configPaths, outputDir, modelCatalog: readModels, plan: inputs.plan }, value);
        changingRuns.set(runId, result.pid);
        return json(res, result, 202);
      } catch (error) { changingRuns.delete(runId); throw error; }
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "dashboard" && parts[2] === "library") {
      const evaluation = await loadComparisonEvaluation(options.configPaths);
      if (parts.length === 3) return json(res, await listConfiguredProblemLibrary(evaluation));
      if (parts.length === 6 && parts[3] && parts[4] === "classes" && parts[5]) {
        const page = Number(url.searchParams.get("page") || "1");
        if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "Invalid page");
        let model: string, classId: string;
        try { model = safeId(decodeURIComponent(parts[3])); classId = safeId(decodeURIComponent(parts[5])); }
        catch { throw new HttpError(400, "Invalid problem library identity"); }
        const detail = await readConfiguredProblemClass(evaluation, model, classId, page);
        if (!detail) throw new HttpError(404, "Problem class not found");
        return json(res, detail);
      }
      throw new HttpError(404, "Not found");
    }
    if (parts[0] !== "api" || parts[1] !== "dashboard" || parts[2] !== "runs" || !parts[3])
      throw new HttpError(404, "Not found");
    const runId = safeId(parts[3]);
    const selectedOutput = await runOutput(runId);
    const directory = path.join(selectedOutput, runId);
    if (req.method === "DELETE" && parts.length === 4) {
      reserveRun(runId);
      try {
        const result = await deleteRun({ outputDirectory: selectedOutput, runId,
          logDirectory: logs.directory, logLockDirectory: logs.lockDirectory });
        if (await batches.get(runId)) await localFiles.remove(path.dirname(batches.file(runId)), { recursive: true });
        return json(res, result);
      } catch (error) {
        if (error instanceof RunDeletionError) throw new HttpError(error.reason === "not_found" ? 404 : 409, error.message);
        throw error;
      } finally { changingRuns.delete(runId); }
    }
    if (req.method === "GET" && parts[4] === "errors" && parts.length === 5) {
      if (!await batches.get(runId) && !await exists(locateRun(directory).stateFile)) throw new HttpError(404, "Run not found");
      return json(res, await errorReader.read(directory, url.searchParams));
    }
    if (!(await exists(locateRun(directory).stateFile))) throw new HttpError(404, "Run not found");
    if (req.method === "GET" && parts[4] === "cases" && parts[5] === "detail" && parts.length === 6) {
      const batch = url.searchParams.get("batch") || "";
      const caseId = url.searchParams.get("case") || "";
      if (!batch || !caseId) throw new HttpError(400, "batch and case are required");
      const detail = await readCaseDetail(directory, batch, caseId);
      if (!detail) throw new HttpError(404, "Case not found");
      return json(res, detail);
    }
    if (req.method === "GET" && parts[4] === "tasks" && parts[6] === "result" && parts.length === 7) {
      const result = await readTaskResult(directory, safeId(parts[5]));
      if (!result) throw new HttpError(404, "Task not found");
      return json(res, result);
    }
    if (req.method === "GET" && parts[4] === "cases" && parts.length === 5) {
      const page = Number(url.searchParams.get("page") || "1");
      if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "Invalid page");
      return json(res, await listRunCases(directory, {
        page, pageSize: 40,
        batch: url.searchParams.get("batch") || undefined,
        stage: url.searchParams.get("stage") || undefined,
        status: url.searchParams.get("status") || undefined,
      }));
    }
    if (req.method === "GET" && parts[4] === "clustering" && parts.length === 5)
      return json(res, await listClusteringTasks(directory));
    if (req.method === "GET" && parts[4] === "inputs" && parts[5] && parts.length === 6) {
      try {
        const input = await readRegisteredInput(directory, safeId(parts[5]));
        if (!input) throw new HttpError(404, "Input not registered in this run");
        return json(res, input);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(409, `当前原始材料不可用：${errorText(error)}`);
      }
    }
    if (req.method === "GET" && parts.length === 4)
      return json(res, { ...await inspectRun(selectedOutput, runId), batch_run: !!await batches.get(runId) });
    if (req.method === "POST" && parts[4] === "stop")
      return json(res, await controlRun(selectedOutput, runId, "stop"));
    if (req.method === "POST" && parts[4] === "concurrency") {
      const value = record(await body(req, 64 * 1024), "Expected JSON object").value;
      if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, "value must be positive");
      return json(res, await controlRun(selectedOutput, runId, "concurrency", Number(value)));
    }
    throw new HttpError(404, "Not found");
  }, options.port);
  return server;
}

export type { DashboardOptions };
