import { configurationSecrets } from "./settings.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { errorText, redact } from "@eval/contracts";
import { hasLiveRunOwner, readJson, runLock, writeJson } from "@eval/data";
import { checkMongoPredictionSources, RemoteInputs } from "@eval/runtime/client";
import { automationDateSelected, runPipeline, nextPublicationAt, type AutomationState } from "@eval/automations";
import { syncRemoteInputs } from "./automation-download.js";
import { syncMongoInputFile } from "./automation-input-publication.js";
import { createMongoResultPublisher } from "./automation-result-publication.js";
import { generateStatisticsSnapshot, syncMongoDay } from "./automation-publication.js";
import { startAutomationDashboard, type AutomationDashboardSource } from "./automation-dashboard.js";
import { automationEvaluationConfig, loadAutomationConfig, type AutomationConfig } from "./automation-config.js";
import { evaluateDay, evaluationTargets, recoverEvaluation, remoteProgress } from "./automation-evaluation.js";
import { createAutomationMonitor } from "./automation-monitor.js";
import { loadConfig } from "./config.js";
import { createAutomationModels } from "./automation-models.js";
import { automationMongoTarget, automationSourceFiles, createAutomationMongoLane, validateAutomationTasks } from "./automation-sources.js";
import { automationLlm } from "./automation-llm.js";
import { logger } from "./composition.js";
import { discoverPrediction, predictionOrigin, predictionRemoteDay, syncPrediction } from "./automation-prediction.js";
import { ROOT } from "./paths.js";
import { StatisticsDeliveryStore } from "./statistics-delivery.js";
import { createAutomationControl } from "./automation-control.js";

function automationArguments(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string", multiple: true },
    manifest: { type: "string" }, "config-dir": { type: "string" },
    date: { type: "string" }, once: { type: "boolean" }, help: { type: "boolean" },
    outcome: { type: "string" }, "request-id": { type: "string" }, "trace-id": { type: "string" },
    dashboard: { type: "boolean" }, port: { type: "string", default: "4174" },
  } });
}

