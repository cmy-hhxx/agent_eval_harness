#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createFileLogger, readJson, runLock, writeJson } from "@eval/data";
import { transformFile } from "./aime-slim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = {
  wencai: { folder: "0_wencai", inbox: "A_AA_comparision_data", models: ["a_fast", "b_fast", "a_expert", "b_expert"] },
  aime: { folder: "1_aime", inbox: "online_data", models: ["aime_fast", "aime_expert"] },
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export async function signature(file) {
  const info = await stat(file, { bigint: true });
  return { size: Number(info.size), mtime_ns: String(info.mtimeNs), ctime_ns: String(info.ctimeNs),
    ino: String(info.ino), dev: String(info.dev) };
}

export function resolveConfig(config) {
  for (const name of ["dataRoot", "runtimeRoot"])
    if (typeof config[name] !== "string" || !path.isAbsolute(config[name])) throw new Error(`${name} 必须是绝对路径`);
  for (const name of ["intervalSeconds", "stableSeconds"])
    if (!Number.isFinite(config[name]) || config[name] <= 0) throw new Error(`${name} 必须大于 0`);
  if (typeof config.python !== "string" || !config.python) throw new Error("缺少 python 命令");
  if (!Array.isArray(config.sources) || config.sources.length !== 2 ||
      new Set(config.sources.map((source) => source.id)).size !== 2 || config.sources.some((source) => !sources[source.id]))
    throw new Error("sources 必须且只能包含 wencai 和 aime 日常来源");
  const resolved = config.sources.map((source) => {
    const known = sources[source.id];
    for (const name of ["cleanDirectory", "targetDirectory"])
      if (typeof source[name] !== "string" || !source[name]) throw new Error(`缺少 ${source.id}.${name}`);
    return { ...source, models: known.models,
      cleanDirectory: path.resolve(config.dataRoot, source.cleanDirectory),
      targetDirectory: path.resolve(config.dataRoot, source.targetDirectory),
      inputDirectory: path.join(config.dataRoot, known.folder, "2_daily_eval_input"),
      inbox: path.join(config.dataRoot, known.folder, "1_7z_data", known.inbox),
      dataState: path.join(config.runtimeRoot, "state/data-service", source.id),
    };
  });
  const directories = resolved.flatMap((source) => [source.cleanDirectory, source.targetDirectory, source.inputDirectory, source.inbox]);
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    if (!directory.startsWith(path.resolve(config.dataRoot) + path.sep)) throw new Error(`目录必须位于 dataRoot 内：${directory}`);
    for (const other of directories.slice(index + 1))
      if (directory === other || directory.startsWith(other + path.sep) || other.startsWith(directory + path.sep))
        throw new Error(`数据目录不能重叠：${directory} / ${other}`);
  }
  return { ...config, sources: resolved };
}

