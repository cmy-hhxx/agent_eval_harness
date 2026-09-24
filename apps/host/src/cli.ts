import { parseArgs } from "node:util";
import path from "node:path";
import type { Engine, ModelConfig } from "../../../packages/contracts/src/index.js";
import { ROOT, errorText, readJson, exists, redact, runLock } from "../../../packages/contracts/src/io.js";
import { loadConfig } from "../../../packages/pairwise-eval/src/input.js";
import { pairwisePack } from "../../../packages/pairwise-eval/src/index.js";
import { reportRun } from "../../../packages/pairwise-eval/src/report.js";
import { runEvaluation } from "./runner.js";
import { upgradeRun } from "../../../packages/pairwise-eval/src/upgrade.js";
import { validateRun } from "./validate.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: path.join(ROOT, "configs/host.json") },
      engine: { type: "string", default: "pi" },
      "run-id": { type: "string" },
      run: { type: "string" },
      debug: { type: "boolean" },
      batch: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      "limit-cases": { type: "string" },
      worker: { type: "string", multiple: true },
      help: { type: "boolean" },
      details: { type: "boolean" },
      apply: { type: "boolean" },
      value: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "eval preflight|run|status|validate|report|upgrade-run|concurrency|progress --config configs/host.json\nrun: --engine pi|prime --run-id ID [--debug] [--worker URL ...]\n相同 run-id 自动续跑，已完成结果保留；--debug 额外保存 _internal/\nselection: --batch ID --case ID --limit-cases N\nstatus/validate/report: --run data/runs/ID\nreport: [--details] 为 debug 运行导出逐题 JSON 与任务状态\nupgrade-run: --run PATH [--apply]\nconcurrency: --run PATH --value N\nprogress: --run PATH",
    );
    return;
  }
  if (values.details && command !== "report") throw new Error("--details 仅用于 report");
  if (values.debug && command !== "run") throw new Error("--debug 仅用于 run");
  if (command === "concurrency" || command === "progress") {
    if (!values.run) throw new Error("--run required");
    const lock = await readJson<{ url: string; token: string }>(path.join(path.resolve(values.run), ".run-lock"));
    const value = Number(values.value);
    if (command === "concurrency" && (!Number.isInteger(value) || value < 1)) throw new Error("--value must be positive");
    const response = await fetch(lock.url + (command === "progress" ? "/v1/progress" : "/v1/control/concurrency"), {
      method: command === "progress" ? "GET" : "POST", headers: { "content-type": "application/json", "x-run-token": lock.token },
      ...(command === "progress" ? {} : { body: JSON.stringify({ concurrency: value }) }), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === "upgrade-run") {
    if (!values.run) throw new Error("--run required");
    console.log(JSON.stringify(await upgradeRun(path.resolve(values.run), values.apply), null, 2));
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
            ? await validateRun(run)
            : await reportRun(run, { details: values.details });
    } finally {
      await release();
    }
    console.log(JSON.stringify(result, null, 2));
    if (command === "validate" && !(result as { valid: boolean }).valid) process.exitCode = 2;
    return;
  }
  const config = await loadConfig(values.config);
  if (values.batch) config.inputs.batches = values.batch;
  if (values.case) config.inputs.case_ids = values.case;
  if (values["limit-cases"]) {
    const limit = Number(values["limit-cases"]);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit-cases must be positive");
    config.inputs.limit = limit;
  }
  const resuming = command === "run" && values["run-id"] && await exists(path.join(config.outputDir, values["run-id"], "state.json"));
  const plan = resuming ? { tasks: [], inputs: {}, summary: {} } : await pairwisePack.plan(config);
  if (command === "preflight") {
    console.log(JSON.stringify(plan.summary, null, 2));
    if ((plan.summary.issues as unknown[]).length) process.exitCode = 2;
    return;
  }
  if (command !== "run") throw new Error("Unknown command");
  if (!plan.tasks.length && !(values["run-id"] && await exists(path.join(config.outputDir, values["run-id"], "state.json"))))
    throw new Error("没有可评配对，请先查看 preflight");
  const engine = values.engine as Engine;
  if (!["pi", "prime"].includes(engine)) throw new Error("--engine must be pi or prime");
  if (!process.env[config.judge.apiKeyEnv])
    throw new Error(`Missing ${config.judge.apiKeyEnv}; configure the shared model key in .env`);
  const controller = new AbortController(),
    interrupt = () => controller.abort(new Error("User interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { correctness, pairwise, ...shared } = config.judge;
    const result = await runEvaluation({
      runId: values["run-id"] || `${engine}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
      outputDir: config.outputDir,
      engine,
      config,
      pack: pairwisePack,
      plan,
      policy: config.execution,
      modelForStage: (stage) =>
        ({ ...shared, ...(stage === "correctness" ? correctness : pairwise) }) as ModelConfig,
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
main().catch((error) => {
  console.error(redact(errorText(error), [process.env.EVAL_API_KEY || ""]));
  process.exitCode = 2;
});
