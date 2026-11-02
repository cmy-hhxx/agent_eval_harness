import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError, errorText } from "@eval/contracts";
import { localFiles, readJson, writeJson } from "@eval/data";
import { createChannelRequests } from "@eval/host";
import { createBalancedModels } from "@eval/host-app/config";
import { loadConfig, readConfigSources, type HostConfig } from "@eval/host-app/config";
import { logger } from "@eval/host-app/composition";
import { preflightHost } from "@eval/host-app/preflight";
import { readSettings } from "@eval/host-app/settings";

import { consolePath } from "./files.js";
import { executeConsoleTask, type Gate } from "./evaluation.js";

export interface ConsolePreset {
  id: string; source: "wencai" | "aime"; name: string; configs: string[];
  inputRoots: string[]; concurrency: number;
}
export interface ConsoleConfig {
  hostname: string; port: number; stateDirectory: string; logDirectory: string; passwordFile: string;
  channels: string[]; presets: ConsolePreset[];
}
export interface ConsoleTask {
  id: string; preset: string; source: string; name: string;
  status: "draft" | "starting" | "running" | "pausing" | "paused" | "finished" | "partial" | "failed";
  createdAt: string; updatedAt: string; concurrency: number; output: string;
  inputs: { id: string; name: string; paths: string[] }[];
  error?: string; result?: Record<string, unknown>;
  warnings?: string[];
}
export class ConsoleTasks {
  readonly tasks = new Map<string, ConsoleTask>();
  private readonly active = new Map<string, { pause: AbortController; gate: Gate; done: Promise<void>; progress?: unknown }>();
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
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
    return { ...task, logs: this.logPaths(), ...(live ? { requests: live.gate.snapshot(), progress: live.progress } : {}) };
  }
  logPaths() { return ["runtime.log", "evaluation.log"].map(name => path.join(this.config.logDirectory, name)); }
  async presets() {
    return Promise.all(this.config.presets.map(async preset => {
      const host = await this.load(preset.configs);
      this.assertWorkflow(preset, host);
      return { id: preset.id, source: preset.source, name: preset.name,
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
    if (!value || typeof value !== "object") throw new HttpError(400, "配置不能为空");
    const { preset: presetId, inputs, output, concurrency } = value as Record<string, unknown>;
    const preset = this.config.presets.find(item => item.id === presetId);
    if (!preset) throw new HttpError(400, "未知评测预设");
    this.checkConcurrency(concurrency);
    const host = await this.load(preset.configs);
    this.assertWorkflow(preset, host);
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new HttpError(400, "请指定各模型的输入位置");
    const entries = inputs as Record<string, unknown>;
    if (Object.keys(entries).length !== host.evaluation.inputs.versions.length) throw new HttpError(400, "输入模型数量与预设不符");
    const versions = await Promise.all(host.evaluation.inputs.versions.map(async version => {
      const paths = entries[version.id];
      if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, "缺少输入: " + version.name);
      return { ...version, sources: await Promise.all(paths.map(async (file, index) => {
        const source = await consolePath(file, preset.inputRoots, true);
        const original = version.sources[index];
        return source.kind === "directory" && original?.kind === "directory" ? { ...original, ...source } : source;
      })) };
    }));
    const destination = await consolePath(output);
    for (const version of versions) for (const source of version.sources) {
      const input = source.path;
      if (input === destination.path || input.startsWith(destination.path + path.sep) || destination.path.startsWith(input + path.sep))
        throw new HttpError(400, "输入和输出目录不能重叠: " + input);
    }
    const warnings = consolePathWarnings(versions, destination.path);
    const raw = await readConfigSources(preset.configs);
    raw.inputs = { ...host.evaluation.inputs, versions };
    const inputsChanged = versions.some((version, index) => JSON.stringify(version.sources.map(source => source.path)) !==
      JSON.stringify(host.evaluation.inputs.versions[index]!.sources.map(source => source.path)));
    // A finite record selection belongs to its original files. New paths must not evaluate old coordinates.
    if (inputsChanged) delete (raw.inputs as Record<string, unknown>).records;
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
        output: destination.path, warnings, inputs: versions.map(version => ({ id: version.id, name: version.display_name || version.name,
          paths: version.sources.map(source => source.path) })) };
      await this.exclusive(() => this.save(task));
      return this.get(id);
    } catch (error) {
      await localFiles.remove(this.directory(id), { recursive: true, force: true });
      throw error;
    }
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
      if ([...this.active.keys()].some(key => this.tasks.get(key)!.output === task.output))
        throw new HttpError(409, "已有任务正在写入这个输出位置，请先暂停它");
      const host = await this.load(this.configFile(id));
      const issues = await this.dependencies.preflight(host, id);
      if (issues.length) throw new HttpError(409, issues.map(issue => issue.check + ": " + issue.reason).join("；"));
      task.status = "starting"; delete task.error; delete task.result;
      await this.save(task);
      const pause = new AbortController(), gate = createChannelRequests(this.limits(task.concurrency), undefined, undefined, undefined, task.concurrency);
      const live = { pause, gate, done: Promise.resolve(), progress: undefined as unknown };
      this.active.set(id, live);
      live.done = Promise.resolve().then(async () => {
        try {
          await logger.event("console_task_started", { component: "console", run_id: id });
          const result = await this.dependencies.execute({ host, id, gate, pause: pause.signal, channels: this.config.channels,
            progress: message => {
              if (message.startsWith("progress ")) {
                try { live.progress = JSON.parse(message.slice(9)); } catch { /* Host messages also contain plain progress. */ }
              }
            } });
          await this.exclusive(async () => {
            const current = this.tasks.get(id)!;
            current.result = result;
            const counts = result.execution_task_statuses as Record<string, number> | undefined;
            current.status = pause.signal.aborted ? "paused" : result.outcome === "partial" || result.resource_pause || result.input_issue_count || result.input_rejected ||
              (result.paused_stages as unknown[] | undefined)?.length || Object.entries(counts ?? {}).some(([key, count]) => key !== "succeeded" && count) ? "partial" : "finished";
            await this.save(current);
            this.active.delete(id);
          });
        } catch (error) {
          await logger.error(error, { component: "console", event: "console_task_failed", run_id: id });
          await this.exclusive(async () => {
            const current = this.tasks.get(id)!;
            current.status = "failed"; current.error = errorText(error);
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
    return { preset: task.preset, inputs: Object.fromEntries(task.inputs.map(input => [input.id, input.paths])),
      output: task.output, concurrency: task.concurrency };
  }
  async close() {
    this.closing = true;
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
