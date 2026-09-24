import path from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { JsonObject, RunManifest, RunState, SubmissionReceipt, TaskState, TaskPlan, ValidationIssue } from "../../contracts/src/index.js";
import { canonical, errorText, exists, readJson, safeId, ValidationError, writeJson } from "../../contracts/src/io.js";
import { adapt, buildPlan, candidateKey, inputSources, readInputSource } from "./input.js";
import type { BatchPreflight, Candidate, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";

type Patch = { path: string[]; value?: unknown }[];
type SavedReceipt = Omit<SubmissionReceipt, "exported" | "evaluation" | "submitted"> & {
  evaluation?: unknown;
  evaluationPatch?: Patch;
  submittedPatch?: Patch;
  exported?: { comparisonId: string; file?: string };
};
type SavedTask = TaskState & { stage: string; inputIds: Record<string, string>; dependencies: Record<string, string>;
  data: Omit<TaskData, "candidates" | "stage" | "revision">; receipt?: SavedReceipt };
export interface Checkpoint extends Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog"> {
  inputs: Record<string, Omit<Candidate, "input_id">>;
  tasks: Record<string, SavedTask>;
  usage: RunState["usage"];
  recordedAttempts: number;
}

// Keep exact protocol values without copying the accepted verdict into the ledger.
function difference(base: unknown, value: unknown, path: string[] = []): Patch {
  if (isDeepStrictEqual(base, value)) return [];
  if (!base || !value || typeof base !== "object" || typeof value !== "object" || Array.isArray(base) !== Array.isArray(value) ||
      (Array.isArray(base) && base.length !== (value as unknown[]).length)) return [{ path, ...(value !== undefined ? { value } : {}) }];
  const a = base as Record<string, unknown>, b = value as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => difference(a[key], b[key], [...path, key]));
}
function restore(base: unknown, patch: Patch): unknown {
  let value = structuredClone(base);
  for (const entry of patch) {
    if (!entry.path.length) { value = entry.value; continue; }
    let parent = value as Record<string, unknown>;
    for (const key of entry.path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = entry.path.at(-1)!;
    if (Object.hasOwn(entry, "value")) parent[key] = entry.value;
    else delete parent[key];
  }
  return value;
}
export async function writeRunState(run: string, state: RunState): Promise<void> {
  const { tasks, states, inputs: _inputs, inputCatalog, ...metadata } = state.manifest;
  const catalog = inputCatalog as Candidate[] || [...new Map(tasks.flatMap((task) => Object.values((task.data as TaskData).candidates))
    .map((candidate) => [candidate.input_id, candidate])).values()];
  const inputs = Object.fromEntries(catalog.map(({ input_id, ...c }) => [input_id, c]));
  const config = metadata.config as EvalConfig;
  metadata.config = { ...config, inputs: { ...config.inputs, batches: config.inputs.batches || Object.keys(metadata.preflight.by_batch || {}) } };
  const saved = Object.fromEntries(tasks.map((task) => {
    const { candidates: _candidates, stage: _stage, revision, ...data } = task.data as TaskData;
    const value: SavedTask = { ...states[task.id], revision: revision || 1, stage: task.stage,
      inputIds: task.inputIds, dependencies: task.dependencies, data };
    const receipt = state.receipts[task.id];
    if (receipt) {
      const { exported, evaluation, submitted, ...rest } = receipt;
      value.receipt = { ...rest,
        ...(exported ? { exported: { comparisonId: exported.comparisonId, file: exported.file },
          evaluationPatch: difference(evaluationFromRow(task.data as TaskData, exported.row), evaluation) } : { evaluation }),
        ...(submitted !== undefined ? { submittedPatch: difference(evaluation, submitted) } : {}),
      };
    }
    return [task.id, value];
  }));
  await writeJson(path.join(run, "state.json"), { ...metadata, inputs, tasks: saved, usage: state.usage, recordedAttempts: state.recordedAttempts });
}

export function evaluationFromRow(data: TaskData, row: JsonObject): PairwiseResult {
  const labels = Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => [candidate.version, label]));
  const verdict = row.verdict as { result: string; winner_version: string | null; reason: string };
  const basis = row.decision_basis as PairwiseResult["decision_basis"];
  return {
    verdict: {
      result: verdict.result === "win" ? `${labels[verdict.winner_version!]}_better` as "A_better" | "B_better" : verdict.result as PairwiseResult["verdict"]["result"],
      reason: verdict.reason,
    },
    evaluations: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => {
      const review = (row.evaluations as Record<string, PairwiseResult["evaluations"][string]>)[candidate.version];
      return [label, { summary: review.summary, findings: review.findings.map((finding) => {
        const { stage_trace: _trace, ...rest } = finding;
        return rest;
      }) }];
    })),
    task_analysis: row.task_analysis as PairwiseResult["task_analysis"],
    decision_basis: {
      tradeoff: basis.tradeoff,
      decisive_findings: basis.decisive_findings.map((ref) => ({ ...ref, candidate: labels[ref.candidate] })),
      counterevidence: basis.counterevidence.map((ref) => ({ ...ref, candidate: labels[ref.candidate] })),
    },
  };
}

