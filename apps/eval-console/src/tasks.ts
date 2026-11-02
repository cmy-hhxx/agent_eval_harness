import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError, errorText } from "@eval/contracts";
import { businessBatch, localFiles, readJson, writeJson } from "@eval/data";
import { createChannelRequests } from "@eval/host";
import { createBalancedModels } from "@eval/host-app/config";
import { loadConfig, readConfigSources, type HostConfig } from "@eval/host-app/config";
import { logger } from "@eval/host-app/composition";
import { preflightHost } from "@eval/host-app/preflight";
import { readSettings } from "@eval/host-app/settings";

import { consolePath } from "./files.js";
import { executeConsoleTask, type Gate } from "./evaluation.js";
import { checkData, commonInputDirectory, emptyDataCheck, parentInputs, type DataCheck } from "./data-check.js";

export interface ConsolePreset {
  id: string; source: "wencai" | "aime"; name: string; configs: string[];
  concurrency: number;
}
export interface ConsoleConfig {
  hostname: string; port: number; stateDirectory: string; logDirectory: string; passwordFile: string;
  channels: string[]; presets: ConsolePreset[];
  inputStatsFile: string;
  directoryRoot: string;
}
export interface ConsoleProgress { completed: number; total: number; failed: number; }
export interface ConsoleTask {
  id: string; preset: string; source: string; name: string;
  status: "draft" | "starting" | "running" | "pausing" | "paused" | "finished" | "partial" | "failed";
  createdAt: string; updatedAt: string; concurrency: number; output: string;
  inputs: { id: string; name: string; paths: string[] }[];
  error?: string; result?: Record<string, unknown>; progress?: ConsoleProgress;
  warnings?: string[];
  inputDirectory?: string; dataCheck?: DataCheck;
  batchId?: string;
}
export class ConsoleTasks {
  readonly tasks = new Map<string, ConsoleTask>();
  private readonly active = new Map<string, { pause: AbortController; gate: Gate; done: Promise<void>; progress?: ConsoleProgress }>();
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
  private checking?: Promise<void>;
  private checkingTask?: { id: string; stop: AbortController };
  constructor(readonly config: ConsoleConfig, private readonly dependencies = {
    execute: executeConsoleTask, preflight: preflightHost,
  }) {}
  private directory(id: string) { return path.join(this.config.stateDirectory, id); }
  private configFile(id: string) { return path.join(this.directory(id), "config.json"); }
  private async load(files: string | string[]) {
    const settings = await readSettings();
    settings.environment.EVAL_LOG_DIR = this.config.logDirectory;
    settings.environment.EVAL_LOG_LOCK_DIR = path.join(this.config.stateDirectory, "log-writer");
    return loadConfig(files, settings);
  }
  private async save(task: ConsoleTask) {
    task.updatedAt = new Date().toISOString();
    await writeJson(path.join(this.directory(task.id), "task.json"), task);
    this.tasks.set(task.id, task);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  async initialize() {
    await localFiles.mkdir(this.config.stateDirectory, { recursive: true });
    for (const name of await localFiles.list(this.config.stateDirectory)) {
      if (!/^console-[0-9a-f-]{36}$/.test(name)) continue;
      let task: ConsoleTask;
      try { task = await readJson<ConsoleTask>(path.join(this.directory(name), "task.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (task.id !== name) throw new Error("Task identity mismatch: " + name);
      if (task.dataCheck?.status === "checking") {
        task.dataCheck.status = "failed"; task.dataCheck.error = "数据检查曾中断，请重新 Check data";
        await this.save(task);
      }
      if (["starting", "running", "pausing"].includes(task.status)) {
        task.status = "paused";
        task.error = "控制服务曾中断；已保存的结果保留，请手动继续";
        await this.save(task);
      }
      this.tasks.set(name, task);
    }
  }
  get(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new HttpError(404, "评测任务不存在");
    const live = this.active.get(id);
    const snapshot = live?.gate.snapshot();
    return { ...task, logs: this.logPaths(), ...(live ? { requests: { active: snapshot!.active, limit: task.concurrency },
      progress: live.progress ?? task.progress } : {}) };
  }
  logPaths() { return ["runtime.log", "evaluation.log"].map(name => path.join(this.config.logDirectory, name)); }
  async presets() {
    return Promise.all(this.config.presets.map(async preset => {
      const host = await this.load(preset.configs);
      this.assertWorkflow(preset, host);
      return { id: preset.id, source: preset.source, name: preset.name,
        inputDirectory: commonInputDirectory(host.evaluation.inputs.versions),
        concurrency: preset.concurrency, output: host.evaluation.output.path, logs: this.logPaths(),
        inputs: host.evaluation.inputs.versions.map(version => ({ id: version.id, name: version.display_name || version.name,
          paths: version.sources.map(source => source.path) })) };
    }));
  }
  private assertWorkflow(preset: ConsolePreset, host: HostConfig) {
    if (host.workflow !== (preset.source === "aime" ? "attribution" : "comparison"))
      throw new Error("预设来源与评测流程不一致: " + preset.id);
  }
  async preview(value: unknown) {
    if (this.closing) throw new HttpError(409, "控制服务正在关闭");
    // Serialize preparation too, so concurrent submissions cannot launch overlapping full scans.
    return this.exclusive(async () => {
      if (this.checking) throw new HttpError(409, "已有数据检查进行中，请稍后重试");
      return this.preparePreview(value);
    });
  }
  private async preparePreview(value: unknown) {
    if (!value || typeof value !== "object") throw new HttpError(400, "配置不能为空");
    const { preset: presetId, inputs, inputDirectory, output, concurrency, batchId } = value as Record<string, unknown>;
    const preset = this.config.presets.find(item => item.id === presetId);
    if (!preset) throw new HttpError(400, "未知评测预设");
    this.checkConcurrency(concurrency);
    if (typeof batchId !== "string" || !batchId.trim()) throw new HttpError(400, "请填写缺省批次");
    const batch = businessBatch(batchId.trim());
    const host = await this.load(preset.configs);
    this.assertWorkflow(preset, host);
    if (inputDirectory !== undefined && inputs !== undefined) throw new HttpError(400, "父目录与模型路径只能选择一种输入方式");
    const discovered = inputDirectory === undefined ? undefined : await parentInputs(inputDirectory, host.evaluation.inputs.versions, [this.config.directoryRoot]);
    const entries = discovered?.inputs ?? inputs as Record<string, unknown>;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new HttpError(400, "请指定输入父目录");
    if (Object.keys(entries).length !== host.evaluation.inputs.versions.length) throw new HttpError(400, "输入模型数量与预设不符");
    const versions = await Promise.all(host.evaluation.inputs.versions.map(async version => {
      const paths = entries[version.id];
      if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, "缺少输入: " + version.name);
      return { ...version, sources: await Promise.all(paths.map(async (file, index) => {
        const source = await consolePath(file, [this.config.directoryRoot], true);
        const original = version.sources[index];
        return source.kind === "directory" && original?.kind === "directory" ? { ...original, ...source } : source;
      })) };
    }));
    const destination = await consolePath(output);
    if (discovered && (destination.path === discovered.directory || destination.path.startsWith(discovered.directory + path.sep) ||
        discovered.directory.startsWith(destination.path + path.sep))) throw new HttpError(400, "输入父目录和输出目录不能重叠");
    for (const version of versions) for (const source of version.sources) {
      const input = source.path;
      if (input === destination.path || input.startsWith(destination.path + path.sep) || destination.path.startsWith(input + path.sep))
        throw new HttpError(400, "输入和输出目录不能重叠: " + input);
    }
    const warnings = consolePathWarnings(versions, destination.path);
    if (discovered?.ignored) warnings.push("另有 " + discovered.ignored + " 个 JSONL 文件未匹配预设模型，不会读入。");
    const raw = await readConfigSources(preset.configs);
    raw.inputs = { ...host.evaluation.inputs, versions };
    (raw.inputs as Record<string, unknown>).default_batch_id = batch;
    const inputsChanged = versions.some((version, index) => JSON.stringify(version.sources.map(source => source.path)) !==
      JSON.stringify(host.evaluation.inputs.versions[index]!.sources.map(source => source.path)));
    // A finite record selection belongs to its original files. New paths must not evaluate old coordinates.
    if (inputsChanged) delete (raw.inputs as Record<string, unknown>).records;
    if (discovered) for (const key of ["records", "limit", "batches", "case_ids", "dataset_id"])
      delete (raw.inputs as Record<string, unknown>)[key];
    raw.output = { ...host.evaluation.output, path: destination.path };
    raw.execution = { ...host.evaluation.execution, concurrency, taskConcurrency: concurrency,
      modelRequestLimits: this.limits(concurrency as number) };
    const id = "console-" + randomUUID();
    // Freeze the resolved config, never the input contents or any gateway credentials.
    await writeJson(this.configFile(id), raw);
    try {
      const prepared = await this.load(this.configFile(id));
      const routing = createBalancedModels(prepared.models, this.config.channels);
      for (const stage of Object.keys(prepared.models.bindings)) routing.modelRoutesForTask({ stage });
      const issues = await this.dependencies.preflight(prepared);
      if (issues.length) throw new HttpError(400, "启动检查未通过: " + issues.map(issue => issue.check + ": " + issue.reason).join("；"));
      const task: ConsoleTask = { id, preset: preset.id, source: preset.source, name: preset.name, status: "draft",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), concurrency: concurrency as number,
        output: destination.path, warnings, inputDirectory: discovered?.directory, dataCheck: emptyDataCheck(host.workflow),
        batchId: prepared.evaluation.inputs.default_batch_id,
        inputs: versions.map(version => ({ id: version.id, name: version.display_name || version.name,
          paths: version.sources.map(source => source.path) })) };
      await this.save(task);
      this.launchCheck(task, prepared);
      return this.get(id);
    } catch (error) {
      await localFiles.remove(this.directory(id), { recursive: true, force: true });
      throw error;
    }
  }
  private launchCheck(task: ConsoleTask, host: HostConfig) {
    const id = task.id, stop = new AbortController();
    this.checkingTask = { id, stop };
    this.checking = checkData(host, task.dataCheck!, stop.signal, async issue => {
      await logger.error(new Error(issue.file + ":" + (issue.line ?? "") + " " + issue.reason),
        { component: "console", event: "console_data_check_rejected", run_id: id });
    }, id).catch(async error => {
      if (!this.tasks.has(id)) return;
      task.dataCheck!.status = "failed"; task.dataCheck!.error = errorText(error);
      await logger.error(error, { component: "console", event: "console_data_check_failed", run_id: id });
    }).finally(async () => {
      try { await this.exclusive(async () => { const current = this.tasks.get(id); if (current) await this.save(current); }); }
      finally { this.checking = undefined; this.checkingTask = undefined; }
    });
    void this.checking.catch(error => logger.error(error, { component: "console", event: "console_state_failed", run_id: id }));
  }
  async recheck(id: string) {
    return this.exclusive(async () => {
      if (this.closing || this.checking) throw new HttpError(409, "已有数据检查进行中或服务正在关闭");
      const task = this.tasks.get(id);
      if (!task || task.status !== "draft") throw new HttpError(409, "仅待启动任务可以重新检查");
      const host = await this.load(this.configFile(id));
      task.dataCheck = emptyDataCheck(host.workflow);
      await this.save(task);
      this.launchCheck(task, host);
      return this.get(id);
    });
  }
  private checkConcurrency(value: unknown): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError(400, "并发必须为正整数");
  }
  private limits(concurrency: number) {
    // Either equivalent gateway may use idle capacity; the total gate is authoritative.
    return Object.fromEntries(this.config.channels.map(channel => [channel, concurrency]));
  }
  async start(id: string) {
    return this.exclusive(async () => {
      if (this.closing) throw new HttpError(409, "控制服务正在关闭");
      this.get(id);
      const task = structuredClone(this.tasks.get(id)!);
      if (this.active.has(id) || task.status === "finished") return this.get(id);
      if (!["draft", "paused", "failed", "partial"].includes(task.status)) throw new HttpError(409, "当前状态不能启动");
      if (task.status === "draft" && task.dataCheck?.status !== "ready") throw new HttpError(409, "请先完成 Check data");
      if (task.status === "draft" && !task.dataCheck?.total) throw new HttpError(409, "没有可评测数据，请检查输入");
      if ([...this.active.keys()].some(key => this.tasks.get(key)!.output === task.output))
        throw new HttpError(409, "已有任务正在写入这个输出位置，请先暂停它");
      const host = await this.load(this.configFile(id));
      const issues = await this.dependencies.preflight(host, id);
      if (issues.length) throw new HttpError(409, issues.map(issue => issue.check + ": " + issue.reason).join("；"));
      task.status = "starting"; delete task.error; delete task.result;
      await this.save(task);
      const pause = new AbortController(), gate = createChannelRequests(this.limits(task.concurrency), undefined, undefined, undefined, task.concurrency);
      const live = { pause, gate, done: Promise.resolve(), progress: task.progress as ConsoleProgress | undefined };
      this.active.set(id, live);
      live.done = Promise.resolve().then(async () => {
        try {
          await logger.event("console_task_started", { component: "console", run_id: id });
          const result = await this.dependencies.execute({ host, id, gate, pause: pause.signal, channels: this.config.channels,
            progress: message => {
              if (message.startsWith("progress ")) {
                try {
                  const value = JSON.parse(message.slice(9));
                  live.progress = { completed: value.complete ?? 0,
                    total: ["complete", "partial", "queued", "running", "repairing", "preparing", "failed", "blocked", "cancelled"]
                      .reduce((sum, key) => sum + (value[key] ?? 0), 0),
                    failed: (value.failed ?? 0) + (value.partial ?? 0) };
                } catch { /* Host messages also contain plain progress. */ }
              }
            } });
          await this.exclusive(async () => {
            const current = this.tasks.get(id)!;
            current.result = result; current.progress = live.progress;
            const counts = result.execution_task_statuses as Record<string, number> | undefined;
            current.status = pause.signal.aborted ? "paused" : result.outcome === "partial" || result.resource_pause || result.input_issue_count || result.input_rejected ||
              (result.paused_stages as unknown[] | undefined)?.length || Object.entries(counts ?? {}).some(([key, count]) => key !== "succeeded" && count) ? "partial" : "finished";
            if (current.status === "partial") current.error = [
              result.input_issue_count ? "输入异常 " + result.input_issue_count + " 条" : "",
              counts?.failed || counts?.timed_out ? "评测失败 " + ((counts.failed ?? 0) + (counts.timed_out ?? 0)) + " 项" : "",
              result.resource_pause ? "资源等待：" + result.resource_pause : "",
            ].filter(Boolean).join("；") || "存在未完成评测，请查看日志";
            if (counts) current.progress = { completed: counts.succeeded ?? 0, total: Object.values(counts).reduce((a, b) => a + b, 0),
              failed: (counts.failed ?? 0) + (counts.timed_out ?? 0) };
            await this.save(current);
            this.active.delete(id);
          });
        } catch (error) {
          await logger.error(error, { component: "console", event: "console_task_failed", run_id: id });
          await this.exclusive(async () => {
            const current = this.tasks.get(id)!;
            current.status = "failed"; current.error = errorText(error); current.progress = live.progress;
            await this.save(current);
            this.active.delete(id);
          });
        } finally { if (this.active.get(id) === live) this.active.delete(id); }
      });
      // Persistence errors must remain visible even when the task's terminal record cannot be saved.
      void live.done.catch(error => logger.error(error, { component: "console", event: "console_state_failed", run_id: id }));
      task.status = "running";
      await this.save(task);
      return this.get(id);
    });
  }
  async pause(id: string) {
    return this.exclusive(async () => {
      const task = this.tasks.get(id); this.get(id);
      const live = this.active.get(id);
      if (live) {
        task!.status = "pausing";
        await this.save(task!);
        live.pause.abort();
        await logger.event("console_task_pausing", { component: "console", run_id: id });
      }
      return this.get(id);
    });
  }
  async concurrency(id: string, value: unknown) {
    this.checkConcurrency(value);
    return this.exclusive(async () => {
      const task = this.tasks.get(id); this.get(id);
      if (task!.status === "finished") throw new HttpError(409, "任务已经完成");
      const raw = await readJson<Record<string, unknown>>(this.configFile(id));
      raw.execution = { ...(raw.execution as object), concurrency: value, taskConcurrency: value, modelRequestLimits: this.limits(value) };
      await writeJson(this.configFile(id), raw);
      task!.concurrency = value;
      await this.save(task!);
      this.active.get(id)?.gate.setCapacity(this.limits(value), value);
      await logger.event("console_concurrency_changed", { component: "console", run_id: id, concurrency: value });
      return this.get(id);
    });
  }
  async configuration(id: string) {
    const task = this.get(id);
    return { preset: task.preset, ...(task.inputDirectory ? { inputDirectory: task.inputDirectory } :
      { inputs: Object.fromEntries(task.inputs.map(input => [input.id, input.paths])) }),
      output: task.output, concurrency: task.concurrency, batchId: task.batchId, logs: this.logPaths() };
  }
  async remove(id: string) {
    return this.exclusive(async () => {
      if (this.closing) throw new HttpError(409, "控制服务正在关闭");
      const task = this.get(id);
      if (this.active.has(id) || ["starting", "running", "pausing"].includes(task.status))
        throw new HttpError(409, "请先暂停任务，等待保存完成后再删除");
      await localFiles.remove(this.directory(id), { recursive: true, force: true });
      this.tasks.delete(id);
      if (this.checkingTask?.id === id) this.checkingTask.stop.abort(new Error("任务已删除"));
      return { id, deleted: true };
    });
  }
  async close() {
    this.closing = true;
    this.checkingTask?.stop.abort(new Error("数据检查已中断，请重新 Check data"));
    await this.checking?.catch(() => {});
    await Promise.all([...this.active.keys()].map(id => this.pause(id)));
    await Promise.allSettled([...this.active.values()].map(live => live.done));
  }
}

/** Advisory only: custom server layouts remain valid; no business paths are built into the service. */
export function consolePathWarnings(versions: HostConfig["evaluation"]["inputs"]["versions"], output: string): string[] {
  const normalize = (name: string) => name.toLowerCase().replace(/^\d+[_-]/, "")
    .replace(/(?:^|[_-])(?:input|output|eval|data|datasets?|sources?|results?)(?=[_-]|$)/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  const outputNames = new Set(output.split(path.sep).map(normalize).filter(Boolean));
  const mismatches = new Set<string>();
  for (const version of versions) for (const source of version.sources) {
    const parts = (source.kind === "file" ? path.dirname(source.path) : source.path).split(path.sep);
    while (parts.length && [version.id, version.name, version.display_name].includes(parts.at(-1))) parts.pop();
    const name = [...parts].reverse().map(normalize).find(Boolean);
    if (name && !outputNames.has(name)) mismatches.add(parts.at(-1)!);
  }
  return mismatches.size ? ["输入目录 " + [...mismatches].join("、") + " 与输出目录名称未对应，请确认输出位置。"] : [];
}