export function helper(python, request, pythonPackages) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, "data_service/auto_renew.py")], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(pythonPackages ? { PYTHONPATH: [pythonPackages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}) } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr = (stderr + value).slice(-8000); });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) reject(new Error(`数据适配失败 (${code ?? signal}): ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function scanInbox(directory, observed, stableMs, now = Date.now()) {
  const packages = [], current = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.7z$/i.test(entry.name)) continue;
    const info = await signature(path.join(directory, entry.name));
    const prior = observed[entry.name];
    const since = prior && same(prior.signature, info) ? prior.since : now;
    current[entry.name] = { signature: info, since };
    if (now - since >= stableMs) packages.push({ name: entry.name, signature: info });
  }
  return { observed: current, packages: packages.sort((left, right) => left.name.localeCompare(right.name)) };
}

export async function deliver({ source, model, name, receipt, call, record }) {
  const request = { ...source, model, name };
  const before = await call({ operation: "snapshot", ...request });
  if (!before.ready) {
    await record("cleaning_wait", { model, file: name, ...before });
    return null;
  }
  const target = path.join(source.targetDirectory, model, name);
  const output = await signature(target).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  if (receipt && same(receipt.snapshot, before) && same(receipt.output, output)) return receipt;
  await mkdir(path.dirname(target), { recursive: true });
  // Stable name makes interrupted staging disposable without touching inputs or deliveries.
  const temporary = path.join(path.dirname(target), `.auto-renew-${name}.tmp`);
  try {
    await record("slim_started", { model, file: name, inputBytes: before.clean.size });
    const rows = await transformFile(path.join(source.cleanDirectory, model, name), temporary, { verify: true });
    if (rows !== before.entry.total_lines)
      throw new Error(`清洗输出行数 ${rows} 与已完成输入行数 ${before.entry.total_lines} 不一致：${model}/${name}`);
    const published = await call({ operation: "publish", ...request, expected: before, temporary, target });
    if (!published.ready) {
      await record("slim_deferred", { model, file: name, ...published });
      return null;
    }
    const result = { snapshot: before, output: published.output, rows, deliveredAt: new Date().toISOString() };
    await record("delivered", { model, file: name, target, rows, inputBytes: before.clean.size, outputBytes: published.output.size });
    return result;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

async function readState(file) {
  const state = await readJson(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return { sources: {} };
  });
  if (!state || !state.sources || typeof state.sources !== "object" || Array.isArray(state.sources)) throw new Error(`无效断点文件：${file}`);
  for (const [id, source] of Object.entries(state.sources))
    if (!sources[id] || !source.observed || !source.deliveries) throw new Error(`无效来源断点：${id}`);
  return state;
}

async function requireDirectory(directory) {
  if (!(await stat(directory)).isDirectory()) throw new Error(`不是目录：${directory}`);
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    config: { type: "string", default: path.join(root, "configs/auto-renew.json") },
    check: { type: "boolean" }, once: { type: "boolean" },
  } });
  const config = resolveConfig(JSON.parse(await readFile(values.config, "utf8")));
  const call = (request) => helper(config.python, request, path.join(config.runtimeRoot, "python-packages"));
  await call({ operation: "check" });
  if (values.check) {
    for (const source of config.sources) {
      for (const directory of [source.inbox, source.inputDirectory, source.cleanDirectory, source.dataState]) await requireDirectory(directory);
      console.log(JSON.stringify({ source: source.id, input: source.inputDirectory, clean: source.cleanDirectory,
        target: source.targetDirectory, cleaner: await call({ operation: "monitor", ...source }) }));
      for (const model of source.models) {
        const folder = path.join(source.cleanDirectory, model);
        const files = await readdir(folder).catch((error) => { if (error.code !== "ENOENT") throw error; return []; });
        for (const name of files.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)))
          console.log(JSON.stringify({ source: source.id, model, file: name, ...await call({ operation: "snapshot", ...source, model, name }) }));
      }
    }
    return 0;
  }
  const stateDirectory = path.join(config.runtimeRoot, "state/auto-renew");
  const release = await runLock(stateDirectory);
  const stateFile = path.join(stateDirectory, "state.json");
  const logger = createFileLogger({ directory: path.join(config.runtimeRoot, "log"), lockDirectory: path.join(config.runtimeRoot, "state/log-writer") });
  let stopping = false, wake;
  const stop = () => { stopping = true; wake?.(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const record = async (event, details = {}) => {
    const waiting = event === "cleaner_observed" || event.endsWith("_wait") || event === "slim_deferred";
    const context = { component: "auto-renew", ...details,
      task_id: [details.source, details.model, details.file ?? details.package].filter(Boolean).join("/"),
      ...(waiting ? { message: details.reason ?? details.status ?? event } : { attempt_id: randomUUID() }) };
    if (!await logger.event(event, context)) throw new Error("日志写入失败，停止以避免无记录交付");
    console.log(`${new Date().toISOString()} ${event} ${JSON.stringify(details)}`);
  };
  let failed = false;
  try {
    if (!await logger.initialize()) throw new Error("无法初始化统一日志");
    const state = await readState(stateFile);
    await record("started", { sources: config.sources.map((source) => source.id), stateFile });
    do {
      failed = false;
      for (const source of config.sources) {
        if (stopping) break;
        const sourceRecord = (event, details) => record(event, { source: source.id, ...details });
        try {
          await requireDirectory(source.inbox);
          const saved = state.sources[source.id] ??= { observed: {}, deliveries: {} };
          saved.pending ??= {};
          const scan = await scanInbox(source.inbox, saved.observed, config.stableSeconds * 1000);
          saved.observed = scan.observed;
          await writeJson(stateFile, state);
          await sourceRecord("cleaner_observed", await call({ operation: "monitor", ...source }));
          if (scan.packages.length) await sourceRecord("ingest_started", { packages: scan.packages.map((item) => item.name) });
          const ingestion = await call({ operation: "ingest", id: source.id, packages: scan.packages,
            dataRoot: config.dataRoot, stateRoot: path.join(config.runtimeRoot, "state/data-service") });
          for (const event of ingestion.events) {
            await sourceRecord(event.event, event);
            if (event.event === "package_error") failed = true;
          }
          await requireDirectory(source.cleanDirectory);
          for (const model of source.models) {
            if (stopping) break;
            const folder = path.join(source.cleanDirectory, model);
            const entries = await readdir(folder, { withFileTypes: true }).catch((error) => { if (error.code !== "ENOENT") throw error; return []; });
            if (!entries.length) await sourceRecord("cleaning_wait", { model, reason: "no_cleaned_files" });
            for (const entry of entries.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))) {
              if (stopping) break;
              const key = `${model}/${entry.name}`;
              try {
                const receipt = await deliver({ source, model, name: entry.name, receipt: saved.deliveries[key], call, record: sourceRecord });
                if (receipt && receipt !== saved.deliveries[key]) {
                  saved.deliveries[key] = receipt;
                }
                if (receipt) delete saved.pending[key];
                else saved.pending[key] = { status: "waiting_for_completed_cleaning", observedAt: new Date().toISOString() };
                await writeJson(stateFile, state);
              } catch (error) {
                failed = true;
                saved.pending[key] = { status: "error", error: error.message, observedAt: new Date().toISOString() };
                await writeJson(stateFile, state);
                await sourceRecord("file_error", { model, file: entry.name, error: error.message });
              }
            }
          }
        } catch (error) {
          failed = true;
          await sourceRecord("source_error", { error: error.message });
        }
      }
      if (!stopping && !values.once) await new Promise((resolve) => {
        const timer = setTimeout(resolve, config.intervalSeconds * 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    } while (!stopping && !values.once);
    await record("stopped", { failed, reason: stopping ? "signal" : "once" });
    return failed ? 1 : 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });
