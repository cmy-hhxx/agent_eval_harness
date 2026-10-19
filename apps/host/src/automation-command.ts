import { configurationSecrets } from "./settings.js";
import path from "node:path";
import { parseArgs } from "node:util";
import { errorText, redact, type InputDownload } from "@eval/contracts";
import { hasLiveRunOwner, readJson, replaceInputSnapshot, runLock, writeJson } from "@eval/data";
import { RemoteInputs } from "@eval/runtime/client";
import { automationDateSelected, runPipeline, sameRows, nextPublicationAt, type AutomationState } from "@eval/automations";
import { publishSnapshot, syncMongoDay } from "./automation-publication.js";
import { startAutomationDashboard } from "./automation-dashboard.js";
import { automationEvaluationConfig, loadAutomationConfig } from "./automation-config.js";
import { evaluateDay, evaluationTargets, recoverEvaluation, remoteProgress } from "./automation-evaluation.js";
import { createAutomationMonitor } from "./automation-monitor.js";
import { loadConfig } from "./config.js";
import { createAutomationModels } from "./automation-models.js";
import { logger } from "./composition.js";
import { ROOT } from "./paths.js";

export async function automationCommand(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string", default: path.join(ROOT, "configs/automations.json") },
    date: { type: "string" }, once: { type: "boolean" }, help: { type: "boolean" },
    outcome: { type: "string" }, "request-id": { type: "string" },
    dashboard: { type: "boolean" }, port: { type: "string", default: "4174" },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`automations run|check|status|retry|publish-log|resolve-log [--config FILE]
run: 持续监控、流式取数、归因、对比及改写（聚类后置）；--dashboard 同进程启动只读看板（--port 4174）；--once 只发现一轮并执行每个日期一次
publish-log: 停止流水线后立即生成并上传一条全看板累计日志，不调用模型
check: 只读检查远端与历史 run，不下载、不调用模型
status: 输出流水线状态、每阶段数量、错误和下次重试时间
retry --date YYYY-MM-DD: 停止流水线后解除该日期的重试限制和 Host 阶段暂停
resolve-log --outcome written|retry [--request-id ID]: 核实不确定的日志上传后确认已写入或允许重传
SIGINT/SIGTERM: 停止接收任务并等待 Host 保存进度；下次 run 自动恢复`);
    return;
  }
  if (!["run", "check", "status", "retry", "publish-log", "resolve-log"].includes(command) || positionals.length !== 1) throw new Error("Invalid automation command");
  if (values.once && command !== "run") throw new Error("--once only applies to run");
  if (values.dashboard && command !== "run") throw new Error("--dashboard only applies to run");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port");
  if (values.date && command !== "retry") throw new Error("--date only applies to retry");
  if ((values.outcome || values["request-id"]) && command !== "resolve-log") throw new Error("Log resolution flags only apply to resolve-log");
  const config = await loadAutomationConfig(values.config), file = path.join(config.stateDirectory, "state.json");
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
  logger.addSecrets(...configurationSecrets());
  automationEvaluationConfig(host.evaluation, config.sourceDirectory, config.fromDate, config.remoteModels);
  const remote = new RemoteInputs(config.sourceUrl, config.requestTimeoutMs, config.remoteModels);
  if (command === "check") {
    const days = (await remote.discover(AbortSignal.timeout(config.requestTimeoutMs))).filter((day) => selected(day.date));
    const entries = [];
    for (const day of days) entries.push({ ...day, ...await evaluationTargets(config, output, day) });
    console.log(JSON.stringify({ source: config.sourceUrl, stages: ["criteria", "attribution", "comparison", "rewrite"],
      rewrite: ["attribution", "comparison"], dates: entries,
      publication: { logEnabled: config.publishStatisticsLog, logIntervalHours: 4, mongo: "incremental", ...config.publication, mongoConfigured: !!process.env[config.publication.mongoUriEnv] },
    }, null, 2));
    return;
  }
  if (command === "run") {
    if (!process.env[config.publication.mongoUriEnv]) throw new Error(`Missing ${config.publication.mongoUriEnv}`);
    logger.addSecrets(process.env[config.publication.mongoUriEnv]!);
    createAutomationModels(host.models, host.automation.channels, undefined, config.channelConcurrency);
  }
  const release = await runLock(config.stateDirectory);
  let releaseSources: (() => Promise<void>) | undefined;
  let dashboard: Awaited<ReturnType<typeof startAutomationDashboard>> | undefined;
  const controller = new AbortController(), interrupt = () => controller.abort(new Error("Automation stopped"));
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
      const delivery = state.publication;
      if (!delivery || !["uncertain", "sending"].includes(delivery.log?.status ?? "")) throw new Error("No uncertain dashboard log");
      if (values.outcome === "written") {
        if (!values["request-id"]) throw new Error("--outcome written requires the verified --request-id");
        delivery.log = { ...delivery.log, status: "uploaded", requestId: values["request-id"], confirmedAt: Date.now() };
      } else if (values.outcome === "retry") delivery.log = { ...delivery.log, status: "pending" };
      else throw new Error("--outcome must be written or retry");
      delivery.status = "retry"; delivery.nextAt = 0;
      delete delivery.error;
      state.updatedAt = Date.now();
      await writeJson(file, state);
      await logger.event("log_resolved", { component: "automations", automation_id: config.id, outcome: values.outcome });
      console.log("日志状态已更新，下次 automations run 继续处理。");
      return;
    }
    if (command === "publish-log") {
      if (state.publication && ["running", "uncertain"].includes(state.publication.status))
        throw new Error("Resolve the outstanding dashboard log before publishing another snapshot");
      const now = Date.now();
      if (state.publication?.status === "completed" || !state.publication?.traceId) {
        if (state.publication?.traceId) (state.publicationHistory ??= []).push(structuredClone(state.publication));
        state.publication = { status: "pending", attempts: 0, nextAt: nextPublicationAt(now), window: now,
          traceId: `comparison-snapshot-${config.id}-${now}`, startedAt: now };
      }
      state.publication.status = "running";
      state.publication.attempts++;
      delete state.publication.error;
      const save = async () => { state.updatedAt = Date.now(); await writeJson(file, state); };
      await save();
      try {
        await publishSnapshot(config, state, save, controller.signal);
        state.publication.status = "completed"; state.publication.completedAt = Date.now(); state.publication.attempts = 0;
        state.publication.nextAt = nextPublicationAt(Date.now());
      } catch (error) {
        state.publication.status = state.publication.log?.status === "sending" ? "uncertain" : "retry";
        state.publication.error = errorText(error);
        if (state.publication.log?.status === "sending") state.publication.log.status = "uncertain";
        throw error;
      } finally { await save(); }
      console.log(JSON.stringify(state.publication));
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
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    const monitor = createAutomationMonitor(output, config.dailyComparisonLimitPerTier);
    if (values.dashboard) {
      dashboard = await startAutomationDashboard({ config, output, state: () => state, port, monitor,
        settings: { evaluatorVersion: host.evaluatorVersion, concurrency: host.evaluation.execution.concurrency } });
      console.log(`自动化看板：${dashboard.url}`);
    }
    const observe = async (current: AutomationState, signal: AbortSignal) => {
      const dates = [];
      let available = false;
      for (const job of Object.values(current.jobs)) {
        const view = await monitor(job);
        if (view.summary) {
          if (selected(job.date)) job.summary = view.summary;
          available = true;
        }
        dates.push(view.progress);
      }
      if (config.publishProgress && available)
        await remote.publish(remoteProgress(current, config.engine, dates), signal);
    };
    console.log(`Automations ${config.id}: ${config.fromDate} → ${config.sourceUrl}\n状态：${file}`);
    const exhaustedChannels = new Set<string>();
    await runPipeline(state, { ...config, once: values.once }, {
      discover: async (signal) => (await remote.discover(signal)).filter((day) => selected(day.date)),
      initialize: (day) => evaluationTargets(config, output, day),
      recover: async (job) => recoverEvaluation(config, output, job,
        (await loadConfig(config.hostConfigs)).evaluation.execution),
      save: (current) => writeJson(file, current),
      event: async (event, job, detail) => {
        const context = { automation_id: config.id, ...(job ? { date: job.date, run_id: job.runIds.join(",") } : {}) };
        if (detail) await logger.error(detail, { component: "automations", event, ...context });
        else await logger.event(event, { component: "automations", ...context });
        console.log(redact(`${new Date().toISOString()} ${event}${job ? " " + job.date : ""}${detail ? " " + detail : ""}`,
          configurationSecrets()));
      },
      sync: async (job, day, signal, beforeReplace) => {
        const locks: (() => Promise<void>)[] = [];
        try {
          for (const runId of job.runIds) locks.push(await runLock(path.join(output, runId)));
          async function* files(): AsyncGenerator<InputDownload> {
            for (const model of config.remoteModels) yield await remote.download(day, model, signal);
            const after = (await remote.discover(signal)).find((entry) => entry.date === day.date);
            if (!after || !sameRows(after.rows, day.rows)) throw new Error("Remote inputs changed during download; retrying a fresh snapshot");
          }
          return await replaceInputSnapshot(path.join(config.sourceDirectory, day.date), files(), signal, beforeReplace);
        } finally { for (const unlock of locks.reverse()) await unlock(); }
      },
      evaluate: (job, signal) => evaluateDay(config, job, signal, exhaustedChannels), observe,
      publish: config.publishStatisticsLog ? (current, save, signal) => publishSnapshot(config, current, save, signal) : undefined,
      syncMongo: (job, signal) => syncMongoDay(config, job, signal),
    }, controller.signal);
    try { await observe(state, AbortSignal.timeout(10_000)); }
    catch (error) {
      state.reportError = errorText(error);
      await logger.error(error, { component: "automations", event: "progress_failed" });
    }
    await writeJson(file, state);
    process.exitCode = controller.signal.aborted ? 130 : state.pollError || config.publishStatisticsLog && ["retry", "uncertain"].includes(state.publication?.status ?? "") || Object.values(state.jobs).filter(job => selected(job.date)).some((job) =>
      job.download !== "ready" || ["retry", "blocked", "pending"].includes(job.evaluation) ||
      job.mongo?.status === "retry") ? 2 : 0;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    try { await dashboard?.close(); }
    finally { try { await releaseSources?.(); } finally { await release(); } }
  }
}
