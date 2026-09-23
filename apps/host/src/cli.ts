import { parseArgs } from "node:util";
import path from "node:path";
import type { Engine, ModelConfig } from "../../../packages/contracts/src/index.js";
import { ROOT, errorText, readJson, redact, runLock } from "../../../packages/contracts/src/io.js";
import { loadConfig } from "../../../packages/pairwise-eval/src/input.js";
import { pairwisePack } from "../../../packages/pairwise-eval/src/index.js";
import { runEvaluation } from "./runner.js";
import { validateRun } from "./validate.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", default: path.join(ROOT, "configs/host.json") },
      engine: { type: "string", default: "pi" },
      "run-id": { type: "string" },
      run: { type: "string" },
      resume: { type: "boolean" },
      "retry-failed": { type: "boolean" },
      batch: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      "limit-cases": { type: "string" },
      worker: { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "eval preflight|run|status|validate|report --config configs/host.json\nrun: --engine pi|prime --run-id ID [--resume --retry-failed] [--worker URL ...]\nselection: --batch ID --case ID --limit-cases N\nstatus/validate/report: --run data/runs/ID",
    );
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
          ? await readJson(path.join(run, "manifest.json"))
          : command === "validate"
            ? await validateRun(run)
            : await pairwisePack.report(run);
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
  const plan = await pairwisePack.plan(config);
  if (command === "preflight") {
    console.log(JSON.stringify(plan.summary, null, 2));
    if ((plan.summary.issues as unknown[]).length) process.exitCode = 2;
    return;
  }
  if (command !== "run") throw new Error("Unknown command");
  if (!plan.tasks.length) throw new Error("没有可评配对，请先查看 preflight");
  if (values.resume && !values["run-id"]) throw new Error("--resume requires --run-id");
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
      cacheDir: config.cacheDir,
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
      resume: values.resume,
      retryFailed: values["retry-failed"],
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
