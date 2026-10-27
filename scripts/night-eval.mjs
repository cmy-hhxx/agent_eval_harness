#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createFileLogger, exists, readJson, runLock, writeJson } from "@eval/data";
import { lostHelper, prepareLost, registerPreparedLost } from "./night-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const priority = ["wencai", "lost", "aime"];
export const nextJob = (state, source) => state.jobs.find(job => job.source === source && job.status === "queued");

export function dailyJobs(source, frozen, output) {
  const dates = [...new Set(frozen.inputs.records.map(row => row.batch_id))].sort();
  if (dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) throw new Error("日常输入必须按业务日期分批");
  return dates.map(date => ({ source, runId: date, output, status: "queued", revisions: frozen.revisions,
    inputs: { ...frozen.inputs, records: frozen.inputs.records.filter(row => row.batch_id === date) } }));
}

export function admitLost(state, versions, output, now, intervalMs) {
  if (now < state.nextAdmissionAt) return false;
  let added = false;
  for (const delivery of state.deliveries.filter(item => !item.admitted)) {
    state.jobs.push({ source: "lost", runId: `lost-${randomUUID()}`, output, status: "queued",
      revisions: { [delivery.file]: delivery.revision },
      inputs: { versions: versions.filter(version => version.id === delivery.model).map(version =>
        ({ ...version, sources: [{ kind: "file", path: delivery.file }] })) } });
    delivery.admitted = true;
    added = true;
  }
  state.nextAdmissionAt = now + intervalMs;
  return added;
}

export function createNightDispatcher(state, { save, record, run }) {
  const active = new Map();
  return {
    pause() { for (const pause of active.values()) pause.abort(new Error("Night pipeline stopping")); },
    async step(source) {
      if (active.has(source)) throw new Error("Evaluation dispatcher is already active: " + source);
      const job = nextJob(state, source);
      if (!job) return false;
      const pause = new AbortController();
      let detail;
      active.set(source, pause);
      job.status = "running";
      delete job.error;
      await save();
      await record("evaluation_started", { source: job.source, runId: job.runId });
      try {
        const result = await run(job, pause.signal);
        job.status = result.complete ? "completed" : pause.signal.aborted ? "queued" : "failed";
        job.result = result.result;
        if (job.status === "failed") job.error = "评测未全部成功；保留成功结果和失败状态，不自动补跑";
      } catch (error) {
        job.status = "failed";
        job.error = error.message;
        detail = error.stack;
      } finally {
        active.delete(source);
      }
      await save();
      await record("evaluation_settled", { source: job.source, runId: job.runId, status: job.status, error: job.error, detail });
      return true;
    },
  };
}

export function resolveNightConfig(value, configFile) {
  const config = structuredClone(value);
  for (const key of ["runtimeRoot", "dataRoot", "settingsFile"])
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key])) throw new Error(`${key} 必须为绝对路径`);
  for (const key of ["pollSeconds", "stableSeconds", "admissionSeconds"])
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  if (!Array.isArray(config.channels) || config.channels.length !== 2 || new Set(config.channels).size !== 2 ||
      config.channels.some(channel => typeof channel !== "string" || !channel)) throw new Error("需要两个不同的评测渠道");
  for (const source of priority) {
    if (!Array.isArray(config.hostConfigs?.[source]) || !config.hostConfigs[source].length)
      throw new Error("Missing hostConfigs." + source);
    config.hostConfigs[source] = config.hostConfigs[source].map(file => path.resolve(path.dirname(configFile), file));
  }
  const aime = path.join(config.dataRoot, "1_aime");
  config.lost = { inbox: path.join(aime, "1_7z_data/lost_user"),
    inputDirectory: path.join(aime, "5_lost_user_eval_input"), cleanDirectory: path.join(aime, "6_lost_user_eval_clean"),
    targetDirectory: path.join(aime, "6_lost_user_eval_clean_slim"), stableSeconds: config.stableSeconds,
    sevenZip: config.sevenZip };
  config.outputs = { wencai: path.join(config.dataRoot, "0_wencai/eval_output/0_daily_eval"),
    lost: path.join(aime, "eval_output/3_lost_user_eval"), aime: path.join(aime, "eval_output/0_daily_eval") };
  return config;
}