export async function automationCommand(args: string[]): Promise<void> {
  const { positionals, values } = automationArguments(args);
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`automations serve|run|check|status|retry|publish-log|resolve-log [--manifest FILE] [--config-dir DIR] [--config FILE]
serve: 只启动看板；每个来源等待点击运行后持续执行，停止或进程重启后等待再次点击
run: 来源由 manifest 登记；看板按来源分配 LLM 并发，0 暂停新模型请求，非 LLM 工作继续；--config 可重复指定来源用于开发；--dashboard 在 --port（默认 4174）提供统一运行时看板；--once 每个来源只发现一轮并执行每个日期一次
publish-log: 停止流水线后立即生成并追加一条全看板累计日志，不调用模型、不直接上传
check: 只读检查远端与历史 run，不下载、不调用模型
status: 输出流水线状态、每阶段数量、错误和下次重试时间
retry --date YYYY-MM-DD: 停止流水线后解除该日期的重试限制和 Host 阶段暂停
resolve-log --outcome written|retry [--request-id ID]: 核实不确定的日志上传后确认已写入或允许重传
SIGINT/SIGTERM: 停止接收任务并等待 Host 保存进度；下次 run 自动恢复`);
    return;
  }
  if (!["serve", "run", "check", "status", "retry", "publish-log", "resolve-log"].includes(command) || positionals.length !== 1) throw new Error("Invalid automation command");
  if (values.once && command !== "run") throw new Error("--once only applies to run");
  if (values.dashboard && command !== "run") throw new Error("--dashboard only applies to run");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port");
  if (values.date && command !== "retry") throw new Error("--date only applies to retry");
  if ((values.outcome || values["request-id"] || values["trace-id"]) && command !== "resolve-log") throw new Error("Log resolution flags only apply to resolve-log");
  if (values.manifest && values.config?.length) throw new Error("--manifest and --config cannot be combined");
  const files = await automationSourceFiles({ command, configured: values.config,
    manifestFile: values.manifest, configDirectory: values["config-dir"] });
  const configs = await Promise.all(files.map(source => loadAutomationConfig(source.file)));
  validateAutomationTasks(configs);
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("Automation stopped"));
  const schedulingFile = path.resolve(process.env.EVAL_AUTOMATION_SCHEDULING_FILE || path.join(ROOT, "data/automations/scheduling.json"));
  const statisticsStore = new StatisticsDeliveryStore(path.resolve(process.env.EVAL_STATISTICS_DELIVERY_FILE ||
    path.join(ROOT, "data/automations/statistics-delivery.json")));
  const sourceNames = new Map(configs.map((config, index) => [config.id, values.config ? config.id : files[index].name]));
  const llm = ["run", "serve"].includes(command) ? await automationLlm(schedulingFile, Object.fromEntries(await Promise.all(configs.map(async config =>
    [config.id, (await loadConfig(config.hostConfigs)).evaluation.execution.concurrency] as const)))) : undefined;
  const scope = { signal: controller.signal, llm, mongo: createAutomationMongoLane(), sourceNames, statisticsStore,
    exhaustedChannels: new Set<string>(), dashboards: new Map<string, AutomationDashboardSource>() };
  if (command !== "run" && command !== "serve") {
    for (const config of configs) await executeAutomationCommand(command, values, config, scope);
    return;
  }
  let dashboard: Awaited<ReturnType<typeof startAutomationDashboard>> | undefined;
  let control: ReturnType<typeof createAutomationControl> | undefined;
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    if (command === "serve") {
      for (const config of configs) {
        const host = await loadConfig(config.hostConfigs);
        let state: AutomationState;
        try { state = await readJson(path.join(config.stateDirectory, "state.json")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          state = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} };
        }
        if (state.id !== config.id || state.sourceUrl !== config.sourceUrl || !state.jobs || Array.isArray(state.jobs))
          throw new Error("Automation state does not match this source/id");
        // Historical progress is readable, but does not grant permission to resume work.
        state.status = "stopped";
        scope.dashboards.set(config.id, { name: sourceNames.get(config.id)!, config, output: host.evaluation.output.path,
          state: () => state, settings: { evaluatorVersion: host.evaluatorVersion, concurrency: host.evaluation.execution.concurrency } });
      }
      control = createAutomationControl(configs.map(config => config.id), async (id, signal) => {
        try { await executeAutomationCommand("run", { ...values, dashboard: true }, configs.find(config => config.id === id)!, { ...scope, signal }); }
        catch (error) {
          await logger.error(error, { component: "automations", event: "source_failed", detail: id });
          throw error;
        }
      });
      dashboard = await startAutomationDashboard({ port, llm: llm!, statistics: statisticsStore, control,
        sources: () => configs.map(config => scope.dashboards.get(config.id)!) });
      console.log(`自动化看板：${dashboard.url} · 等待手动运行`);
      if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      return;
    }
    if (values.dashboard) {
      dashboard = await startAutomationDashboard({ port, llm: llm!, statistics: statisticsStore,
        sources: () => scope.dashboards.size === configs.length ? configs.map(config => scope.dashboards.get(config.id)!) : [] });
      console.log(`自动化看板：${dashboard.url}`);
    }
    const results = await Promise.allSettled(configs.map(config =>
      executeAutomationCommand(command, values, config, scope)
        .catch(error => { controller.abort(error); throw error; })));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    process.exitCode = controller.signal.aborted ? 130 : Math.max(0,
      ...results.map(result => result.status === "fulfilled" ? result.value ?? 0 : 2));
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    await control?.close();
    await dashboard?.close();
  }
}

