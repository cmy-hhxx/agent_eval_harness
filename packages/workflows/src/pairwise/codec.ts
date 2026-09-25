import { isDeepStrictEqual } from "node:util";
import type { JsonObject, RunManifest, RunState, SubmissionReceipt, TaskState } from "@eval/contracts";
import { canonical, type ResultReference } from "@eval/contracts";
import type { RunCodec } from "@eval/data";
import type { Candidate, EvalConfig, PairwiseResult, TaskData } from "./types.js";

type DiskReference = { file?: string; comparisonId?: string; taskId?: string };
type Patch = { path: string[]; value?: unknown }[];
type SavedReceipt = Omit<SubmissionReceipt, "exported" | "evaluation" | "submitted"> & {
  evaluation?: unknown;
  evaluationPatch?: Patch;
  submittedPatch?: Patch;
  exported?: DiskReference;
};
type SavedTask = TaskState & {
  stage: string;
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
        stage: task.stage,
        inputIds: task.inputIds,
        dependencies: task.dependencies,
        data,
      };
      const receipt = state.receipts[task.id];
      if (receipt) {
        const { exported, evaluation, submitted, ...rest } = receipt;
        const reference = exported && {
          ...(task.stage === "correctness" ? { taskId: exported.id } : { comparisonId: exported.id }),
          ...(exported.file ? { file: exported.file } : {}),
        };
        const evaluationPatch = exported
          ? difference(resultEvaluation(task.data as TaskData, exported.row), evaluation)
          : [];
        value.receipt = {
          ...rest,
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

function evaluationFromRow(data: TaskData, row: JsonObject): PairwiseResult {
  const labels = Object.fromEntries(
    Object.entries(data.candidates).map(([label, candidate]) => [candidate.version, label]),
  );
  const verdict = row.verdict as {
    result: string;
    winner_version: string | null;
    reason: string;
  };
  const basis = row.decision_basis as PairwiseResult["decision_basis"];
  return {
    verdict: {
      result:
        verdict.result === "win"
          ? (`${labels[verdict.winner_version!]}_better` as "A_better" | "B_better")
          : (verdict.result as PairwiseResult["verdict"]["result"]),
      reason: verdict.reason,
    },
    evaluations: Object.fromEntries(
      Object.entries(data.candidates).map(([label, candidate]) => {
        const review = (row.evaluations as Record<string, PairwiseResult["evaluations"][string]>)[
          candidate.version
        ];
        return [
          label,
          {
            summary: review.summary,
            findings: review.findings.map((finding) => {
              const { stage_trace: _trace, ...rest } = finding;
              return rest;
            }),
          },
        ];
      }),
    ),
    task_analysis: row.task_analysis as PairwiseResult["task_analysis"],
    decision_basis: {
      tradeoff: basis.tradeoff,
      decisive_findings: basis.decisive_findings.map((ref) => ({
        ...ref,
        candidate: labels[ref.candidate],
      })),
      counterevidence: basis.counterevidence.map((ref) => ({
        ...ref,
        candidate: labels[ref.candidate],
      })),
    },
  };
}

function resultEvaluation(data: TaskData, row: JsonObject): unknown {
  return data.stage === "correctness" ? row.evaluation : evaluationFromRow(data, row);
}

function decodeState(checkpoint: Checkpoint, getRow: (ref: ResultReference) => JsonObject): RunState {
  const { tasks: savedTasks, inputs, usage, recordedAttempts, ...metadata } = checkpoint;
  if (metadata.format !== "evaluation-run") throw new Error("不支持此运行格式；只支持 evaluation-run。");
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
          return [label, candidates[id]];
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
    if (!receipt) continue;
    const { evaluationPatch, submittedPatch, ...value } = receipt;
    if (!receipt.exported) {
      state.receipts[task.id] = {
        ...value,
        ...(submittedPatch ? { submitted: restore(value.evaluation, submittedPatch) } : {}),
      } as SubmissionReceipt;
      continue;
    }
    const data = task.data as TaskData;
    const correctness = data.stage === "correctness";
    if (correctness ? receipt.exported.taskId !== task.id : !receipt.exported.comparisonId)
      throw new Error("结果引用类型或任务身份不一致：" + task.id);
    const resultId = receipt.exported.taskId ?? receipt.exported.comparisonId!;
    const file =
      receipt.exported.file || (correctness ? "correctness.jsonl" : data.pair!.join("__vs__") + ".jsonl");
    const row = getRow({ file, id: resultId });
    if (
      canonical(row.case) !==
        canonical({
          batch_id: data.candidates.A.batch_id,
          case_id: data.candidates.A.case_id,
        }) ||
      (correctness &&
        (row.evaluation_type !== "correctness" ||
          row.input_id !== task.inputIds.A ||
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

export const pairwiseCodec: RunCodec<Checkpoint> = {
  encode: encodeState,
  decode: decodeState,
  resultId: (row) => String(row.task_id ?? row.comparison_id),
  references(checkpoint) {
    if (checkpoint.format !== "evaluation-run") throw new Error("不支持此运行格式；只支持 evaluation-run。");
    return Object.values(checkpoint.tasks).flatMap((task) => {
      const ref = task.receipt?.exported;
      return ref
        ? [
            {
              id: ref.taskId ?? ref.comparisonId!,
              file:
                ref.file ||
                (task.stage === "correctness"
                  ? "correctness.jsonl"
                  : task.data.pair!.join("__vs__") + ".jsonl"),
            },
          ]
        : [];
    });
  },
};