export async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: "string", default: path.join(root, "configs/night-evaluation.json") },
  } });
  const command = positionals[0] ?? "check";
  if (positionals.length > 1 || !["check", "run", "status", "close-input"].includes(command))
    throw new Error("用法：node scripts/night-eval.mjs check|run|status|close-input [--config FILE]");
  const config = resolveNightConfig(await readJson(values.config), values.config);
  const directory = path.join(config.runtimeRoot, "state/night-evaluation");
  const stateFile = path.join(directory, "state.json"), closeFile = path.join(directory, "close-input.json");
  const requestFile = path.join(directory, "model-requests.json");
  if (command === "status") {
    const state = await readJson(stateFile);
    console.log(JSON.stringify({ intake: state.closed ? "closed" : "open", pending: state.pending, excludedInputs: state.excludedInputs,
      modelRequests: await exists(requestFile) ? await readJson(requestFile) : undefined,
      preparationError: state.preparationError, jobs: state.jobs.map(({ source, runId, status, error }) =>
        ({ source, runId, status, error })) }, null, 2));
    return;
  }
  if (command === "close-input") {
    if (!await exists(stateFile)) throw new Error("管线尚未初始化");
    if (!await exists(closeFile)) await writeJson(closeFile, {
      requestedAt: new Date().toISOString(), packages: (await readdir(config.lost.inbox)).filter(name => /\.7z$/i.test(name)).sort(),
    });
    console.log("已停止接收新包；截止时已在收包目录的包仍会等待上传稳定、清洗及评测。");
    return;
  }
  process.env.EVAL_CONFIG_FILE = config.settingsFile;
  process.env.EVAL_LOG_DIR = path.join(config.runtimeRoot, "log");
  process.env.EVAL_LOG_LOCK_DIR = path.join(config.runtimeRoot, "state/log-writer");
  process.env.EVAL_HOT_STATE_ROOT ??= path.join(homedir(), ".cache/eval-agent-harness/hot");
  const { freezeNightInputs, runNightBatch, createChannelRequests } = await import("../dist/apps/host/src/night-evaluation.js");
  const { loadConfig } = await import("../dist/apps/host/src/config.js");
  const { createBalancedModels } = await import("../dist/apps/host/src/balanced-models.js");
  const { configurationSecrets, readSettings, applySettings } = await import("../dist/apps/host/src/settings.js");
  const settings = await readSettings(config.settingsFile);
  const bypass = [settings.environment.NO_PROXY, settings.environment.no_proxy, process.env.NO_PROXY, process.env.no_proxy,
    "localhost", "127.0.0.1", "::1", ...Object.values(settings.channels).map(channel => new URL(channel.baseUrl).hostname)]
    .filter(Boolean).join(",");
  settings.environment.NO_PROXY = bypass;
  settings.environment.no_proxy = bypass;
  applySettings(settings);
  const hosts = {};
  for (const source of priority) {
    hosts[source] = await loadConfig(config.hostConfigs[source]);
    if (hosts[source].workflow !== (source === "wencai" ? "comparison" : "attribution")) throw new Error("Invalid workflow: " + source);
    createBalancedModels(hosts[source].models, config.channels);
  }
  const call = request => lostHelper(config.python, request);
  for (const folder of [config.lost.inbox, config.lost.inputDirectory, config.lost.cleanDirectory, config.lost.targetDirectory])
    if (!(await stat(folder)).isDirectory()) throw new Error("Not a directory: " + folder);
  const manifest = await readJson(path.join(config.lost.inputDirectory, ".extract-lost-user.json"));
  if (!manifest.files || !manifest.archives) throw new Error("Invalid extraction manifest");
  if (command === "check") {
    console.log(JSON.stringify({ source: "lost_prepared", ...await registerPreparedLost(config.lost, { records: {}, deliveries: [] }, call) }));
    for (const source of ["wencai", "aime"]) {
      const frozen = await freezeNightInputs(config.hostConfigs[source], source === "wencai" ? "comparison" : "attribution");
      console.log(JSON.stringify({ source, records: frozen.inputs.records.length, excludedInputs: frozen.excludedInputs, output: config.outputs[source] }));
    }
    for (const key of Object.keys(manifest.files)) {
      const [model, day] = key.split("/");
      console.log(JSON.stringify({ source: "lost", file: key, ...await call({ operation: "snapshot", ...config.lost, model, name: day + ".jsonl" }) }));
    }
    return;
  }
  const release = await runLock(directory);
  let releaseInput;
  const logger = createFileLogger({ directory: process.env.EVAL_LOG_DIR, lockDirectory: process.env.EVAL_LOG_LOCK_DIR,
    secrets: configurationSecrets() });
  const abort = new AbortController(), sleepAbort = new AbortController();
  let stopping = false, dispatcher, requestTimer;
  const stop = () => { stopping = true; sleepAbort.abort(); dispatcher?.pause(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const wait = ms => delay(ms, undefined, { signal: sleepAbort.signal }).catch(error => { if (!stopping) throw error; });
  try {
    releaseInput = await runLock(config.lost.inputDirectory, { createDirectory: false });
    if (!await logger.initialize()) throw new Error("统一日志初始化失败");
    const record = async (event, details = {}) => {
      if (!await logger.event(event, { component: "night-evaluation", ...details, attempt_id: randomUUID() }))
        throw new Error("统一日志写入失败");
      console.log(JSON.stringify({ event, ...details }));
    };
    let state;
    if (await exists(stateFile)) {
      state = await readJson(stateFile);
      if (!state || !Array.isArray(state.jobs) || !Array.isArray(state.deliveries) || !state.records || !state.cleaned ||
          !state.observed || !state.pending || !Number.isFinite(state.nextAdmissionAt)) throw new Error("Invalid night pipeline state");
      for (const job of state.jobs) {
        if (!priority.includes(job.source) || !["queued", "running", "completed", "failed"].includes(job.status))
          throw new Error("Invalid night job state");
        if (job.output !== config.outputs[job.source]) throw new Error("管线输出目录发生变化");
        delete job.retryAt;
        delete job.retryFailed;
        if (job.status === "running") {
          job.status = "queued"; delete job.error;
        }
      }
    } else {
      const wencai = await freezeNightInputs(config.hostConfigs.wencai, "comparison");
      const aime = await freezeNightInputs(config.hostConfigs.aime, "attribution");
      state = { jobs: [...dailyJobs("wencai", wencai, config.outputs.wencai), ...dailyJobs("aime", aime, config.outputs.aime)],
        excludedInputs: { wencai: wencai.excludedInputs, aime: aime.excludedInputs },
        observed: {}, cleaned: {}, records: {}, deliveries: [], pending: {}, nextAdmissionAt: 0 };
      await record("inputs_excluded", state.excludedInputs);
      const prepared = await registerPreparedLost(config.lost, state, call);
      if (prepared.rows) admitLost(state, hosts.lost.evaluation.inputs.versions, config.outputs.lost, Date.now(), config.admissionSeconds * 1000);
      await record("prepared_slim_registered", prepared);
    }
    let writes = Promise.resolve();
    const save = () => {
      const snapshot = structuredClone(state);
      writes = writes.then(() => writeJson(stateFile, snapshot));
      return writes;
    };
    await save();
    const requestPriorities = { comparison: 0, "attribution-session": 1, "attribution-trace": 2,
      "attribution-component": 3, criteria: 4 };
    const requests = createChannelRequests(Object.fromEntries(config.channels.map(channel => [channel, 200])),
      { wencai: 7, lost: 2, aime: 1 }, context => requestPriorities[context.stage] ?? 5);
    const writeRequests = () => writeJson(requestFile, requests.snapshot());
    await writeRequests();
    requestTimer = setInterval(() => { void writeRequests().catch(error => logger.error(error,
      { component: "night-evaluation", event: "request_metrics_failed" })); }, 10_000);
    dispatcher = createNightDispatcher(state, { save, record, run: (job, pauseSignal) => runNightBatch({
      ...job, configs: config.hostConfigs[job.source], workflow: job.source === "wencai" ? "comparison" : "attribution",
      channels: config.channels, requests: { concurrency: requests.concurrency,
        acquire: (context, signal) => requests.acquire({ ...context, trafficGroup: job.source }, signal) },
      signal: abort.signal, pauseSignal,
    }) });
    let dataReady = false;
    const prepare = async () => {
      do {
        try {
          if (await exists(closeFile)) state.closed = await readJson(closeFile);
          dataReady = false;
          dataReady = await prepareLost(config.lost, state, save, record, call, () => stopping);
          delete state.preparationError;
          if (state.closed) state.nextAdmissionAt = 0;
          admitLost(state, hosts.lost.evaluation.inputs.versions, config.outputs.lost, Date.now(), config.admissionSeconds * 1000);
          await save();
        } catch (error) {
          state.preparationError = error.message;
          await save();
          await record("preparation_failed", { error: error.message });
        }
        if (!stopping) await wait(config.pollSeconds * 1000);
      } while (!stopping);
    };
    const evaluate = async source => {
      while (!stopping) {
        if (await dispatcher.step(source)) continue;
        if (state.closed && dataReady && !state.preparationError && state.deliveries.every(item => item.admitted) &&
            state.jobs.every(job => ["completed", "failed"].includes(job.status)) && !stopping) {
          stop();
          const failed = state.jobs.filter(job => job.status === "failed").length;
          await record(failed ? "finished_with_failures" : "completed", { jobs: state.jobs.length, failed }); break;
        }
        await wait(1000);
      }
    };
    const guard = task => task.catch(error => { stop(); abort.abort(error); throw error; });
    const outcomes = await Promise.allSettled([guard(prepare()), ...priority.map(source => guard(evaluate(source)))]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    await save();
    await writeRequests();
    await record("stopped", { closed: Boolean(state.closed), failed: state.jobs.filter(job => job.status === "failed").length });
  } finally {
    clearInterval(requestTimer);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await releaseInput?.();
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
