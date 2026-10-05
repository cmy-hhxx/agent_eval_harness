import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Engine } from "@eval/contracts";
import { ROOT } from "./paths.js";
import { errorText, redact } from "@eval/contracts";
import { readJson, exists, runLayout, runLock } from "@eval/data";
import { boundProfiles, createModelResolver, loadConfig } from "@eval/host-app/config";
import { services, agents, logger } from "./composition.js";
import { comparisonWorkflow, indexDataset, selectDataset, prepareComparisonRewrites, prepareDeferredClustering, prepareFailedTasks, reviewProblemOccurrences } from "@eval/workflows/comparison";
import { reportRun } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { validateRun } from "@eval/workflows/comparison";
import { startDashboard } from "./dashboard.js";
import { pilotTaskIds, comparisonRewriteReview, readRunState } from "@eval/workflows/comparison";

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
      dataset: { type: "string" },
      "dataset-name": { type: "string" },
      catalog: { type: "string" },
      debug: { type: "boolean" },
      "skip-failed": { type: "boolean" },
      batch: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      "limit-cases": { type: "string" },
      worker: { type: "string", multiple: true },
      help: { type: "boolean" },
      details: { type: "boolean" },
      value: { type: "string" },
      scope: { type: "string" },
      mode: { type: "string" },
      task: { type: "string", multiple: true },
      result: { type: "string", multiple: true },
      slot: { type: "string", multiple: true },
      all: { type: "boolean" },
      apply: { type: "boolean" },
      "review-file": { type: "string" },
      "discover-inputs": { type: "boolean" },
      "resume-stage": { type: "string", multiple: true },
      "require-rewrite": { type: "string", multiple: true },
      "require-batch": { type: "string", multiple: true },
      "pilot-cases": { type: "string" },
      selected: { type: "boolean" },
      port: { type: "string", default: "4173" },
      "dashboard-settings": { type: "string" },
    },
  });
  const command = positionals[0];
  logRunId = values["run-id"] || (values.run ? path.basename(path.resolve(values.run)) : undefined);
  if (values.help || !command) {
    console.log(
      `eval index|preflight|run|status|validate|report|retry-failed|recluster|review-problem-occurrences|rewrite-comparisons|rewrite-review|concurrency|progress|dashboard [--config FILE ...]
run: --engine pi|prime --run-id ID [--debug] [--worker URL ...]
配置文件按顺序深度合并；具体模型放在不入库的 --config 中
相同 run-id 自动续跑，已完成结果保留；--debug 额外保存 _internal/
selection: --batch ID --case ID --limit-cases N
pilot: run --pilot-cases N；验收后 run --discover-inputs 释放其余任务
recovery: run --resume-stage STAGE 解除已修复阶段的熔断，可重复
inputs/output: --input ID=PATH --output DIR
index: --dataset ID --dataset-name NAME --input VERSION=PATH ... [--catalog DIR]
preflight/run: --dataset ID [--catalog DIR] 选择已索引的评测集
status/validate/report: --run data/runs/comparison/ID
validate: [--require-rewrite items|verdicts ...] [--require-batch ID ...] [--selected]
report: [--details] 为 debug 运行导出逐题 JSON 与任务状态
retry-failed: --run PATH [--task ID ...|--result ID ...] [--apply]
recluster: --run PATH [--task ID ...|--all] [--apply] 重新归类已接受的延期观察
review-problem-occurrences: --review-file FILE [--apply] 默认只读预览，--apply 仅追加明确来源复核事件
rewrite-comparisons: --run PATH [--scope items|verdicts] [--mode missing|refresh]
  [--task ID ...|--result ID ...|--all] [--slot ID ...] [--apply]
任务修复命令默认仅预览；--apply 保存固定任务范围，随后同 run-id 续跑
rewrite-review: --run PATH [--result ID ...] [--limit-cases N] 输出原文和改写供语义验收
concurrency: --run PATH --value N
progress: --run PATH
dashboard: --port 4173 在本机启动控制看板`,
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
  if (values["dataset-name"] && command !== "index") throw new Error("--dataset-name 仅用于 index");
  if (values.dataset && !["index", "preflight", "run"].includes(command))
    throw new Error("--dataset 仅用于 index、preflight 和 run");
  if (values.catalog && !values.dataset) throw new Error("--catalog 需要同时指定 --dataset");
  if (values.debug && command !== "run") throw new Error("--debug 仅用于 run");
  for (const flag of ["discover-inputs", "resume-stage", "pilot-cases"] as const)
    if (values[flag] && command !== "run") throw new Error(`--${flag} 仅用于 run`);
  for (const flag of ["require-rewrite", "require-batch", "selected"] as const)
    if (values[flag] && command !== "validate") throw new Error(`--${flag} 仅用于 validate`);
  if (values.result && !["rewrite-comparisons", "retry-failed", "rewrite-review"].includes(command))
    throw new Error("--result 仅用于修复或 rewrite-review");
  if (values["review-file"] && command !== "review-problem-occurrences") throw new Error("--review-file 仅用于 review-problem-occurrences");
  if (values.apply && !["rewrite-comparisons", "retry-failed", "recluster", "review-problem-occurrences"].includes(command)) throw new Error("--apply 仅用于修复或问题样本复核命令");
  for (const flag of ["task"] as const)
    if (values[flag] && !["rewrite-comparisons", "retry-failed", "recluster"].includes(command)) throw new Error(`--${flag} 仅用于修复命令`);
  if (values.all && !["rewrite-comparisons", "recluster"].includes(command)) throw new Error("--all 仅用于 rewrite-comparisons 或 recluster");
  for (const flag of ["mode", "slot"] as const)
    if (values[flag] && command !== "rewrite-comparisons") throw new Error(`--${flag} 仅用于 rewrite-comparisons`);
  if (values["skip-failed"] && command !== "run") throw new Error("--skip-failed 仅用于 run");
  if (values["dashboard-settings"] && command !== "run") throw new Error("--dashboard-settings 仅用于 run");
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
  if (values.scope && command !== "rewrite-comparisons") throw new Error("--scope 仅用于 rewrite-comparisons");
  if (command === "recluster") {
    if (!values.run) throw new Error("--run required");
    console.log(JSON.stringify(await prepareDeferredClustering(path.resolve(values.run), {
      taskIds: values.task, all: values.all, apply: values.apply,
    }), null, 2));
    return;
  }
  if (command === "rewrite-review") {
    if (!values.run) throw new Error("--run required");
    const run = path.resolve(values.run), release = await runLock(run);
    try { console.log(JSON.stringify(comparisonRewriteReview(await readRunState(run), values.result, Number(values["limit-cases"] ?? 50)), null, 2)); }
    finally { await release(); }
    return;
  }
  if (command === "rewrite-comparisons" || command === "retry-failed") {
    if (!values.run) throw new Error("--run required");
    const selection = { taskIds: values.task, resultIds: values.result, apply: values.apply };
    if (command === "retry-failed") {
      console.log(JSON.stringify(await prepareFailedTasks(path.resolve(values.run), selection), null, 2));
      return;
    }
    const scope = values.scope || "items";
    if (scope !== "items" && scope !== "verdicts") throw new Error("--scope 必须为 items 或 verdicts");
    const mode = values.mode || "missing";
    if (mode !== "missing" && mode !== "refresh") throw new Error("--mode 必须为 missing 或 refresh");
    console.log(JSON.stringify(await prepareComparisonRewrites(path.resolve(values.run), {
      ...selection, scope, mode, all: values.all, slotIds: values.slot,
    }), null, 2));
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
            ? await validateRun(run, (binding, result, audit) => agents.validate(binding, result, audit), {
              rewriteScopes: values["require-rewrite"], batchIds: values["require-batch"],
              selectedOnly: values.selected,
            })
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
  const host = await loadConfig(
    values.config,
    process.env,
    values["dashboard-settings"] ? JSON.parse(values["dashboard-settings"]) : undefined,
  );
  if (command === "review-problem-occurrences") {
    if (!values["review-file"]) throw new Error("--review-file required");
    if (values.run || values["run-id"] || values.input || values.output || values.batch || values.case || values["limit-cases"])
      throw new Error("问题样本复核使用配置和原登记来源，不接受运行或输入选择覆盖");
    const decision = await readJson<import("@eval/agents/clustering").ProblemOccurrenceReviewDecision>(path.resolve(values["review-file"]));
    console.log(JSON.stringify(await reviewProblemOccurrences(host.evaluation, decision, {
      apply: values.apply, evaluatorVersion: host.evaluatorVersion,
    }), null, 2));
    return;
  }
  let config = host.evaluation;
  if (values.output) config.output = { kind: "directory", path: path.resolve(values.output) };
  const resuming = command === "run" && !!values["run-id"] &&
    await exists(runLayout(config.output, values["run-id"]).stateFile);
  if (values["pilot-cases"] && (resuming || values["discover-inputs"]))
    throw new Error("--pilot-cases 只用于新 run；通过验收后用 --discover-inputs 释放其余任务");
  if (values["pilot-cases"] && values["limit-cases"])
    throw new Error("--pilot-cases 不与 --limit-cases 同用；试跑保留全量计划，limit-cases 会限制原始输入范围");
  if (command !== "index" && values.dataset && values.input?.length)
    throw new Error("--dataset 与 --input 不能同时使用");
  const indexedVersions = new Set<string>();
  for (const item of values.input || []) {
    const separator = item.indexOf("=");
    if (separator < 1) throw new Error("--input 需要 ID=PATH");
    const id = item.slice(0, separator),
      target = path.resolve(item.slice(separator + 1));
    const version = config.inputs.versions.find((entry) => entry.id === id);
    if (!version) throw new Error(`未知的输入版本：${id}`);
    if (indexedVersions.has(id)) throw new Error(`重复指定输入版本：${id}`);
    indexedVersions.add(id);
    const info = await stat(target).catch(() => undefined);
    if (!info) throw new Error(`输入路径不存在：${target}`);
    version.sources = [{ kind: info.isDirectory() ? "directory" : "file", path: target }];
  }
  const catalogRoot = values.catalog ? path.resolve(values.catalog) : path.join(ROOT, "data/input-catalog");
  if (command === "index") {
    if (!values.dataset || !values["dataset-name"] || !indexedVersions.size)
      throw new Error("index 需要 --dataset ID --dataset-name NAME 和至少一个 --input VERSION=PATH");
    config = { ...config, inputs: {
      ...config.inputs,
      versions: config.inputs.versions.filter((version) => indexedVersions.has(version.id)),
    } };
    const index = await indexDataset(config, catalogRoot, values.dataset, values["dataset-name"]);
    console.log(JSON.stringify(index, null, 2));
    if (index.invalid) process.exitCode = 2;
    return;
  }
  // A resumed run owns its registered source selection; a stale/missing index must not block it.
  if (values.dataset && resuming)
    console.error(`续跑使用 state.json 中的来源，忽略 --dataset ${values.dataset}`);
  else if (values.dataset) config = await selectDataset(config, catalogRoot, values.dataset);
  for (const profile of boundProfiles(host.models))
    logger.addSecrets(process.env[profile.apiKeyEnv] || "");
  if (values.batch) config.inputs.batches = values.batch;
  if (values.case) config.inputs.case_ids = values.case;
  if (values["limit-cases"]) {
    const limit = Number(values["limit-cases"]);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit-cases must be positive");
    config.inputs.limit = limit;
  }
  const plan = resuming ? { tasks: [], inputs: {}, summary: {} } :
    await comparisonWorkflow.plan(config, command === "preflight" ? { materializeInputs: false } : undefined);
  if (command === "preflight") {
    console.log(JSON.stringify({ evaluator_version: host.evaluatorVersion, ...plan.summary }, null, 2));
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
      evaluatorVersion: host.evaluatorVersion,
      config,
      ...services,
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: config.execution.concurrency,
      skipFailed: values["skip-failed"],
      discoverInputs: values["discover-inputs"],
      resumeStages: values["resume-stage"],
      failureGuard: config.execution.failureGuard,
      taskIds: values["pilot-cases"] ? pilotTaskIds(plan, Number(values["pilot-cases"])) : undefined,
      retries: config.execution.retries,
      retryDelaySeconds: config.execution.retryDelaySeconds,
      debug: values.debug,
      workerUrls: values.worker,
      signal: controller.signal,
      onProgress: console.log,
    });
    console.log(JSON.stringify(result, null, 2));
    const statuses = result.execution_task_statuses;
    process.exitCode = controller.signal.aborted
      ? 130
      : result.paused_stages.length || ["failed", "blocked", "timed_out", "cancelled", "pending", "running"].some((s) => statuses[s])
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
