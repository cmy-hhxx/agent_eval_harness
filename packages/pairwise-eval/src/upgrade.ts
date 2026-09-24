import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EngineIdentity, JsonObject, PlannedTask, RunManifest, RunState, SubmissionReceipt, TaskState } from "../../contracts/src/index.js";
import { exists, internalPath, readInputs, readJson, runLock } from "../../contracts/src/io.js";
import { candidateKey, inputSources, readInputSource } from "./input.js";
import { evaluationFromRow, loadRunInputs, readRunState, writeRunState } from "./run-data.js";
import type { Candidate, EvalConfig, TaskData } from "./types.js";

interface LegacyReceipt extends Omit<SubmissionReceipt, "evaluation" | "exported"> {
  evaluation?: unknown;
  cached?: boolean;
  exported?: { comparisonId: string; file?: string; digest?: string };
}
interface LegacyState extends Omit<RunManifest, "format" | "tasks" | "states" | "inputs" | "preflight"> {
  format: string;
  fingerprint?: string;
  tasks: Record<string, TaskState & { receipt?: LegacyReceipt }>;
  usage: RunState["usage"];
  recordedAttempts: number;
}
async function convert(run: string): Promise<{ state: RunState; inputs: Record<string, unknown> }> {
  const old = await readJson<LegacyState>(path.join(run, "state.json"));
  if (old.format !== "dual-agent-eval/4") throw new Error("仅支持显式升级 dual-agent-eval/4");
  const planFile = internalPath(run, "plan.json");
  if (!await exists(planFile)) throw new Error("缺少保存的 plan.json；无法在不计算哈希的情况下推断旧任务 ID，请恢复原计划材料。");
  const plan = await readJson<{ tasks: PlannedTask[]; summary: JsonObject }>(planFile);
  const inputs = await readInputs(run);
  const tasks = plan.tasks.filter((task) => Object.hasOwn(old.tasks, task.id));
  if (tasks.length !== Object.keys(old.tasks).length) throw new Error("保存的计划未覆盖全部旧任务");
  const rows = new Map<string, JsonObject>();
  if (await exists(path.join(run, "results"))) for (const file of await readdir(path.join(run, "results"))) {
    if (!file.endsWith(".jsonl")) continue;
    const text = await readFile(path.join(run, "results", file), "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as JsonObject, key = file + ":" + row.comparison_id;
      if (rows.has(key)) throw new Error("重复结果：" + key);
      rows.set(key, row);
    }
  }
  const { tasks: saved, usage, recordedAttempts, fingerprint: _fingerprint, ...metadata } = old;
  const config = structuredClone(metadata.config) as EvalConfig & { cacheDir?: string };
  delete config.cacheDir;
  delete (config.execution as unknown as JsonObject).seed;
  const identity = metadata.engine as EngineIdentity & { sourceDigest?: string; buildDigest?: string };
  const state: RunState = { manifest: { ...metadata, config, format: "dual-agent-eval/6", engine: {
    engine: identity.engine, version: identity.version, commit: identity.commit, buildId: identity.buildId || randomUUID(),
  }, tasks, states: {}, inputs: {}, preflight: plan.summary }, receipts: {}, usage, recordedAttempts };
  for (const task of tasks) {
    const data = task.data as TaskData;
    data.revision = 1;
    for (const candidate of Object.values(data.candidates)) {
      const record = candidate as Candidate & { input_hash?: string };
      record.input_id = record.input_id || record.input_hash!;
      delete record.input_hash;
      if (!Object.hasOwn(inputs, record.input_id)) throw new Error("输入快照缺失：" + record.input_id);
    }
    const { receipt, ...status } = saved[task.id];
    delete (status as TaskState & { cacheKey?: string }).cacheKey;
    state.manifest.states[task.id] = { ...status, revision: 1 };
    if (!receipt) continue;
    const { cached: _cached, exported, ...rest } = receipt;
    rest.audit.artifacts = rest.audit.artifacts.map(({ id, name, bytes }) => ({ id, name, bytes }));
    let evaluation = receipt.evaluation;
    let row: JsonObject | undefined;
    if (exported) {
      const file = exported.file || data.pair!.join("__vs__") + ".jsonl";
      row = rows.get(file + ":" + exported.comparisonId);
      if (!row) throw new Error("已有结果引用缺失：" + exported.comparisonId);
      data.comparisonId = exported.comparisonId;
      evaluation ??= evaluationFromRow(data, row);
    } else if (task.stage === "pairwise") {
      row = [...rows.values()].find((row) => {
        const c = row.case as JsonObject;
        return c.batch_id === data.candidates.A.batch_id && c.case_id === data.candidates.A.case_id &&
          data.pair!.every((version) => Object.hasOwn(row.evaluations as object, version));
      });
      data.comparisonId = row ? String(row.comparison_id) : "cmp_" + randomUUID();
    }
    state.receipts[task.id] = { ...rest, taskId: task.id, status: "succeeded", evaluation,
      ...(exported && row ? { exported: { comparisonId: exported.comparisonId, file: exported.file, row } } : {}),
    };
  }
  state.manifest.inputCatalog = [...new Map(tasks.flatMap((t) => Object.values((t.data as TaskData).candidates)).map((c) => [candidateKey(c), c])).values()];
  state.manifest.inputs = Object.fromEntries((state.manifest.inputCatalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]));
  return { state, inputs: Object.fromEntries(Object.keys(state.manifest.inputs).map((id) => [id, inputs[id]])) };
}

