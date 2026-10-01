import { isDeepStrictEqual } from "node:util";
import type { JsonObject, RunManifest, RunState, SubmissionReceipt, TaskState } from "@eval/contracts";
import { canonical, type ResultReference } from "@eval/contracts";
import type { RunCodec } from "@eval/data";
import type { Candidate, ComparisonResult, EvalConfig, Stage, TaskData } from "./types.js";
import { originalResultRow, stageResult, resultFile } from "./results.js";

type DiskReference = { file?: string; comparisonId?: string; taskId?: string };
type Patch = { path: string[]; value?: unknown }[];
type SavedReceipt = Omit<SubmissionReceipt, "exported" | "evaluation" | "submitted"> & {
  evaluation?: unknown;
  evaluationPatch?: Patch;
  submittedPatch?: Patch;
  rewriteIds?: string[];
  exported?: DiskReference;
};
type SavedTask = TaskState & {
  stage: Stage;
  inputIds: Record<string, string>;
  dependencies: Record<string, string>;
  data: Omit<TaskData, "candidates" | "stage" | "revision">;
  receipt?: SavedReceipt;
};
export interface Checkpoint extends Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog"> {
  inputs: Record<string, Omit<Candidate, "input_id">>;
  tasks: Record<string, SavedTask>;
  usage: RunState["usage"];
  recordedAttempts: number;
}