export async function readRunState(run: string): Promise<RunState> {
  const { tasks: savedTasks, inputs, usage, recordedAttempts, ...metadata } = await readJson<Checkpoint>(path.join(run, "state.json"));
  if (metadata.format !== "dual-agent-eval/6") throw new Error("不支持此运行格式；请先运行 upgrade-run 显式升级。");
  const catalog = Object.entries(inputs).map(([input_id, c]) => ({ ...c, input_id }));
  const candidates = Object.fromEntries(catalog.map((c) => [c.input_id, c]));
  const plan = Object.entries(savedTasks).map(([id, t]) => ({ id, stage: t.stage, inputIds: t.inputIds, dependencies: t.dependencies,
    data: { ...t.data, stage: t.stage, revision: t.revision || 1,
      candidates: Object.fromEntries(Object.entries(t.inputIds).map(([label, id]) => {
        if (!candidates[id]) throw new Error("输入引用缺失：" + id);
        return [label, candidates[id]];
      })) } }));
  const state: RunState = { manifest: { ...metadata, tasks: plan, inputCatalog: catalog,
    inputs: Object.fromEntries(catalog.map((c) => [c.input_id, { id: c.input_id, name: c.input_id }])), states: {} }, receipts: {}, usage, recordedAttempts };
  const files = new Map<string, Map<string, JsonObject>>();
  for (const task of plan) {
    const saved = savedTasks[task.id];
    if (!saved) throw new Error("任务状态缺失：" + task.id);
    const { receipt, stage: _stage, inputIds: _inputIds, dependencies: _dependencies, data: _data, ...status } = saved;
    state.manifest.states[task.id] = status;
    if (!receipt) continue;
    const { evaluationPatch, submittedPatch, ...value } = receipt;
    if (!receipt.exported) {
      state.receipts[task.id] = { ...value, ...(submittedPatch ? { submitted: restore(value.evaluation, submittedPatch) } : {}) } as SubmissionReceipt;
      continue;
    }
    const data = task.data as TaskData;
    const file = path.join(run, "results", safeId(receipt.exported.file || data.pair!.join("__vs__") + ".jsonl"));
    if (!files.has(file)) {
      const text = await exists(file) ? await readFile(file, "utf8") : "", rows = new Map<string, JsonObject>();
      for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) if (line.trim()) {
        const row = JSON.parse(line) as JsonObject;
        const id = String(row.comparison_id), previous = rows.get(id);
        if (previous && canonical(previous) !== canonical(row)) throw new Error("比较 ID 对应冲突结果：" + id);
        rows.set(id, row);
      }
      files.set(file, rows);
    }
    const row = files.get(file)!.get(receipt.exported.comparisonId);
    if (!row) throw new Error("结果文件缺失：" + receipt.exported.comparisonId);
    if (canonical(row.case) !== canonical({ batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id }))
      throw new Error("结果文件缺失或身份不一致：" + receipt.exported.comparisonId);
    const evaluation = restore(evaluationFromRow(data, row), evaluationPatch || []);
    state.receipts[task.id] = { ...value, evaluation, ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
      exported: { ...receipt.exported, row } };
  }
  return state;
}
export async function loadRunInputs(manifest: RunManifest, issues?: ValidationIssue[]): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {}, errors: ValidationIssue[] = [];
  const config = manifest.config as EvalConfig;
  const sources = inputSources(manifest.inputCatalog as Candidate[]);
  for (const [source, candidates] of sources) {
    let revision: string, lines: string[];
    try {
      const file = await readInputSource(source);
      revision = file.revision; lines = file.text.replace(/^\uFEFF/, "").split(/\r?\n/);
    } catch (error) {
      errors.push({ category: "file", code: "input_source_unavailable", path: source, expected: "可读取的原始输入文件", actual: null, message: errorText(error) });
      continue;
    }
    for (const candidate of candidates) {
      try {
        if (candidate.source_revision !== revision) throw new Error("输入源文件已变化，无法校验旧结果的原始证据：" + source);
        const raw = JSON.parse(lines[candidate.line - 1]) as RawInput;
        const version = config.inputs.versions.find((v) => v.id === candidate.version)!;
        if (candidateKey(adapt(raw, version, source, candidate.line, config.inputs.default_batch_id)) !== candidateKey(candidate))
          throw new Error("输入源记录与登记的业务标识不一致：" + candidate.input_id);
        inputs[candidate.input_id] = raw;
      } catch (error) {
        errors.push({ category: "file", code: "input_source_unavailable", path: source, expected: candidate.input_id, actual: null, message: errorText(error) });
      }
    }
  }
  if (issues) issues.push(...errors);
  else if (errors.length) throw new ValidationError(errors);
  return inputs;
}
export async function reconcileRun(_run: string, state: RunState, current: unknown): Promise<TaskPlan> {
  const config = state.manifest.config as EvalConfig, supplied = current as EvalConfig;
  const selected: EvalConfig = { ...config, judge: supplied.judge, execution: supplied.execution, inputs: { ...config.inputs,
    versions: config.inputs.versions.map((v) => ({ ...v, path: supplied.inputs.versions.find((item) => item.id === v.id)?.path || v.path })),
  } };
  const previous = state.manifest.tasks;
  const plan = await buildPlan(selected, { tasks: previous, inputs: {}, summary: state.manifest.preflight, catalog: state.manifest.inputCatalog });
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  // Accepted work is immutable within a run. Only unfinished/new tasks use the latest source records.
  for (const task of previous) if (state.receipts[task.id] || !tasks.has(task.id)) tasks.set(task.id, task);
  const dependencies = new Set([...tasks.values()].flatMap((task) => Object.values(task.dependencies)));
  for (const [id, task] of tasks)
    if (task.stage === "correctness" && !dependencies.has(id) && !state.receipts[id]) tasks.delete(id);
  plan.tasks = [...tasks.values()];
  plan.summary.correctness_tasks = plan.tasks.filter((task) => task.stage === "correctness").length;
  plan.summary.pairwise_tasks = plan.tasks.filter((task) => task.stage === "pairwise").length;
  for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, BatchPreflight>)) {
    const selected = plan.tasks.filter((task) => (task.data as TaskData).candidates.A.batch_id === batch);
    counts.correctness_tasks = selected.filter((task) => task.stage === "correctness").length;
    counts.pairwise_tasks = selected.filter((task) => task.stage === "pairwise").length;
  }
  const catalog = new Map((plan.catalog as Candidate[]).map((c) => [c.input_id, c]));
  for (const task of plan.tasks) for (const c of Object.values((task.data as TaskData).candidates)) catalog.set(c.input_id, c);
  const needed = plan.tasks.filter((t) => !state.receipts[t.id] || (t.stage === "pairwise" && !state.receipts[t.id].exported));
  const unavailable = [...new Set(needed.flatMap((t) => Object.values(t.inputIds)))].filter((id) => !Object.hasOwn(plan.inputs, id));
  if (unavailable.length) throw new ValidationError(unavailable.map((id) => ({ category: "input", code: "input_source_unavailable",
    path: catalog.get(id)!.source, candidate: catalog.get(id)!.version, expected: id, actual: null,
    message: "未完成任务的原始输入缺失、无效或冲突；请修复源文件后续跑。已有结果保留。" })));
  // Unused new revisions of completed inputs need no persistent registration.
  const used = new Set(plan.tasks.flatMap((t) => Object.values(t.inputIds)));
  const represented = new Set([...used].map((id) => candidateKey(catalog.get(id)!)));
  plan.catalog = [...catalog.values()].filter((c) => used.has(c.input_id) || !represented.has(candidateKey(c)));
  for (const task of plan.tasks) {
    const revision = (task.data as TaskData).revision || 1, old = state.manifest.states[task.id];
    if (!state.receipts[task.id] && (!old || (old.revision || 1) !== revision))
      state.manifest.states[task.id] = { status: "pending", attempts: old?.attempts || 0, revision };
  }
  state.manifest.config = selected;
  state.manifest.tasks = plan.tasks;
  state.manifest.inputCatalog = plan.catalog;
  state.manifest.inputs = Object.fromEntries((plan.catalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]));
  state.manifest.preflight = plan.summary;
  return plan;
}