async function convertV5(run: string): Promise<{ state: RunState; inputs: Record<string, unknown> }> {
  const old = await readJson<LegacyState & { plan: PlannedTask[]; inputs: Record<string, unknown>; preflight: JsonObject }>(path.join(run, "state.json"));
  const { plan, tasks, usage, recordedAttempts, ...metadata } = old;
  const state: RunState = { manifest: { ...metadata, format: "dual-agent-eval/6", tasks: plan, inputs: {}, preflight: metadata.preflight as JsonObject, states: {} }, receipts: {}, usage, recordedAttempts };
  const files = new Map<string, Map<string, JsonObject>>();
  for (const task of plan) {
    const { receipt, ...status } = tasks[task.id];
    state.manifest.states[task.id] = status;
    if (!receipt) continue;
    const { exported, ...rest } = receipt;
    if (!exported) { state.receipts[task.id] = rest as SubmissionReceipt; continue; }
    const file = path.join(run, "results", exported.file || (task.data as TaskData).pair!.join("__vs__") + ".jsonl");
    if (!files.has(file)) files.set(file, new Map((await readFile(file, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => { const row = JSON.parse(line); return [String(row.comparison_id), row]; })));
    const row = files.get(file)!.get(exported.comparisonId);
    if (!row) throw new Error("已有结果引用缺失：" + exported.comparisonId);
    state.receipts[task.id] = { ...rest, exported: { comparisonId: exported.comparisonId, file: exported.file, row } } as SubmissionReceipt;
  }
  const inputs = Object.fromEntries(await Promise.all(Object.keys(old.inputs).map(async (id) =>
    [id, await readJson(path.join(run, "inputs", id + ".json"))])));
  return { state, inputs };
}
async function registerSources(state: RunState, inputs: Record<string, unknown>): Promise<void> {
  const catalog = state.manifest.inputCatalog as Candidate[] || state.manifest.tasks.flatMap((t) => Object.values((t.data as TaskData).candidates));
  const records = [...catalog, ...state.manifest.tasks.flatMap((t) => Object.values((t.data as TaskData).candidates))];
  for (const [source, candidates] of inputSources(records)) {
    const { text, revision } = await readInputSource(source), lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    for (const c of candidates) {
      if (!isDeepStrictEqual(JSON.parse(lines[c.line - 1]), inputs[c.input_id]))
        throw new Error("源文件与旧输入不一致，保留材料并停止去重：" + source + ":" + c.line);
      c.source_revision = revision;
    }
  }
  state.manifest.inputCatalog = [...new Map(records.map((c) => [c.input_id, c])).values()];
  state.manifest.inputs = Object.fromEntries((state.manifest.inputCatalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]));
}
async function removeCopies(run: string, state: RunState): Promise<void> {
  const directory = path.join(run, "inputs");
  if (!await exists(directory)) return;
  const inputs = await loadRunInputs(state.manifest);
  for (const name of await readdir(directory)) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (Object.hasOwn(inputs, id) && isDeepStrictEqual(await readJson(path.join(directory, name)), inputs[id]))
      await rm(path.join(directory, name));
  }
  if (!(await readdir(directory)).length) await rm(directory, { recursive: true });
}
export async function upgradeRun(run: string, apply = false): Promise<JsonObject> {
  const release = await runLock(run);
  try {
    const current = await readJson<{ format: string }>(path.join(run, "state.json"));
    if (current.format === "dual-agent-eval/6") {
      if (apply) await removeCopies(run, await readRunState(run));
      return { upgraded: false, format: current.format, reason: "already_current" };
    }
    const { state, inputs } = current.format === "dual-agent-eval/5" ? await convertV5(run) : await convert(run);
    await registerSources(state, inputs);
    const preview = { run_id: state.manifest.runId, tasks: state.manifest.tasks.length,
      accepted: Object.keys(state.receipts).length, format: "dual-agent-eval/6", applied: apply };
    if (!apply) return preview;
    // Atomic state replacement precedes deleting verified copies. Re-running finishes interrupted cleanup.
    await writeRunState(run, state);
    await removeCopies(run, await readRunState(run));
    return preview;
  } finally { await release(); }
}
