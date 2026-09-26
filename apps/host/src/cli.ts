import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Engine } from "@eval/contracts";
import { ROOT } from "./paths.js";
import { errorText, redact } from "@eval/contracts";
import { readJson, exists, runLayout, runLock } from "@eval/data";
import { boundProfiles, createModelResolver, loadConfig } from "@eval/host-app/config";
import { services, agents, logger } from "./composition.js";
import { comparisonWorkflow } from "@eval/workflows/comparison";
import { reportRun } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { validateRun } from "@eval/workflows/comparison";
import { startDashboard } from "./dashboard.js";

let logRunId: string | undefined;
async function main(): Promise<void> {
  await logger.initialize();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", multiple: true, default: [path.join(ROOT, "configs/host.json")] },
      engine: { type: "string", default: "pi" },
      "run-id": { type: "string" },
      run: { type: "string" },
      output: { type: "string" },
      input: { type: "string", multiple: true },
      debug: { type: "boolean" },
      batch: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      "limit-cases": { type: "string" },
      worker: { type: "string", multiple: true },
      help: { type: "boolean" },
      details: { type: "boolean" },
      value: { type: "string" },
      port: { type: "string", default: "4173" },
    },
  });
  const command = positionals[0];
  logRunId = values["run-id"] || (values.run ? path.basename(path.resolve(values.run)) : undefined);
  if (values.help || !command) {
    console.log(
      "eval preflight|run|status|validate|report|concurrency|progress|dashboard [--config FILE ...]\nrun: --engine pi|prime --run-id ID [--debug] [--worker URL ...]\n配置文件按顺序深度合并；具体模型放在不入库的 --config 中\n相同 run-id 自动续跑，已完成结果保留；--debug 额外保存 _internal/\nselection: --batch ID --case ID --limit-cases N\ninputs/output: --input ID=PATH --output DIR\nstatus/validate/report: --run data/runs/comparison/ID\nreport: [--details] 为 debug 运行导出逐题 JSON 与任务状态\nconcurrency: --run PATH --value N\nprogress: --run PATH\ndashboard: --port 4173 在本机启动控制看板",
    );
    return;
  }
  if (command === "dashboard") {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
    const dashboard = await startDashboard({ configPaths: values.config, port });
    console.log(`Dashboard listening at ${dashboard.url}`);
    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        await dashboard.close();
        resolve();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return;
  }
  if (values.details && command !== "report") throw new Error("--details 仅用于 report");
  if (values.debug && command !== "run") throw new Error("--debug 仅用于 run");
  if (command === "concurrency" || command === "progress") {
    if (!values.run) throw new Error("--run required");
    const lock = await readJson<{ url: string; token: string }>(
      path.join(path.resolve(values.run), ".run-lock"),
    );
    const value = Number(values.value);
    if (command === "concurrency" && (!Number.isInteger(value) || value < 1))
      throw new Error("--value must be positive");
    const response = await fetch(
      lock.url + (command === "progress" ? "/api/progress" : "/api/control/concurrency"),
      {
        method: command === "progress" ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-run-token": lock.token,
        },
        ...(command === "progress" ? {} : { body: JSON.stringify({ concurrency: value }) }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (["status", "validate", "report"].includes(command)) {
    if (!values.run) throw new Error("--run required");
    const run = path.resolve(values.run);
    const release = command === "status" ? async () => {} : await runLock(run);
    let result;
    try {
      result =
        command === "status"
          ? await readJson(path.join(run, "state.json"))
          : command === "validate"
            ? await validateRun(run, (binding, result, audit) => agents.validate(binding, result, audit))
            : await reportRun(run, { details: values.details });
    } finally {
      await release();
    }
    console.log(JSON.stringify(result, null, 2));
    if (command === "validate" && !(result as { valid: boolean }).valid) {
      await logger.error("Run validation failed; inspect the command output for result and evidence errors", {
        component: "host",
        event: "validation_failed",
        run_id: logRunId,
      });
      process.exitCode = 2;
    }
    return;
  }
  const host = await loadConfig(values.config);
  const config = host.evaluation;
  if (values.output) config.output = { kind: "directory", path: path.resolve(values.output) };
  for (const item of values.input || []) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("--input 需要 ID=PATH");
    const id = item.slice(0, separator),
      target = path.resolve(item.slice(separator + 1));
    const version = config.inputs.versions.find((entry) => entry.id === id);
    if (!version) throw new Error(`未知的输入版本：${id}`);
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new Error(`输入路径不存在：${target}`);
    version.sources = [{ kind: info.isDirectory() ? "directory" : "file", path: target }];
  }
  for (const profile of boundProfiles(host.models))
    logger.addSecrets(process.env[profile.apiKeyEnv] || "");
  if (values.batch) config.inputs.batches = values.batch;
  if (values.case) config.inputs.case_ids = values.case;
  if (values["limit-cases"]) {
    const limit = Number(values["limit-cases"]);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit-cases must be positive");
    config.inputs.limit = limit;
  }
  const resuming =
    command === "run" &&
    values["run-id"] &&
    (await exists(runLayout(config.output, values["run-id"]).stateFile));
  const plan = resuming ? { tasks: [], inputs: {}, summary: {} } : await comparisonWorkflow.plan(config);
  if (command === "preflight") {
    console.log(JSON.stringify(plan.summary, null, 2));
    if ((plan.summary.issues as unknown[]).length) {
      await logger.error(
        `Input preflight found ${(plan.summary.issues as unknown[]).length} issues; inspect the command output`,
        {
          component: "host",
          event: "preflight_failed",
        },
      );
      process.exitCode = 2;
    }
    return;
  }
  if (command !== "run") throw new Error("Unknown command");
  if (
    !plan.tasks.length &&
    !(values["run-id"] && (await exists(runLayout(config.output, values["run-id"]).stateFile)))
  )
    throw new Error("没有可评对比组，请先查看 preflight");
  const engine = values.engine as Engine;
  if (!["pi", "prime"].includes(engine)) throw new Error("--engine must be pi or prime");
  const modelForStage = createModelResolver(host.models);
  for (const stage of Object.keys(host.models.bindings)) modelForStage(stage);
  for (const profile of boundProfiles(host.models))
    if (!process.env[profile.apiKeyEnv])
      throw new Error(`Missing ${profile.apiKeyEnv}; configure the model key in .env`);
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("User interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    logRunId = values["run-id"] || `${engine}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    const result = await runEvaluation({
      runId: logRunId,
      output: config.output,
      engine,
      config,
      ...services,
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: config.execution.concurrency,
      retries: config.execution.retries,
      retryDelaySeconds: config.execution.retryDelaySeconds,
      debug: values.debug,
      workerUrls: values.worker,
      signal: controller.signal,
      onProgress: console.log,
    });
    console.log(JSON.stringify(result, null, 2));
    const statuses = result.task_statuses as Record<string, number>;
    process.exitCode = controller.signal.aborted
      ? 130
      : ["failed", "blocked", "timed_out", "cancelled", "pending", "running"].some((s) => statuses[s])
        ? 2
        : 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
main().catch(async (error) => {
  await logger.error(error, { component: "host", event: "command_failed", run_id: logRunId });
  console.error(redact(errorText(error), [process.env.EVAL_API_KEY || ""]));
  process.exitCode = 2;
});
