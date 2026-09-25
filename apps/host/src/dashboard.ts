import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { body, json, listen } from "@eval/runtime/http";
import { HttpError, safeId, type RunState } from "@eval/contracts";
import { exists, readJson } from "@eval/data";
import { progressSnapshot } from "@eval/host";
import { pairwiseRepository } from "@eval/workflows/pairwise";

interface DashboardOptions {
  configPath: string;
  port: number;
  outputDir?: string;
}

interface DashboardSource {
  inputs?: unknown;
  judge?: Record<string, unknown>;
  execution?: unknown;
  outputDir?: string;
}

interface RunLock {
  pid?: number;
  token?: string;
  url?: string;
}

interface CheckpointTask {
  stage?: string;
  status?: string;
  attempts?: number;
  reason?: string;
  inputIds?: Record<string, string>;
}

interface DashboardCheckpoint {
  format?: string;
  runId?: string;
  status?: string;
  engine?: { engine?: string };
  startedAt?: number;
  finishedAt?: number;
  concurrency?: number;
  tasks?: Record<string, CheckpointTask>;
}

const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, message);
  return value as Record<string, unknown>;
}

function publicConfig(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => publicConfig(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, publicConfig(item, name)]),
    );
  if (/(?:api[_-]?key|secret|password|token|baseurl)/i.test(key) && !/env$/i.test(key)) return "[hidden]";
  return value;
}

function taskState(value: {
  status: string;
  attempts: number;
  reason?: string;
  durationMs?: number;
  startedAt?: number;
  lastProgressAt?: number;
  failure?: { errors?: { category?: string; code?: string; message?: string }[]; stopped?: boolean };
}) {
  return {
    status: value.status,
    attempts: value.attempts,
    ...(value.reason ? { reason: value.reason } : {}),
    ...(value.durationMs !== undefined ? { duration_ms: value.durationMs } : {}),
    ...(value.startedAt !== undefined ? { started_at: value.startedAt } : {}),
    ...(value.lastProgressAt !== undefined ? { last_progress_at: value.lastProgressAt } : {}),
    ...(value.failure
      ? {
          failure: {
            stopped: value.failure.stopped,
            errors: (value.failure.errors || []).map(({ category, code, message }) => ({
              category,
              code,
              message,
            })),
          },
        }
      : {}),
  };
}

function fallbackProgress(checkpoint: DashboardCheckpoint) {
  const tasks = Object.values(checkpoint.tasks || {});
  const accepted = tasks.filter((task) => task.status === "succeeded").length;
  const running = tasks.filter((task) => task.status === "running").length;
  return {
    queued: tasks.filter((task) => task.status === "pending").length,
    running,
    accepted,
    repairing: 0,
    failures: Object.fromEntries(
      ["failed", "timed_out", "cancelled", "blocked"].flatMap((status) => {
        const count = tasks.filter((task) => task.status === status).length;
        return count ? [[status, count]] : [];
      }),
    ),
    concurrency: checkpoint.concurrency || 1,
    recent_completed_per_minute: 0,
    longest_without_progress: null,
    eta: null,
    eta_status: "insufficient_samples",
  };
}

function lockFile(run: string): string {
  return path.join(run, ".run-lock");
}

async function readLock(run: string): Promise<RunLock | undefined> {
  if (!(await exists(lockFile(run)))) return undefined;
  return readJson<RunLock>(lockFile(run));
}

function taskRows(state: RunState) {
  return state.manifest.tasks.map((task) => {
    const data = task.data as {
      candidates?: Record<string, { batch_id?: string; case_id?: string; version?: string }>;
    };
    const candidate = data.candidates?.A || data.candidates?.a || {};
    return {
      id: task.id,
      stage: task.stage,
      batch_id: candidate.batch_id || "",
      case_id: candidate.case_id || "",
      version: candidate.version || "",
      state: taskState(state.manifest.states[task.id]),
    };
  });
}

function checkpointRows(checkpoint: DashboardCheckpoint) {
  return Object.entries(checkpoint.tasks || {}).map(([id, task]) => ({
    id,
    stage: task.stage || "unknown",
    batch_id: "",
    case_id: "",
    version: "",
    state: {
      status: task.status || "unknown",
      attempts: task.attempts || 0,
      ...(task.reason ? { reason: task.reason } : {}),
    },
  }));
}

