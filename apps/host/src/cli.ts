import { configurationSecrets } from "./settings.js";
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./paths.js";
import { errorText, redact } from "@eval/contracts";
import { readJson, exists, runLayout, runLock } from "@eval/data";
import { boundProfiles, createModelResolver, loadConfig, testEvaluationOutput } from "@eval/host-app/config";
import { services, agents, logger } from "./composition.js";
import { comparisonWorkflow, selectDataset, prepareComparisonRewrites, prepareComparisonVerification, prepareDeferredClustering, prepareFailedTasks, readRunTasks, reviewProblemOccurrences } from "@eval/workflows/comparison";
import { indexDataset, selectDatasetInputs } from "@eval/workflows/inputs";
import { reportRun, reportStability } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { validateRun, validateClusteringJob, reportClusteringJob } from "@eval/workflows/comparison";
import { runClusteringCommand } from "./clustering-command.js";
import { runAttributionCommand } from "./attribution-command.js";
import { readAttributionWorkflowCommand, runAttributionWorkflowCommand } from "./attribution-workflow-command.js";
import { runStabilityCommand } from "./stability-command.js";
import { runModelProbe } from "./model-probe.js";
import { createBalancedModels } from "./balanced-models.js";
import { startDashboard } from "./dashboard.js";
import { pilotTaskIds, comparisonRewriteReview, readRunState } from "@eval/workflows/comparison";

