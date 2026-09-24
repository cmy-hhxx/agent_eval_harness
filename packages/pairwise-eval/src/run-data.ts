import path from "node:path";
import type { JsonObject, RunManifest, RunState, SubmissionReceipt, TaskState, TaskPlan } from "../../contracts/src/index.js";
import { atomicWrite, digest, exists, internalPath, readInputs, readJson, readJsonl, safeId, writeJson } from "../../contracts/src/io.js";
import { buildPlan } from "./input.js";
import type { EvalConfig, PairwiseResult, TaskData } from "./types.js";

type SavedReceipt = Omit<SubmissionReceipt, "taskId" | "status" | "evaluation" | "exported"> & {
  evaluation?: unknown;
  exported?: { comparisonId: string; digest: string; file?: string };
};
interface Checkpoint extends Omit<RunManifest, "tasks" | "states" | "inputs" | "preflight"> {
  tasks: Record<string, Pick<TaskState, "status" | "attempts" | "reason"> & { receipt?: SavedReceipt }>;
  usage: RunState["usage"];
  recordedAttempts: number;
}

export async function writeRunState(run: string, state: RunState): Promise<void> {
  const { tasks, states, inputs: _inputs, preflight, ...metadata } = state.manifest;
  if (metadata.debug && !await exists(internalPath(run, "plan.json")))
    await writeJson(internalPath(run, "plan.json"), { tasks, summary: preflight });
  const entries = tasks.map((task) => {
    const { status, attempts, reason } = states[task.id];
    const receipt = state.receipts[task.id];
    let stored: SavedReceipt | undefined;
    if (receipt) {
      const { taskId: _taskId, status: _status, evaluation, exported, ...rest } = receipt;
      stored = exported
        ? { ...rest, exported: { comparisonId: exported.comparisonId, digest: exported.digest, file: exported.file } }
        : { ...rest, evaluation };
    }
    return `    ${JSON.stringify(task.id)}: ${JSON.stringify({ status, attempts, reason, receipt: stored })}`;
  });
  const header = JSON.stringify({ ...metadata, usage: state.usage, recordedAttempts: state.recordedAttempts }, null, 2);
  await atomicWrite(path.join(run, "state.json"), header.slice(0, -2) + ',\n  "tasks": {\n' + entries.join(',\n') + '\n  }\n}\n');
}

function evaluationFromRow(data: TaskData, row: JsonObject): PairwiseResult {
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
  const { tasks: savedTasks, usage, recordedAttempts, ...metadata } = await readJson<Checkpoint>(path.join(run, "state.json"));
  if (metadata.format !== "dual-agent-eval/4") throw new Error("不支持此运行格式；请使用当前版本新建 run。");
  const plan = metadata.debug
    ? await readJson<Pick<TaskPlan, "tasks" | "summary">>(internalPath(run, "plan.json"))
    : await buildPlan(metadata.config as EvalConfig);
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  const state: RunState = {
    manifest: { ...metadata, tasks: [], inputs: {}, states: {}, preflight: plan.summary },
    receipts: {}, usage, recordedAttempts,
  };
  const resultFiles = new Map<string, Map<string, JsonObject>>();
  for (const [id, saved] of Object.entries(savedTasks)) {
    const task = tasks.get(id);
    if (!task) throw new Error(`找不到任务材料：${id}，请检查输入文件`);
    state.manifest.tasks.push(task);
    const { receipt, ...status } = saved;
    state.manifest.states[id] = status;
    for (const id of Object.values(task.inputIds)) state.manifest.inputs[id] = { id, name: id };
    if (!receipt) continue;
    const { exported, ...rest } = receipt;
    if (!exported) {
      state.receipts[id] = { ...rest, evaluation: receipt.evaluation, taskId: id, status: "succeeded" };
      continue;
    }
    const data = task.data as TaskData;
    const file = path.join(run, "results", safeId(exported.file || data.pair!.join("__vs__") + ".jsonl"));
    if (!resultFiles.has(file)) {
      const rows = new Map<string, JsonObject>();
      for await (const row of readJsonl(file)) rows.set(String((row as JsonObject).comparison_id), row as JsonObject);
      resultFiles.set(file, rows);
    }
    const row = resultFiles.get(file)!.get(exported.comparisonId);
    if (!row || digest(row) !== exported.digest) throw new Error(`结果文件缺失或内容不一致：${exported.comparisonId}`);
    state.receipts[id] = { ...rest, taskId: id, status: "succeeded", evaluation: evaluationFromRow(data, row), exported: { ...exported, row } };
  }
  return state;
}

export async function loadRunInputs(run: string, manifest: RunManifest): Promise<Record<string, unknown>> {
  return manifest.debug ? readInputs(run) : (await buildPlan(manifest.config as EvalConfig)).inputs;
}