async function inspectRun(outputDir: string, runId: string, includeTasks = true) {
  const run = path.join(outputDir, runId);
  const lock = await readLock(run);
  let state: RunState | undefined;
  let checkpoint: DashboardCheckpoint | undefined;
  if (includeTasks) {
    try {
      state = await pairwiseRepository.readRun(run);
    } catch {
      checkpoint = await readJson<DashboardCheckpoint>(path.join(run, "state.json"));
    }
  } else checkpoint = await readJson<DashboardCheckpoint>(path.join(run, "state.json"));
  if (!state && !checkpoint) return undefined;
  const progress = state ? progressSnapshot(state) : fallbackProgress(checkpoint!);
  const manifest = state?.manifest;
  const status = lock ? "running" : manifest?.status || checkpoint?.status || "unknown";
  return {
    run_id: runId,
    status,
    engine: manifest?.engine.engine || checkpoint?.engine?.engine || "unknown",
    started_at: manifest?.startedAt || checkpoint?.startedAt || 0,
    finished_at: manifest?.finishedAt || checkpoint?.finishedAt,
    concurrency: progress.concurrency,
    progress,
    ...(lock ? { process_id: lock.pid } : {}),
    ...(includeTasks ? { tasks: state ? taskRows(state) : checkpointRows(checkpoint!) } : {}),
  };
}

async function allRuns(outputDir: string) {
  let entries;
  try {
    entries = await (await import("node:fs/promises")).readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => inspectRun(outputDir, entry.name, false).catch(() => undefined)),
    )
  ).filter((run): run is NonNullable<typeof run> => Boolean(run));
  return runs.sort((a, b) => b.started_at - a.started_at);
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

async function startRun(options: DashboardOptions, outputDir: string, value: Record<string, unknown>) {
  const rawId = value.runId;
  if (typeof rawId !== "string") throw new HttpError(400, "runId is required");
  const runId = safeId(rawId);
  const engine = value.engine || "pi";
  if (engine !== "pi" && engine !== "prime") throw new HttpError(400, "engine must be pi or prime");
  if (await exists(lockFile(path.join(outputDir, runId)))) throw new HttpError(409, "Run is already running");
  const args = [CLI_ENTRY, "run", "--config", options.configPath, "--engine", engine, "--run-id", runId];
  for (const name of ["batch", "case"] as const) {
    const values = value[name];
    if (values !== undefined) {
      if (!Array.isArray(values) || values.some((item) => typeof item !== "string"))
        throw new HttpError(400, `${name} must be an array of strings`);
      for (const item of values) args.push(`--${name}`, item);
    }
  }
  if (value.limitCases !== undefined) {
    if (!Number.isInteger(value.limitCases) || Number(value.limitCases) < 1)
      throw new HttpError(400, "limitCases must be positive");
    args.push("--limit-cases", String(value.limitCases));
  }
  if (value.debug === true) args.push("--debug");
  const child = spawn(process.execPath, args, {
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return { run_id: runId, pid: child.pid, output_dir: outputDir };
}

export async function startDashboard(options: DashboardOptions) {
  const source = await readJson<DashboardSource>(options.configPath);
  if (typeof source.outputDir !== "string") throw new Error("Invalid outputDir in dashboard config");
  const outputDir = options.outputDir || path.resolve(path.dirname(options.configPath), source.outputDir);
  const [html, css, javascript] = await Promise.all([
    readFile(path.join(ASSET_DIR, "index.html"), "utf8"),
    readFile(path.join(ASSET_DIR, "dashboard.css"), "utf8"),
    readFile(path.join(ASSET_DIR, "dashboard.js"), "utf8"),
  ]);
  const server = await listen(async (req, res, url) => {
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
      const judge = source.judge || {};
      const baseUrlEnv = typeof judge.baseUrlEnv === "string" ? judge.baseUrlEnv : "";
      const apiKeyEnv = typeof judge.apiKeyEnv === "string" ? judge.apiKeyEnv : "";
      return json(res, {
        path: options.configPath,
        config: publicConfig(source),
        environment: {
          base_url_configured: Boolean(baseUrlEnv && process.env[baseUrlEnv]),
          api_key_configured: Boolean(apiKeyEnv && process.env[apiKeyEnv]),
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/runs")
      return json(res, { runs: await allRuns(outputDir) });
    if (req.method === "POST" && url.pathname === "/api/dashboard/runs")
      return json(res, await startRun(options, outputDir, record(await body(req), "Expected JSON object")), 202);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "dashboard" || parts[2] !== "runs" || !parts[3])
      throw new HttpError(404, "Not found");
    const runId = safeId(parts[3]);
    if (req.method === "GET" && parts.length === 4) {
      const run = await inspectRun(outputDir, runId);
      if (!run) throw new HttpError(404, "Run not found");
      return json(res, run);
    }
    if (req.method === "POST" && parts[4] === "stop")
      return json(res, await controlRun(outputDir, runId, "stop"));
    if (req.method === "POST" && parts[4] === "concurrency") {
      const value = record(await body(req), "Expected JSON object").value;
      if (!Number.isInteger(value) || Number(value) < 1) throw new HttpError(400, "value must be positive");
      return json(res, await controlRun(outputDir, runId, "concurrency", Number(value)));
    }
    throw new HttpError(404, "Not found");
  }, options.port);
  return server;
}

export type { DashboardOptions };
