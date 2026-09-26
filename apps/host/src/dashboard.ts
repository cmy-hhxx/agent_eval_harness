import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { body, json, listen } from "@eval/runtime/http";
import { errorText, HttpError, safeId } from "@eval/contracts";
import { exists, locateRun, readJson } from "@eval/data";
import { editableDashboardSettings, loadEvaluation, readConfigSources } from "./config.js";
import { readLock, previewRun, startRun } from "./dashboard-launch.js";
import { listInputInventory, listRunCases, readCaseDetail, readProblemClass, listProblemLibrary, readRegisteredInput } from "@eval/workflows/comparison";

interface DashboardOptions {
  configPaths: string[];
  port: number;
}

interface CheckpointTask {
  stage?: string;
  status?: string;
  failure?: { draft?: unknown; errors?: { category?: string }[] };
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

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, message);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelReadiness(source: Record<string, unknown>) {
  const profiles = isRecord(source.models) ? source.models : {};
  const bindings = Object.values(isRecord(source.bindings) ? source.bindings : {});
  if (!bindings.length)
    return { base_url_configured: false, api_key_configured: false, model_configured: false };
  let baseUrl = true,
    apiKey = true,
    model = true;
  for (const binding of bindings) {
    if (!isRecord(binding) || typeof binding.profile !== "string") {
      baseUrl = apiKey = model = false;
      continue;
    }
    const profile = profiles[binding.profile];
    if (!isRecord(profile)) {
      baseUrl = apiKey = model = false;
      continue;
    }
    if (!(typeof profile.baseUrlEnv === "string" && process.env[profile.baseUrlEnv])) baseUrl = false;
    if (!(typeof profile.apiKeyEnv === "string" && process.env[profile.apiKeyEnv])) apiKey = false;
    const id = binding.model ?? profile.model;
    if (typeof id !== "string" || !id) model = false;
  }
  return { base_url_configured: baseUrl, api_key_configured: apiKey, model_configured: model };
}

function fallbackProgress(checkpoint: DashboardCheckpoint) {
  const tasks = Object.values(checkpoint.tasks || {});
  const accepted = tasks.filter((task) => task.status === "succeeded").length;
  const running = tasks.filter((task) => task.status === "running");
  const failures: Record<string, number> = {};
  for (const task of tasks)
    if (["failed", "timed_out", "cancelled", "blocked"].includes(task.status || "")) {
      const category = task.failure?.errors?.[0]?.category || "interruption";
      failures[category] = (failures[category] || 0) + 1;
    }
  return {
    queued: tasks.filter((task) => task.status === "pending").length,
    running: running.length,
    accepted,
    repairing: running.filter((task) => task.failure?.draft !== undefined).length,
    failures,
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
  const inspected = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
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

export async function startDashboard(options: DashboardOptions) {
  const source = await readConfigSources(options.configPaths);
  const output = source.output;
  if (!isRecord(output) || typeof output.path !== "string")
    throw new Error("Invalid output target in dashboard config");
  const outputDir = path.resolve(output.path);
  const [html, css, javascript] = await Promise.all([
    readFile(path.join(ASSET_DIR, "index.html"), "utf8"),
    readFile(path.join(ASSET_DIR, "dashboard.css"), "utf8"),
    readFile(path.join(ASSET_DIR, "dashboard.js"), "utf8"),
  ]);
  const server = await listen(async (req, res, url) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'");
    const host = req.headers.host || "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new HttpError(403, "Only loopback requests are allowed");
    if (req.method === "POST" && req.headers.origin !== `http://${host}`)
      throw new HttpError(403, "Request origin does not match the dashboard");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && url.pathname === "/dashboard.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(css);
      return;
    }
    if (req.method === "GET" && url.pathname === "/dashboard.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(javascript);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/config") {
      const current = await readConfigSources(options.configPaths);
      return json(res, {
        paths: options.configPaths,
        settings: editableDashboardSettings(current),
        environment: modelReadiness(current),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/inputs")
      return json(res, await listInputInventory(await loadEvaluation(options.configPaths)));
    if (req.method === "GET" && url.pathname === "/api/dashboard/runs")
      return json(res, await allRuns(outputDir));
    if (req.method === "POST" && url.pathname === "/api/dashboard/preview")
      return json(res, await previewRun({ configPaths: options.configPaths, outputDir }, record(await body(req, 64 * 1024), "Expected JSON object")));
    if (req.method === "POST" && url.pathname === "/api/dashboard/runs")
      return json(res, await startRun({ configPaths: options.configPaths, outputDir }, record(await body(req, 64 * 1024), "Expected JSON object")), 202);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "dashboard" || parts[2] !== "runs" || !parts[3])
      throw new HttpError(404, "Not found");
    const runId = safeId(parts[3]);
    const directory = path.join(outputDir, runId);
    if (!(await exists(locateRun(directory).stateFile))) throw new HttpError(404, "Run not found");
    if (req.method === "GET" && parts[4] === "cases" && parts[5] === "detail" && parts.length === 6) {
      const batch = url.searchParams.get("batch") || "";
      const caseId = url.searchParams.get("case") || "";
      if (!batch || !caseId) throw new HttpError(400, "batch and case are required");
      const detail = await readCaseDetail(directory, batch, caseId);
      if (!detail) throw new HttpError(404, "Case not found");
      return json(res, detail);
    }
    if (req.method === "GET" && parts[4] === "cases" && parts.length === 5) {
      const page = Number(url.searchParams.get("page") || "1");
      if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "Invalid page");
      const query = url.searchParams.get("query") || "";
      if (query.length > 200) throw new HttpError(400, "Search is too long");
      return json(res, await listRunCases(directory, {
        page, pageSize: 40,
        batch: url.searchParams.get("batch") || undefined,
        query,
        stage: url.searchParams.get("stage") || undefined,
        status: url.searchParams.get("status") || undefined,
      }));
    }
    if (req.method === "GET" && parts[4] === "library" && parts.length === 5)
      return json(res, await listProblemLibrary(directory));
    if (req.method === "GET" && parts[4] === "library" && parts.length === 8 && parts[5] && parts[6] === "classes" && parts[7]) {
      const page = Number(url.searchParams.get("page") || "1");
      if (!Number.isSafeInteger(page) || page < 1) throw new HttpError(400, "Invalid page");
      const detail = await readProblemClass(directory, safeId(parts[5]), safeId(parts[7]), page);
      if (!detail) throw new HttpError(404, "Problem class not found");
      return json(res, detail);
    }
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
      return json(res, await inspectRun(outputDir, runId));
    if (req.method === "POST" && parts[4] === "stop")
      return json(res, await controlRun(outputDir, runId, "stop"));
    if (req.method === "POST" && parts[4] === "concurrency") {
      const value = record(await body(req, 64 * 1024), "Expected JSON object").value;
      if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, "value must be positive");
      return json(res, await controlRun(outputDir, runId, "concurrency", Number(value)));
    }
    throw new HttpError(404, "Not found");
  }, options.port);
  return server;
}

export type { DashboardOptions };
