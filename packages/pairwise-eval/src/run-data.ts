import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import type { JsonObject, PlannedTask, RunManifest, RunState, SubmissionReceipt, TaskState, TaskPlan } from "../../contracts/src/index.js";
import { canonical, exists, readJson, safeId, writeJson } from "../../contracts/src/io.js";
import { buildPlan, candidateKey } from "./input.js";
import type { Candidate, EvalConfig, PairwiseResult, TaskData } from "./types.js";

type SavedReceipt = Omit<SubmissionReceipt, "exported"> & { exported?: { comparisonId: string; file?: string } };
export interface Checkpoint extends Omit<RunManifest, "tasks" | "states"> {
  plan: PlannedTask[];
  tasks: Record<string, TaskState & { receipt?: SavedReceipt }>;
  usage: RunState["usage"];
  recordedAttempts: number;
}
export async function writeRunInputs(run: string, inputs: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(run, "inputs"), { recursive: true });
  for (const [id, value] of Object.entries(inputs)) {
    const file = path.join(run, "inputs", safeId(id) + ".json");
    if (!await exists(file)) await writeJson(file, value);
  }
}
export async function writeRunState(run: string, state: RunState, inputs?: Record<string, unknown>): Promise<void> {
  const { tasks, states, ...metadata } = state.manifest;
  metadata.inputCatalog ??= [...new Map(tasks.flatMap((task) => Object.values((task.data as TaskData).candidates))
    .map((candidate) => [candidateKey(candidate), candidate])).values()];
  if (inputs) await writeRunInputs(run, inputs);
  if (!await exists(path.join(run, "inputs"))) throw new Error("必须先保存规划时读取的输入快照");
  metadata.inputs = Object.fromEntries((metadata.inputCatalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]));
  const config = metadata.config as EvalConfig;
  metadata.config = { ...config, inputs: { ...config.inputs, batches: config.inputs.batches || Object.keys(metadata.preflight.by_batch || {}) } };
  const saved = Object.fromEntries(Object.entries(states).map(([id, status]) => {
    const receipt = state.receipts[id];
    if (!receipt) return [id, status];
    const { exported, ...rest } = receipt;
    return [id, { ...status, receipt: { ...rest,
      ...(exported ? { exported: { comparisonId: exported.comparisonId, file: exported.file } } : {}),
    } }];
  }));
  await writeJson(path.join(run, "state.json"), { ...metadata, plan: tasks, tasks: saved, usage: state.usage, recordedAttempts: state.recordedAttempts });
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
  const { tasks: savedTasks, plan, usage, recordedAttempts, ...metadata } = await readJson<Checkpoint>(path.join(run, "state.json"));
  if (metadata.format !== "dual-agent-eval/5") throw new Error("不支持此运行格式；请先运行 upgrade-run 显式升级。");
  const state: RunState = { manifest: { ...metadata, tasks: plan, states: {} }, receipts: {}, usage, recordedAttempts };
  for (const [id, { receipt: _receipt, ...status }] of Object.entries(savedTasks)) state.manifest.states[id] = status;
  const files = new Map<string, Map<string, JsonObject>>();
  for (const task of plan) {
    const saved = savedTasks[task.id];
    if (!saved) throw new Error("任务状态缺失：" + task.id);
    const { receipt, ...status } = saved;
    state.manifest.states[task.id] = status;
    if (!receipt) continue;
    if (!receipt.exported) { state.receipts[task.id] = receipt as SubmissionReceipt; continue; }
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
    if (!row) {
      if (!receipt.evaluation) throw new Error("结果文件缺失：" + receipt.exported.comparisonId);
      const { exported: _exported, ...rest } = receipt;
      state.receipts[task.id] = rest;
      continue;
    }
    if (canonical(row.case) !== canonical({ batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id }))
      throw new Error("结果文件缺失或身份不一致：" + receipt.exported.comparisonId);
    state.receipts[task.id] = { ...receipt, exported: { ...receipt.exported, row } };
  }
  return state;
}
export async function loadRunInputs(run: string, manifest: RunManifest): Promise<Record<string, unknown>> {
  return Object.fromEntries(await Promise.all(Object.keys(manifest.inputs).map(async (id) =>
    [id, await readJson(path.join(run, "inputs", safeId(id) + ".json"))],
  )));
}
export async function reconcileRun(run: string, state: RunState, current: unknown): Promise<TaskPlan> {
  const config = state.manifest.config as EvalConfig, supplied = current as EvalConfig;
  const previous: TaskPlan = { tasks: state.manifest.tasks, inputs: await loadRunInputs(run, state.manifest),
    summary: state.manifest.preflight, catalog: state.manifest.inputCatalog };
  const selected: EvalConfig = { ...config, judge: supplied.judge, execution: supplied.execution, inputs: { ...config.inputs,
    versions: config.inputs.versions.map((v) => ({ ...v, path: supplied.inputs.versions.find((item) => item.id === v.id)?.path || v.path })),
  } };
  const registered = [...(state.manifest.retiredTasks || []), ...previous.tasks];
  const plan = await buildPlan(selected, { ...previous, tasks: registered });
  // A conflicting case is not a valid replacement for its saved materials.
  const conflicts = new Set((plan.summary.skipped as JsonObject[]).filter((item) => item.reason === "case_conflict")
    .map((item) => canonical([item.batch_id, item.case_id])));
  for (const task of previous.tasks) {
    const a = (task.data as TaskData).candidates.A;
    if (conflicts.has(canonical([a.batch_id, a.case_id]))) {
      plan.tasks.push(task);
      for (const candidate of Object.values((task.data as TaskData).candidates)) {
        plan.inputs[candidate.input_id] = previous.inputs[candidate.input_id];
        plan.catalog = (plan.catalog as Candidate[]).filter((c) => candidateKey(c) !== candidateKey(candidate));
        plan.catalog.push(candidate);
      }
    }
  }
  // A case limit applies to additions, never removes already registered work.
  for (const task of previous.tasks) {
    const a = (task.data as TaskData).candidates.A;
    if (!plan.tasks.some((t) => { const c = (t.data as TaskData).candidates.A; return c.batch_id === a.batch_id && c.case_id === a.case_id; })) {
      plan.tasks.push(...previous.tasks.filter((t) => { const c = (t.data as TaskData).candidates.A; return c.batch_id === a.batch_id && c.case_id === a.case_id; }));
      for (const c of (previous.catalog as Candidate[]).filter((c) => c.batch_id === a.batch_id && c.case_id === a.case_id)) {
        plan.inputs[c.input_id] = previous.inputs[c.input_id];
        (plan.catalog as Candidate[]).push(c);
      }
    }
  }
  const tasks = new Set(plan.tasks.map((task) => task.id));
  state.manifest.retiredTasks = registered.filter((task) => !tasks.has(task.id));
  for (const task of state.manifest.retiredTasks) {
    state.manifest.states[task.id].status = "cancelled";
    state.manifest.states[task.id].reason = "Current inputs no longer require this task";
  }
  for (const id of Object.keys(state.receipts)) if (!tasks.has(id)) delete state.receipts[id];
  for (const task of plan.tasks) {
    const revision = (task.data as TaskData).revision || 1;
    const old = state.manifest.states[task.id];
    if (!old || (old.revision || 1) !== revision) {
      delete state.receipts[task.id];
      state.manifest.states[task.id] = { status: "pending", attempts: old?.attempts || 0, revision };
    }
  }
  await writeRunInputs(run, plan.inputs);
  state.manifest.config = selected;
  state.manifest.tasks = plan.tasks;
  state.manifest.inputCatalog = plan.catalog;
  state.manifest.inputs = Object.fromEntries(Object.keys(plan.inputs).map((id) => [id, { id, name: id }]));
  state.manifest.preflight = plan.summary;
  return plan;
}