// Keep exact protocol values without copying the accepted verdict into the ledger.
function difference(base: unknown, value: unknown, path: string[] = []): Patch {
  if (isDeepStrictEqual(base, value)) return [];
  if (
    !base ||
    !value ||
    typeof base !== "object" ||
    typeof value !== "object" ||
    Array.isArray(base) !== Array.isArray(value) ||
    (Array.isArray(base) && base.length !== (value as unknown[]).length)
  )
    return [{ path, ...(value !== undefined ? { value } : {}) }];
  const a = base as Record<string, unknown>,
    b = value as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
    difference(a[key], b[key], [...path, key]),
  );
}
function restore(base: unknown, patch: Patch): unknown {
  let value = structuredClone(base);
  for (const entry of patch) {
    if (!entry.path.length) {
      value = entry.value;
      continue;
    }
    let parent = value as Record<string, unknown>;
    for (const key of entry.path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    const key = entry.path.at(-1)!;
    if (Object.hasOwn(entry, "value")) parent[key] = entry.value;
    else delete parent[key];
  }
  return value;
}
function encodeState(state: RunState): Checkpoint {
  const { tasks, states, inputs: _inputs, inputCatalog, ...metadata } = state.manifest;
  const catalog = (inputCatalog as Candidate[]) || [
    ...new Map(
      tasks
        .flatMap((task) => Object.values((task.data as TaskData).candidates))
        .map((candidate) => [candidate.input_id, candidate]),
    ).values(),
  ];
  const inputs = Object.fromEntries(catalog.map(({ input_id, ...c }) => [input_id, c]));
  const config = metadata.config as EvalConfig;
  metadata.config = {
    ...config,
    inputs: {
      ...config.inputs,
      batches: config.inputs.batches || Object.keys(metadata.preflight.by_batch || {}),
    },
  };
  const saved = Object.fromEntries(
    tasks.map((task) => {
      const { candidates: _candidates, stage: _stage, revision, ...data } = task.data as TaskData;
      const value: SavedTask = {
        ...states[task.id],
        revision: revision || 1,
        stage: task.stage as Stage,
        inputIds: task.inputIds,
        dependencies: task.dependencies,
        data,
      };
      const receipt = state.receipts[task.id];
      if (receipt) {
        const { exported, evaluation, submitted, ...rest } = receipt;
        const rewriteIds = task.stage === "rewrite"
          ? (evaluation as { rewrites: { id: string }[] }).rewrites.map((item) => item.id) : undefined;
        const reference = exported && {
          ...(task.stage === "comparison" ? { comparisonId: exported.id } : { taskId: exported.id }),
          ...(exported.file ? { file: exported.file } : {}),
        };
        const evaluationPatch = exported
          ? difference(resultEvaluation(task.data as TaskData, exported.row, rewriteIds), evaluation)
          : [];
        value.receipt = {
          ...rest,
          ...(rewriteIds ? { rewriteIds } : {}),
          ...(reference
            ? {
                exported: reference,
                ...(evaluationPatch.length ? { evaluationPatch } : {}),
              }
            : { evaluation }),
          ...(submitted !== undefined ? { submittedPatch: difference(evaluation, submitted) } : {}),
        };
      }
      return [task.id, value];
    }),
  );
  return {
    ...metadata,
    inputs,
    tasks: saved,
    usage: state.usage,
    recordedAttempts: state.recordedAttempts,
  };
}

function evaluationFromRow(data: TaskData, row: JsonObject): ComparisonResult {
  const labels = new Map(
    Object.entries(data.candidates).map(([label, candidate]) => [candidate.version, label]),
  );
  const basis = row.decision_basis as ComparisonResult["decision_basis"];
  return {
    status: "decided",
    review_requests: [],
    task_analysis: row.task_analysis as ComparisonResult["task_analysis"],
    ranking: (row.ranking as string[][]).map((tier) => tier.map((version) => labels.get(version)!)),
    assessments: Object.fromEntries(
      Object.entries(row.assessments as JsonObject).map(([version, assessment]) => [
        labels.get(version)!,
        assessment as ComparisonResult["assessments"][string],
      ]),
    ),
    decision_basis: {
      tradeoff: basis.tradeoff,
      comparisons: basis.comparisons.map((item) => ({
        ...item,
        better_candidates: item.better_candidates.map((version) => labels.get(version)!),
        assessments: Object.fromEntries(Object.entries(item.assessments).map(([version, assessment]) => [labels.get(version)!, assessment])),
      })),
      decisive_findings: basis.decisive_findings.map((ref) => ({
        ...ref,
        candidate: labels.get(ref.candidate)!,
      })),
    },
  };
}

function resultEvaluation(data: TaskData, row: JsonObject, rewriteIds?: string[]): unknown {
  if (data.stage === "rewrite") {
    const rewrites = (stageResult(data.rewriteOf!.stage, row).rewritten as { rewrites: { id: string; text: string }[] }).rewrites;
    return { rewrites: rewriteIds ? rewriteIds.map((id) => {
      const item = rewrites.find((item) => item.id === id);
      if (!item) throw new Error("改写槽位缺失：" + id);
      return item;
    }) : rewrites };
  }
  row = originalResultRow(data.stage, row);
  if (data.stage === "attribution") return row.evaluation;
  if (data.stage === "criteria" || row.evaluation_type === "comparison_review") return row.result;
  if (data.stage === "clustering") return row.result;
  return evaluationFromRow(data, row);
}

function decodeState(
  checkpoint: Checkpoint,
  getRow: (ref: ResultReference) => JsonObject,
  taskIds?: ReadonlySet<string>,
): RunState {
  const { tasks: savedTasks, inputs, usage, recordedAttempts, ...metadata } = checkpoint;
  if (metadata.format !== "evaluation-run") throw new Error("不支持此运行格式；只支持 evaluation-run。");
  if (typeof metadata.evaluatorVersion !== "string" || !metadata.evaluatorVersion.trim())
    throw new Error("运行状态缺少评测器版本");
  const resultRow = (receipt: SavedReceipt, ref: ResultReference, rewrittenStage?: string) => {
    const row = getRow(ref);
    if ((rewrittenStage ? (stageResult(rewrittenStage, row).rewritten as JsonObject)?.evaluator_version : row.evaluator_version) !== receipt.evaluatorVersion)
      throw new Error("结果评测器版本与收据不一致：" + ref.id);
    return row;
  };
  const catalog = Object.entries(inputs).map(([input_id, c]) => ({
    ...c,
    input_id,
  }));
  const candidates = Object.fromEntries(catalog.map((c) => [c.input_id, c]));
  const plan = Object.entries(savedTasks).map(([id, t]) => ({
    id,
    stage: t.stage,
    inputIds: t.inputIds,
    dependencies: t.dependencies,
    data: {
      ...t.data,
      stage: t.stage,
      revision: t.revision || 1,
      candidates: Object.fromEntries(
        Object.entries(t.inputIds).map(([label, id]) => {
          if (!candidates[id]) throw new Error("输入引用缺失：" + id);
          return [t.stage === "attribution" ? "A" : label, candidates[id]];
        }),
      ),
    },
  }));
  const state: RunState = {
    manifest: {
      ...metadata,
      tasks: plan,
      inputCatalog: catalog,
      inputs: Object.fromEntries(catalog.map((c) => [c.input_id, { id: c.input_id, name: c.input_id }])),
      states: {},
    },
    receipts: {},
    usage,
    recordedAttempts,
  };
  for (const task of plan) {
    const saved = savedTasks[task.id];
    if (!saved) throw new Error("任务状态缺失：" + task.id);
    const {
      receipt,
      stage: _stage,
      inputIds: _inputIds,
      dependencies: _dependencies,
      data: _data,
      ...status
    } = saved;
    state.manifest.states[task.id] = status;
    if (taskIds && !taskIds.has(task.id)) continue;
    if (!receipt) continue;
    const { evaluationPatch, submittedPatch, rewriteIds, ...value } = receipt;
    if (!receipt.exported) {
      state.receipts[task.id] = {
        ...value,
        ...(submittedPatch ? { submitted: restore(value.evaluation, submittedPatch) } : {}),
      } as SubmissionReceipt;
      continue;
    }
    const data = task.data as TaskData;
    if (data.stage === "criteria" || receipt.exported.file === "comparison-review.jsonl") {
      const resultId = receipt.exported.taskId ?? receipt.exported.comparisonId!;
      const row = resultRow(receipt, { id: resultId, file: receipt.exported.file ?? resultFile(data.stage) });
      if (row.task_id !== task.id || row.evaluation_type !== (data.stage === "criteria" ? "criteria" : "comparison_review"))
        throw new Error("阶段结果身份不一致：" + task.id);
      const evaluation = restore(row.result, evaluationPatch || []);
      state.receipts[task.id] = { ...value, evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: { id: resultId, file: receipt.exported.file ?? resultFile(data.stage), row } };
      continue;
    }
    if (data.stage === "clustering") {
      const scope = data.scope!;
      if (receipt.exported.taskId !== task.id)
        throw new Error("聚类结果引用与任务不一致：" + task.id);
      const file = receipt.exported.file || resultFile("clustering");
      const row = resultRow(receipt, { id: receipt.exported.taskId, file });
      if (
        row.clustering_type !== "problem_library" ||
        row.task_id !== task.id ||
        row.model !== scope.version ||
        row.batch_id !== scope.batch_id
      )
        throw new Error("聚类结果身份不一致：" + task.id);
      const evaluation = restore(resultEvaluation(data, row), evaluationPatch || []);
      state.receipts[task.id] = {
        ...value,
        evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: {
          id: task.id,
          ...(receipt.exported.file ? { file: receipt.exported.file } : {}),
          row,
        },
      };
      continue;
    }
    if (data.stage === "rewrite") {
      const source = data.rewriteOf!;
      if (receipt.exported.taskId !== source.resultId)
        throw new Error("改写结果引用与源任务不一致：" + task.id);
      const file = receipt.exported.file || resultFile(source.stage);
      const row = resultRow(receipt, { id: receipt.exported.taskId, file }, source.stage);
      if (
        (row.task_id ?? row.comparison_id) !== source.resultId ||
        (data.rewriteScope
          ? row.batch_id !== data.rewriteScope.batch_id
          : canonical(row.case) !== canonical({ batch_id: data.case!.batch_id, case_id: data.case!.case_id }))
      )
        throw new Error("改写结果身份不一致：" + task.id);
      const evaluation = restore(resultEvaluation(data, row, rewriteIds), evaluationPatch || []);
      state.receipts[task.id] = {
        ...value,
        evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: {
          id: source.resultId,
          auxiliary: true,
          ...(receipt.exported.file ? { file: receipt.exported.file } : {}),
          row,
        },
      };
      continue;
    }
    const correctness = data.stage === "attribution";
    if (correctness ? receipt.exported.taskId !== task.id : !receipt.exported.comparisonId)
      throw new Error("结果引用类型或任务身份不一致：" + task.id);
    const resultId = receipt.exported.taskId ?? receipt.exported.comparisonId!;
    const file = receipt.exported.file || resultFile(correctness ? "attribution" : "comparison");
    const row = resultRow(receipt, { file, id: resultId });
    if (
      canonical(row.case) !==
        canonical({
          batch_id: data.candidates.A.batch_id,
          case_id: data.candidates.A.case_id,
        }) ||
      (correctness &&
        (row.evaluation_type !== "attribution" ||
          row.input_id !== task.inputIds.answer ||
          row.version !== data.candidates.A.version ||
          row.submission_id !== receipt.submissionId))
    )
      throw new Error("结果文件缺失或身份不一致：" + resultId);
    const evaluation = restore(resultEvaluation(data, row), evaluationPatch || []);
    state.receipts[task.id] = {
      ...value,
      evaluation,
      ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
      exported: {
        id: resultId,
        ...(receipt.exported.file ? { file: receipt.exported.file } : {}),
        row,
      },
    };
  }
  return state;
}

export const comparisonCodec: RunCodec<Checkpoint> = {
  encode: encodeState,
  decode: decodeState,
  resultId: (row) => String(row.task_id ?? row.comparison_id),
  references(checkpoint, taskIds) {
    if (checkpoint.format !== "evaluation-run") throw new Error("不支持此运行格式；只支持 evaluation-run。");
    return Object.entries(checkpoint.tasks).flatMap(([id, task]) => {
      if (taskIds && !taskIds.has(id)) return [];
      const ref = task.receipt?.exported;
      return ref
        ? [
            {
              id: ref.taskId ?? ref.comparisonId!,
              file: ref.file || resultFile(task.stage),
            },
          ]
        : [];
    });
  },
};