async function executeAutomationCommand(
  command: string, values: ReturnType<typeof automationArguments>["values"], config: AutomationConfig,
  scope: { signal: AbortSignal; llm: Awaited<ReturnType<typeof automationLlm>> | undefined;
    mongo: ReturnType<typeof createAutomationMongoLane>; exhaustedChannels: Set<string>; dashboards: Map<string, AutomationDashboardSource>;
    sourceNames: Map<string, string>; statisticsStore: StatisticsDeliveryStore },
): Promise<number | void> {
  const file = path.join(config.stateDirectory, "state.json");
  if (["publish-log", "resolve-log"].includes(command) && !config.publishStatisticsLog)
    throw new Error("Statistics log publication is disabled for this automation");
  if (command === "status") {
    const state = await readJson<AutomationState>(file);
    console.log(JSON.stringify({ ...state, ownerAlive: await hasLiveRunOwner(config.stateDirectory) }, null, 2));
    return;
  }
  const selected = (date: string) => automationDateSelected(config, date);
  if (command === "retry" && values.date && !selected(values.date))
    throw new Error("Cannot retry a date outside the configured automation range: " + values.date);
  const host = await loadConfig(config.hostConfigs), output = host.evaluation.output.path;
  const mongoDestination = automationMongoTarget(config.prediction ? await predictionOrigin(config) : config);
  logger.addSecrets(...configurationSecrets());
  automationEvaluationConfig(host.evaluation, config.sourceDirectory, config.fromDate, config.remoteModels);
  const remote = config.prediction ? undefined : new RemoteInputs(config.sourceUrl, config.requestTimeoutMs, config.remoteModels);
  const discover = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return (config.prediction ? (await discoverPrediction(config, output)).days.map(predictionRemoteDay)
      : await remote!.discover(signal)).filter(day => selected(day.date));
  };
  if (command === "check") {
    const days = await discover(AbortSignal.timeout(config.requestTimeoutMs));
    const entries = [];
    for (const day of days) entries.push({ ...day, ...await evaluationTargets(config, output, day) });
    console.log(JSON.stringify({ source: config.sourceUrl, stages: ["criteria", "attribution", "comparison", "rewrite"],
      rewrite: ["attribution", "comparison"], dates: entries,
      ...(config.prediction ? { prediction: await discoverPrediction(config, output) } : {}),
      publication: { logEnabled: config.publishStatisticsLog, logIntervalHours: 4, mongo: !config.publishMongo ? "disabled" : config.prediction ? "replace_existing_results" : "incremental", ...config.publication, mongoConfigured: !!process.env[config.publication.mongoUriEnv] },
    }, null, 2));
    return;
  }
  if (command === "run") {
    if (config.publishMongo && !process.env[config.publication.mongoUriEnv]) throw new Error(`Missing ${config.publication.mongoUriEnv}`);
    if (process.env[config.publication.mongoUriEnv]) logger.addSecrets(process.env[config.publication.mongoUriEnv]!);
    createAutomationModels(host.models, host.automation.channels, undefined, config.channelConcurrency);
  }
  const release = await runLock(config.stateDirectory);
  let releaseSources: (() => Promise<void>) | undefined;
  try {
    let state: AutomationState;
    try { state = await readJson(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || command !== "run") throw error;
      state = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} };
    }
    if (state.id !== config.id || state.sourceUrl !== config.sourceUrl || !state.jobs || Array.isArray(state.jobs))
      throw new Error("Automation state does not match this source/id");
    if (command === "resolve-log") {
      if (!values["trace-id"]) throw new Error("resolve-log requires --trace-id");
      if (values.outcome === "written") {
        if (!values["request-id"]) throw new Error("--outcome written requires the verified --request-id");
        await scope.statisticsStore.resolve(values["trace-id"], { outcome: "written", requestId: values["request-id"] });
      } else if (values.outcome === "retry") await scope.statisticsStore.resolve(values["trace-id"], { outcome: "retry" });
      else throw new Error("--outcome must be written or retry");
      await logger.event("log_resolved", { component: "automations", automation_id: config.id, outcome: values.outcome });
      console.log("统计日志交付状态已更新。");
      return;
    }
    if (command === "publish-log") {
      const generated = await generateStatisticsSnapshot(config, state, scope.statisticsStore, scope.signal);
      state.statistics = { nextAt: nextPublicationAt(generated.generatedAt),
        attempts: 0, lastWindow: Math.floor(generated.generatedAt / (4 * 60 * 60_000)) * 4 * 60 * 60_000,
        lastTraceId: generated.traceId, generatedAt: generated.generatedAt };
      state.updatedAt = Date.now();
      await writeJson(file, state);
      console.log(JSON.stringify(generated));
      return;
    }
    if (command === "retry") {
      const job = state.jobs[values.date ?? ""];
      if (!job) throw new Error("retry requires a registered --date");
      job.evaluation = "pending"; job.evaluationAttempts = 0; job.nextEvaluationAt = 0;
      job.downloadAttempts = 0; job.nextDownloadAt = 0; job.resumePaused = true;
      if (job.adopted) { job.adopted = false; job.download = "pending"; }
      delete job.evaluationError;
      state.updatedAt = Date.now();
      await writeJson(file, state);
      await logger.event("retry_requested", { component: "automations", automation_id: config.id, date: job.date, run_id: job.runIds.join(",") });
      console.log(`已准备 ${job.date}，执行 automations run 续跑。`);
      return;
    }
    releaseSources = await runLock(config.sourceDirectory);
    const monitor = createAutomationMonitor(output, config.dailyComparisonLimitPerTier);
    if (values.dashboard) {
      const source = { name: scope.sourceNames.get(config.id) ?? config.id, config, output, state: () => state, monitor,
        settings: { evaluatorVersion: host.evaluatorVersion, concurrency: host.evaluation.execution.concurrency } };
      const existing = scope.dashboards.get(config.id);
      if (existing) Object.assign(existing, source);
      else scope.dashboards.set(config.id, source);
    }
    const resultPublisher = createMongoResultPublisher(config, error =>
      logger.error(error, { component: "automations", event: "mongo_result_failed" }));
    const observe = async (current: AutomationState, signal: AbortSignal) => {
      const dates = [];
      let available = false;
      for (const job of Object.values(current.jobs)) {
        const view = await monitor(job);
        if (view.summary) {
          if (selected(job.date)) job.summary = view.summary;
          available = true;
        }
        if (selected(job.date)) resultPublisher.observe(job, signal);
        dates.push(view.progress);
      }
      if (config.publishProgress && available)
        await remote!.publish(remoteProgress(current, config.engine, dates), signal);
    };
    console.log(`Automations ${config.id}: ${config.fromDate} → ${config.sourceUrl}\n状态：${file}`);
    await runPipeline(state, { ...config, mongoTarget: automationMongoTarget(config), once: values.once }, {
      discover,
      initialize: (day) => evaluationTargets(config, output, day),
      recover: async (job) => {
        const current = (await loadConfig(config.hostConfigs)).evaluation;
        return recoverEvaluation(config, output, job, current.execution, current.comparisons);
      },
      save: async (current) => {
        await writeJson(file, current);
      },
      event: async (event, job, detail) => {
        const context = { automation_id: config.id, ...(job ? { date: job.date, run_id: job.runIds.join(",") } : {}) };
        if (detail) await logger.error(detail, { component: "automations", event, ...context });
        else await logger.event(event, { component: "automations", ...context });
        console.log(redact(`${new Date().toISOString()} ${event}${job ? " " + job.date : ""}${detail ? " " + detail : ""}`,
          configurationSecrets()));
      },
      sync: async (job, day, signal, beforeReplace) => {
        if (config.prediction) {
          const origin = await predictionOrigin(config), settings = config.publication;
          const selected = (await discoverPrediction(config, output)).days.find(item => item.date === day.date);
          if (!selected) throw new Error("Prediction targets are no longer ready: " + day.date);
          await checkMongoPredictionSources({
            uri: process.env[settings.mongoUriEnv]!, database: settings.mongoDatabase,
            collection: settings.mongoCollection, evaluationTaskId: origin.id,
            tlsCAFile: process.env[settings.mongoTlsCAFileEnv],
          }, day.date, selected.selections.map(item => item.sourceComparisonId), signal);
          return { ...await syncPrediction(config, output, day.date, beforeReplace), rows: day.rows };
        }
        return syncRemoteInputs(remote!, path.join(config.sourceDirectory, day.date), output, job, day, signal, beforeReplace,
          config.publishMongo ? async (file, model) => {
            const receipt = await syncMongoInputFile(config, day.date, model, file, signal, scope.mongo, undefined, host);
            await writeJson(path.join(config.stateDirectory, "input-publications", day.date, model + ".json"), {
              at: new Date().toISOString(), ...receipt,
            });
          } : undefined);
      },
      evaluationConcurrency: () => scope.llm!.concurrency(config.id),
      evaluate: (job, signal) => evaluateDay(config, job, signal, scope.exhaustedChannels, {
        concurrency: () => Math.ceil(scope.llm!.concurrency(config.id) /
          Math.max(1, Object.values(state.jobs).filter(job => job.evaluation === "evaluating").length)),
        acquire: (context, signal) => scope.llm!.acquire(config.id, job.date, context, signal),
      }), observe,
      publish: config.publishStatisticsLog ? (current, _save, signal) =>
        generateStatisticsSnapshot(config, current, scope.statisticsStore, signal) : undefined,
      syncMongo: config.publishMongo ? (job, signal) => scope.mongo(() => syncMongoDay(config, job, signal), signal, JSON.stringify([mongoDestination, job.date])) : undefined,
    }, scope.signal);
    await resultPublisher.settled();
    try { if (!scope.signal.aborted) await observe(state, AbortSignal.timeout(10_000)); }
    catch (error) {
      state.reportError = errorText(error);
      await logger.error(error, { component: "automations", event: "progress_failed" });
    }
    await writeJson(file, state);
    return scope.signal.aborted ? 130 : state.pollError || config.publishStatisticsLog && Boolean(state.statistics?.error) || Object.values(state.jobs).filter(job => selected(job.date)).some((job) =>
      job.download !== "ready" || ["retry", "blocked", "pending"].includes(job.evaluation) ||
      config.publishMongo && job.mongo?.status === "retry") ? 2 : 0;
  } finally {
    try { await releaseSources?.(); } finally { await release(); }
  }
}
