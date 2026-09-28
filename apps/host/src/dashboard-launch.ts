import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorText, HttpError, safeId } from "@eval/contracts";
import { exists, locateRun, readJson } from "@eval/data";
import { readRunState, reconcileRun } from "@eval/workflows/comparison";
import type { JsonObject, TaskPlan } from "@eval/contracts";
import type { EvalConfig } from "@eval/workflows/comparison";
import { dashboardSettings, loadConfig } from "./config.js";
import { createModelResolver } from "./models.js";
import {
  assertAvailableDashboardModels,
  assertGptModelSelections,
  discoverDashboardModels,
  type DashboardModelLoader,
} from "./dashboard-models.js";

interface LaunchOptions {
  configPaths: string[];
  outputDir: string;
  modelCatalog?: DashboardModelLoader;
  plan: (config: EvalConfig) => Promise<TaskPlan>;
}
interface RunLock {
  pid?: number;
  token?: string;
  url?: string;
}
const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

export async function readLock(run: string): Promise<RunLock | undefined> {
  const file = locateRun(run).lockFile;
  if (!(await exists(file))) return undefined;
  const lock = await readJson<RunLock>(file);
  if (!Number.isInteger(lock.pid) || !lock.pid) throw new Error("运行锁尚未初始化");
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw error;
  }
  return lock;
}

function selection(value: Record<string, unknown>) {
  const selected: { batch?: string[]; case?: string[]; limitCases?: number; debug?: boolean } = {};
  for (const key of ["batch", "case"] as const) {
    const items = value[key];
    if (items !== undefined) {
      if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !item.trim()))
        throw new HttpError(400, `${key} must be an array of non-empty strings`);
      selected[key] = items;
    }
  }
  if (value.limitCases !== undefined) {
    if (!Number.isInteger(value.limitCases) || Number(value.limitCases) < 1)
      throw new HttpError(400, "limitCases must be positive");
    selected.limitCases = Number(value.limitCases);
  }
  if (value.debug !== undefined) {
    if (typeof value.debug !== "boolean") throw new HttpError(400, "debug must be boolean");
    selected.debug = value.debug;
  }
  return selected;
}

async function prepare(options: LaunchOptions, value: Record<string, unknown>, launch: boolean) {
  if (Object.keys(value).some((key) => !["runId", "engine", "batch", "case", "limitCases", "debug", "settings"].includes(key)))
    throw new HttpError(400, "Unknown launch field");
  if (typeof value.runId !== "string") throw new HttpError(400, "runId is required");
  let runId: string;
  try { runId = safeId(value.runId); }
  catch { throw new HttpError(400, "Invalid runId"); }
  const engine = value.engine ?? "pi";
  if (engine !== "pi" && engine !== "prime") throw new HttpError(400, "engine must be pi or prime");
  const chosen = selection(value);
  let settings: ReturnType<typeof dashboardSettings>;
  let host: Awaited<ReturnType<typeof loadConfig>>;
  try {
    settings = dashboardSettings(value.settings ?? {});
    assertGptModelSelections(settings);
    host = await loadConfig(options.configPaths, process.env, settings);
  } catch (error) {
    throw new HttpError(400, errorText(error));
  }
  if (launch) {
    try {
      const models = await (options.modelCatalog ?? (() => discoverDashboardModels(options.configPaths)))();
      assertAvailableDashboardModels(models.map((model) => model.id), settings);
      const modelForStage = createModelResolver(host.models);
      const available = new Set(models.map((model) => model.id));
      for (const stage of Object.keys(host.models.bindings)) {
        const model = modelForStage(stage);
        if (!available.has(model.model)) throw new Error(`阶段 ${stage} 的模型不在 .env 网关 GPT 模型列表中`);
      }
      for (const binding of Object.values(host.models.bindings)) {
        const profile = host.models.models[binding.profile]!;
        if (!process.env[profile.apiKeyEnv]) throw new Error(`Missing ${profile.apiKeyEnv}`);
      }
    } catch (error) {
      throw new HttpError(400, errorText(error));
    }
  }
  if (path.resolve(host.evaluation.output.path) !== options.outputDir)
    throw new HttpError(400, "Dashboard output target changed; restart the dashboard");
  const run = path.join(options.outputDir, runId);
  const resuming = await exists(locateRun(run).stateFile);
  const config = host.evaluation;
  if (!resuming) {
    if (chosen.batch) config.inputs.batches = chosen.batch;
    if (chosen.case) config.inputs.case_ids = chosen.case;
    if (chosen.limitCases) config.inputs.limit = chosen.limitCases;
  }
  const plan = resuming ? undefined : await options.plan(config);
  return { runId, engine, chosen, settings, resuming, plan, run, config };
}

function summarize(summary: JsonObject) {
  return {
    cases: summary.cases,
    valid_inputs: summary.valid_inputs,
    attribution_tasks: summary.attribution_tasks,
    comparison_tasks: summary.comparison_tasks,
    rewrite_tasks: summary.rewrite_tasks,
    clustering_tasks: summary.clustering_tasks,
    issues_count: (summary.issues as unknown[]).length,
    issues: (summary.issues as unknown[]).slice(0, 20),
    skipped_count: (summary.skipped as unknown[]).length,
  };
}

/** No writes or model calls. Resume previews reconciled work using the original selection. */
export async function previewRun(options: LaunchOptions, value: Record<string, unknown>) {
  const prepared = await prepare(options, value, false);
  if (prepared.resuming) {
    const state = await readRunState(prepared.run);
    const plan = await reconcileRun(prepared.run, state, prepared.config);
    return {
      resuming: true,
      tasks: plan.tasks.length,
      remaining: plan.tasks.filter((task) => !state.receipts[task.id]).length,
      selection_note: "续跑沿用原批次、case 和数量范围；已接受任务不会重评",
      summary: summarize(plan.summary),
    };
  }
  return {
    resuming: false,
    tasks: prepared.plan!.tasks.length,
    summary: summarize(prepared.plan!.summary),
  };
}

/** A child runs the same CLI reconciliation and run lock rules as terminal launches. */
export async function startRun(options: LaunchOptions, value: Record<string, unknown>) {
  const { runId, engine, chosen, settings, resuming, plan, run } = await prepare(options, value, true);
  if (!resuming && !plan?.tasks.length) throw new HttpError(400, "没有可评对比组，请先查看预检诊断");
  if (await readLock(run)) throw new HttpError(409, "Run is already running");
  const args = [CLI_ENTRY, "run"];
  for (const config of options.configPaths) args.push("--config", config);
  args.push("--engine", engine, "--run-id", runId, "--dashboard-settings", JSON.stringify(settings));
  if (!resuming) {
    for (const name of ["batch", "case"] as const)
      for (const item of chosen[name] || []) args.push(`--${name}`, item);
    if (chosen.limitCases) args.push("--limit-cases", String(chosen.limitCases));
  }
  if (chosen.debug) args.push("--debug");
  const child = spawn(process.execPath, args, { env: process.env, stdio: "ignore" });
  try {
    // Surface spawn failures instead of crashing the dashboard on an unhandled error event.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } catch (error) {
    throw new HttpError(500, `无法启动运行进程：${errorText(error)}`);
  }
  child.unref();
  return { run_id: runId, pid: child.pid, output_dir: options.outputDir };
}