let logRunId: string | undefined;
async function main(): Promise<void> {
  await logger.initialize();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", multiple: true, default: [path.join(ROOT, "configs/host.json")] },
      "run-id": { type: "string" },
      run: { type: "string", multiple: true },
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
      execute: { type: "boolean" },
      cases: { type: "string" },
      stage: { type: "string" },
      "max-attempts": { type: "string" },
      "stop-starting-at": { type: "string" },
      seed: { type: "string" },
      "review-file": { type: "string" },
      "clustering-selection": { type: "string" },
      "discover-inputs": { type: "boolean" },
      "resume-stage": { type: "string", multiple: true },
      "require-rewrite": { type: "string", multiple: true },
      "require-batch": { type: "string", multiple: true },
      "pilot-cases": { type: "string" },
      "test-eval": { type: "boolean" },
      "pilot-answers": { type: "string" },
      "pilot-per-model": { type: "string" },
      "from-date": { type: "string" },
      "balance-channels": { type: "boolean" },
      selected: { type: "boolean" },
      port: { type: "string", default: "4173" },
      "dashboard-settings": { type: "string" },
    },
  });
  const command = positionals[0];
  const selectedRun = values.run?.[0];
  if (!["cluster", "reattribute"].includes(command!) && (values.run?.length ?? 0) > 1) throw new Error("只有 cluster 和 reattribute 支持多个 --run");
  logRunId = values["run-id"] || (selectedRun ? path.basename(path.resolve(selectedRun)) : undefined);
  if (values.help || !command) {
    console.log(
      `eval index|preflight|run|reattribute|status|validate|report|cluster|verify-comparisons|validate-stability|model-probe|retry-failed|recluster|review-problem-occurrences|rewrite-comparisons|rewrite-review|concurrency|progress|dashboard [--config FILE ...]
run: --run-id ID [--debug] [--worker URL ...]
配置文件按顺序深度合并；具体模型放在不入库的 --config 中
相同 run-id 自动续跑，已完成结果保留；--debug 额外保存 _internal/
selection: --batch ID --case ID --limit-cases N
test: run --test-eval；pilot-cases N 自动进入同来源 test_eval；续跑保留 --test-eval
recovery: run --resume-stage STAGE 解除已修复阶段的熔断，可重复
inputs/output: --input ID=PATH --output DIR
index: --dataset ID --dataset-name NAME --input VERSION=PATH ... [--catalog DIR]
preflight/run: --dataset ID [--catalog DIR] 选择已索引的评测集
status/validate/report: --run /mnt/fin_bench/eval_data/0_wencai/eval_output/0_daily_eval/ID
validate: [--require-rewrite items|verdicts ...] [--require-batch ID ...] [--selected]
report: [--details] 为 debug 运行导出逐题 JSON 与任务状态
retry-failed: --run PATH [--task ID ...|--result ID ...] [--apply]
cluster: --run PATH ... --run-id ID [--apply] 跨 run 按模型聚类；--apply 启动作业
cluster: --run-id ID --apply 续跑独立聚类作业（无需重复指定来源）
reattribute: --run PATH ... --run-id ID --from-date YYYY-MM-DD [--pilot-answers N] [--apply]
reattribute: --run-id ID --apply 续跑；验收后 --discover-inputs 释放完整计划
reattribute: --run-id ID --pilot-per-model N [--apply] 保留已选回答，按模型配额扩大有限试跑
channels: run|reattribute|cluster --balance-channels 按 traffic_weight 加权分配完整任务
verify-comparisons: --run PATH [--result ID ...] [--apply] 独立复核已接受的对局
validate-stability: --cases FILE|--run PATH --run-id EXPERIMENT [--execute] [--max-attempts N]
  [--stop-starting-at ISO_DATE_WITH_OFFSET] [--seed N]；默认预览，重复同一实验 ID 续跑
model-probe: [--stage comparison] [--execute]；默认只显示脱敏计划
recluster: --run PATH [--task ID ...|--all] [--apply] 重新归类已接受的延期观察
review-problem-occurrences: --review-file FILE [--apply] 默认只读预览，--apply 仅追加明确来源复核事件
rewrite-comparisons: --run PATH [--scope items|verdicts] [--mode missing|refresh]
  [--task ID ...|--result ID ...|--all] [--slot ID ...] [--apply]
聚类命令默认仅预览，--apply 执行；复核和修复 --apply 保存范围，随后同 run-id 续跑
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
  if (values.debug && !["run", "cluster", "reattribute", "validate-stability"].includes(command)) throw new Error("--debug 仅用于运行命令");
  if (values["test-eval"] && command !== "run") throw new Error("--test-eval 仅用于 run");
  for (const flag of ["discover-inputs", "resume-stage", "pilot-cases"] as const)
    if (values[flag] && command !== "run" && !(flag !== "pilot-cases" && command === "reattribute") &&
      !(flag === "resume-stage" && ["cluster", "validate-stability"].includes(command))) throw new Error(`--${flag} 不适用于当前命令`);
  if (values.execute && !["model-probe", "validate-stability"].includes(command)) throw new Error("--execute 仅用于 model-probe 或 validate-stability");
  if (values.stage && !["model-probe", "run", "preflight"].includes(command)) throw new Error("--stage 仅用于 model-probe");
  for (const flag of ["cases", "max-attempts", "stop-starting-at", "seed"] as const)
    if (values[flag] !== undefined && command !== "validate-stability") throw new Error(`--${flag} 仅用于 validate-stability`);
  for (const flag of ["pilot-answers", "pilot-per-model", "from-date"] as const)
    if (values[flag] && command !== "reattribute") throw new Error(`--${flag} 仅用于 reattribute`);
  if (values["balance-channels"] && !["run", "reattribute", "cluster"].includes(command))
    throw new Error("--balance-channels 仅用于 run、reattribute 或 cluster");
  for (const flag of ["require-rewrite", "require-batch", "selected"] as const)
    if (values[flag] && command !== "validate") throw new Error(`--${flag} 仅用于 validate`);
  if (values.result && !["rewrite-comparisons", "retry-failed", "rewrite-review", "verify-comparisons"].includes(command))
    throw new Error("--result 仅用于对比修复、复核或 rewrite-review");
  if (values["review-file"] && command !== "review-problem-occurrences") throw new Error("--review-file 仅用于 review-problem-occurrences");
  if (values.apply && !["reattribute", "cluster", "verify-comparisons", "rewrite-comparisons", "retry-failed", "recluster", "review-problem-occurrences"].includes(command)) throw new Error("--apply 仅用于重归因、修复、聚类或复核命令");
  for (const flag of ["task"] as const)
    if (values[flag] && !["rewrite-comparisons", "retry-failed", "recluster"].includes(command)) throw new Error(`--${flag} 仅用于修复命令`);
  if (values.all && !["rewrite-comparisons", "recluster"].includes(command)) throw new Error("--all 仅用于 rewrite-comparisons 或 recluster");
  for (const flag of ["mode", "slot"] as const)
    if (values[flag] && command !== "rewrite-comparisons") throw new Error(`--${flag} 仅用于 rewrite-comparisons`);
  if (values["skip-failed"] && command !== "run") throw new Error("--skip-failed 仅用于 run");
  if (values["dashboard-settings"] && command !== "run") throw new Error("--dashboard-settings 仅用于 run");
  if (command === "concurrency" || command === "progress") {
    if (!selectedRun) throw new Error("--run required");
    const lock = await readJson<{ url: string; token: string }>(
      path.join(path.resolve(selectedRun), ".run-lock"),
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
  if (command === "verify-comparisons") {
    if (!selectedRun) throw new Error("--run required");
    console.log(JSON.stringify(await prepareComparisonVerification(path.resolve(selectedRun), { resultIds: values.result, apply: values.apply }), null, 2));
    return;
  }
  if (command === "recluster") {
    if (!selectedRun) throw new Error("--run required");
    console.log(JSON.stringify(await prepareDeferredClustering(path.resolve(selectedRun), {
      taskIds: values.task, all: values.all, apply: values.apply,
    }), null, 2));
    return;
  }
  if (command === "rewrite-review") {
    if (!selectedRun) throw new Error("--run required");
    const run = path.resolve(selectedRun), release = await runLock(run);
    try { console.log(JSON.stringify(comparisonRewriteReview(await readRunState(run), values.result, Number(values["limit-cases"] ?? 50)), null, 2)); }
    finally { await release(); }
    return;
  }
  if (command === "rewrite-comparisons" || command === "retry-failed") {
    if (!selectedRun) throw new Error("--run required");
    const selection = { taskIds: values.task, resultIds: values.result, apply: values.apply };
    if (command === "retry-failed") {
      console.log(JSON.stringify(await prepareFailedTasks(path.resolve(selectedRun), selection), null, 2));
      return;
    }
    const scope = values.scope || "items";
    if (scope !== "items" && scope !== "verdicts") throw new Error("--scope 必须为 items 或 verdicts");
    const mode = values.mode || "missing";
    if (mode !== "missing" && mode !== "refresh") throw new Error("--mode 必须为 missing 或 refresh");
    console.log(JSON.stringify(await prepareComparisonRewrites(path.resolve(selectedRun), {
      ...selection, scope, mode, all: values.all, slotIds: values.slot,
    }), null, 2));
    return;
  }
  if (["status", "validate", "report"].includes(command)) {
    if (!selectedRun) throw new Error("--run required");
    const run = path.resolve(selectedRun);
    const release = command === "status" ? async () => {} : await runLock(run);
    let result;
    try {
      const checkpoint = await readJson<{
        workflow?: string;
        kind?: string;
        manifest?: { config?: { stability?: unknown } };
      }>(path.join(run, "state.json"));
      const isStability = command === "report" && Boolean(checkpoint.manifest?.config?.stability);
      result =
        checkpoint.kind === "clustering-job"
          ? command === "status" ? checkpoint
            : command === "validate" ? await validateClusteringJob(run, readRunTasks)
            : await reportClusteringJob(run, readRunTasks)
          : checkpoint.workflow === "attribution"
          ? await readAttributionWorkflowCommand(command as "status" | "validate", run)
          : command === "status"
          ? checkpoint
          : command === "validate"
            ? await validateRun(run, (binding, result, audit) => agents.validate(binding, result, audit), {
              rewriteScopes: values["require-rewrite"], batchIds: values["require-batch"],
              selectedOnly: values.selected,
            })
            : isStability ? await reportStability(run) : await reportRun(run, { details: values.details });
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
    undefined,
    values["dashboard-settings"] ? JSON.parse(values["dashboard-settings"]) : undefined,
  );
  logger.addSecrets(...configurationSecrets());
  if (values.stage && host.workflow !== "attribution" && command !== "model-probe") throw new Error("--stage 只用于Attribution或model-probe");
  if (command === "model-probe") {
    const result = await runModelProbe({ configPaths: values.config, stage: values.stage, execute: values.execute });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed") process.exitCode = 2;
    return;
  }
  if (host.workflow === "attribution" && !["run", "preflight", "index"].includes(command))
    throw new Error("Attribution 使用 run、preflight、status 或 validate");
  if (command === "validate-stability") {
    if (values.input || values.batch || values.case || values["limit-cases"])
      throw new Error("validate-stability 使用 --cases 固定样本清单或 --run 选择已接受来源");
    const deadline = values["stop-starting-at"];
    if (deadline && !/(Z|[+-]\d\d:\d\d)$/u.test(deadline)) throw new Error("--stop-starting-at 须包含 Z 或时区偏移");
    process.exitCode = await runStabilityCommand(host, { cases: values.cases, sourceRun: selectedRun,
      runId: values["run-id"], output: values.output, apply: values.execute,
      debug: values.debug, workers: values.worker, resumeStages: values["resume-stage"],
      maxAttempts: values["max-attempts"] === undefined ? undefined : Number(values["max-attempts"]),
      stopStartingAt: deadline === undefined ? undefined : Date.parse(deadline),
      seed: values.seed === undefined ? undefined : Number(values.seed) });
    return;
  }
  if (command === "reattribute") {
    if (values.input || values.batch || values.case || values["limit-cases"] || values.dataset)
      throw new Error("reattribute 从正式对比结果选择回答，使用 --run、--from-date 和 --pilot-answers");
    process.exitCode = await runAttributionCommand(host, { runs: values.run, runId: values["run-id"],
      output: values.output, fromDate: values["from-date"], pilotAnswers: values["pilot-answers"] === undefined ? undefined : Number(values["pilot-answers"]),
      pilotPerModel: values["pilot-per-model"] === undefined ? undefined : Number(values["pilot-per-model"]),
      apply: values.apply, debug: values.debug, workers: values.worker,
      resumeStages: values["resume-stage"], discoverInputs: values["discover-inputs"], balanceChannels: values["balance-channels"] });
    return;
  }
  if (values["clustering-selection"] && command !== "cluster") throw new Error("--clustering-selection 仅用于 cluster");
  if (command === "cluster") {
    if (values.input || values.batch || values.case || values["limit-cases"] || values.dataset)
      throw new Error("cluster 通过多个 --run 选择已接受归因，不接受原始输入筛选");
    process.exitCode = await runClusteringCommand(host, { selectionFile: values["clustering-selection"], runs: values.run, runId: values["run-id"],
      output: values.output, apply: values.apply, debug: values.debug,
      workers: values.worker, resumeStages: values["resume-stage"], balanceChannels: values["balance-channels"] });
    return;
  }
  if (command === "review-problem-occurrences") {
    if (host.workflow !== "comparison") throw new Error("问题样本复核需要对战工作流配置");
    if (!values["review-file"]) throw new Error("--review-file required");
    if (selectedRun || values["run-id"] || values.input || values.output || values.batch || values.case || values["limit-cases"])
      throw new Error("问题样本复核使用配置和原登记来源，不接受运行或输入选择覆盖");
    const decision = await readJson<import("@eval/agents/clustering").ProblemOccurrenceReviewDecision>(path.resolve(values["review-file"]));
    console.log(JSON.stringify(await reviewProblemOccurrences(host.evaluation, decision, {
      apply: values.apply, evaluatorVersion: host.evaluatorVersion,
    }), null, 2));
    return;
  }
  let config = host.evaluation;
  if (values["test-eval"] || values["pilot-cases"]) {
    config.output = { kind: "directory", path: testEvaluationOutput(config.output.path, values.output) };
  } else if (values.output) config.output = { kind: "directory", path: path.resolve(values.output) };
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
  else if (values.dataset) config = "workflow" in config
    ? await selectDatasetInputs(config, catalogRoot, values.dataset)
    : await selectDataset(config, catalogRoot, values.dataset);
  for (const profile of boundProfiles(host.models))
    logger.addSecrets(process.env[profile.apiKeyEnv] || "");
  if (values.batch) config.inputs.batches = values.batch;
  if (values.case) config.inputs.case_ids = values.case;
  if (values["limit-cases"]) {
    const limit = Number(values["limit-cases"]);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit-cases must be positive");
    config.inputs.limit = limit;
  }
  if ("workflow" in config && config.workflow === "attribution") {
    process.exitCode = await runAttributionWorkflowCommand({ ...host, workflow: "attribution", evaluation: config }, {
      command, runId: values["run-id"], debug: values.debug, workers: values.worker,
      discoverInputs: values["discover-inputs"], resumeStages: values["resume-stage"], balanceChannels: values["balance-channels"],
    });
    return;
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
  const engine = "pi" as const;
  const routing = values["balance-channels"] ? createBalancedModels(host.models) : { modelForStage: createModelResolver(host.models) };
  const { modelForStage } = routing;
  for (const stage of Object.keys(host.models.bindings)) modelForStage(stage);
  for (const profile of boundProfiles(host.models))
    if (!process.env[profile.apiKeyEnv])
      throw new Error(`Missing ${profile.apiKeyEnv}; configure the model key in config.ini`);
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
      ...routing,
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
  console.error(redact(errorText(error), configurationSecrets()));
  process.exitCode = 2;
});
