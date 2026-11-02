import { attributionDimension } from "../review/dimensions.js";
import type { JsonObject, RunState, SubmissionReceipt } from "@eval/contracts";
import { canonical, difference, restore, type ResultReference } from "@eval/contracts";
import type { RunCodec } from "@eval/data";
import type { Candidate } from "../inputs/types.js";
import { compactFieldResult, type AttributionTaskData } from "@eval/workflows/attribution";
import type { ComparisonResult, EvalConfig, Stage, TaskData } from "./types.js";
import { originalResultRow, stageRewritten, resultFile, acceptedRewrites } from "./results.js";
import { analysisRunOverview } from "./analysis-progress.js";

import type { Checkpoint, Patch, SavedReceipt, SavedTask } from "./checkpoint.js";

// Accepted bodies are immutable and shared by checkpoint snapshots. Retain only
// their computed submission patch; replacing either body computes a fresh one.
const submissionPatches = new WeakMap<object, { submitted: unknown; patch: Patch }>();
function submissionDifference(evaluation: unknown, submitted: unknown): Patch {
  if (!evaluation || typeof evaluation !== "object") return difference(evaluation, submitted);
  const previous = submissionPatches.get(evaluation);
  if (previous && previous.submitted === submitted) return previous.patch;
  const patch = difference(evaluation, submitted);
  submissionPatches.set(evaluation, { submitted, patch });
  return patch;
}
const evaluationPatches = new WeakMap<object, { row: JsonObject; mapping: string; patch: Patch }>();
function evaluationDifference(data: TaskData, row: JsonObject, evaluation: unknown, rewriteIds?: string[]): Patch {
  if (!evaluation || typeof evaluation !== "object")
    return difference(resultEvaluation(data, row, rewriteIds), evaluation);
  const mapping = JSON.stringify([data.stage, data.rewriteOf?.stage,
    Object.entries(data.candidates).map(([label, candidate]) => [label, candidate.version])]);
  const previous = evaluationPatches.get(evaluation);
  if (previous?.row === row && previous.mapping === mapping) return previous.patch;
  const patch = difference(resultEvaluation(data, row, rewriteIds), evaluation);
  evaluationPatches.set(evaluation, { row, mapping, patch });
  return patch;
}
function encodeState(state: RunState): Checkpoint {
  const { tasks, states, inputs: _inputs, inputCatalog, ...metadata } = state.manifest;
  const attributions = new Map(tasks.filter(task => task.stage === "attribution-session").map(task => [
    canonical([(task.data as AttributionTaskData).candidate?.input_id, (task.data as JsonObject).attributionIdentity]), state.receipts[task.id]?.exported,
  ]));
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
      batches: config.inputs.batches || (metadata.preflight.sharded ? undefined : Object.keys(metadata.preflight.by_batch || {})),
    },
  };
  const saved = Object.fromEntries(
    tasks.map((task) => {
      const taskData = task.data as TaskData;
      if ((taskData.verificationAudit || taskData.verificationOf) &&
        (task.stage !== "comparison" || taskData.verificationAudit !== true || !taskData.verificationOf?.taskId))
        throw new Error("可选核验必须同时声明核验标记与正式对比来源。");
      const { candidates: _candidates, referenceCandidates: _peers, stage: _stage, revision, ...data } = task.data as TaskData;
      const value: SavedTask = {
        ...states[task.id],
        revision: revision || 1,
        stage: task.stage as Stage,
        inputIds: task.inputIds,
        dependencies: task.dependencies,
        ...(task.settledDependencies ? { settledDependencies: task.settledDependencies } : {}),
        data,
      };
      const receipt = state.receipts[task.id];
      if (receipt) {
        const { exported, evaluation, submitted, ...rest } = receipt;
        const compactId = (task.data as AttributionTaskData).compactTaskId;
        const compact = (task.data as AttributionTaskData).compactField && compactId && state.receipts[compactId]?.exported;
        if (compact) {
          value.receipt = { ...rest, compact: { id: compact.id, file: compact.file, line: compact.line },
            evaluationPatch: difference(compactFieldResult(compact.row, (task.data as AttributionTaskData).compactField!, (task.data as AttributionTaskData).traceIndex), evaluation),
            ...(submitted !== undefined ? { submittedPatch: submissionDifference(evaluation, submitted) } : {}) };
          return [task.id, value];
        }
        const parent = ["attribution-component", "attribution-trace"].includes(task.stage) && attributions.get(
          canonical([(task.data as AttributionTaskData).candidate.input_id, (task.data as JsonObject).attributionIdentity]));
        if (parent) {
          const base = (parent.row as { turns: unknown[] }).turns[(task.data as AttributionTaskData).traceIndex!];
          value.receipt = { ...rest, attribution: { id: parent.id, file: parent.file, line: parent.line },
            evaluationPatch: difference(base, evaluation), ...(submitted !== undefined ? { submittedPatch: submissionDifference(evaluation, submitted) } : {}) };
          return [task.id, value];
        }
        const rewriteIds = task.stage === "rewrite"
          ? (evaluation as { rewrites: { id: string }[] }).rewrites.map((item) => item.id) : undefined;
        const reference = exported && {
          ...(task.stage === "comparison" && !taskData.verificationAudit
            ? { comparisonStatus: (evaluation as ComparisonResult).status } : {}),
          ...(task.stage === "comparison" && !(task.data as TaskData).verificationAudit && exported.file !== "comparison-review.jsonl" ? { comparisonId: exported.id } : { taskId: exported.id }),
          ...(exported.file ? { file: exported.file } : {}),
          ...(exported.line !== undefined ? { line: exported.line } : {}),
        };
        const evaluationPatch = exported
          ? evaluationDifference(task.data as TaskData, exported.row, evaluation, rewriteIds)
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
          ...(submitted !== undefined ? { submittedPatch: submissionDifference(evaluation, submitted) } : {}),
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
    status: row.status as ComparisonResult["status"],
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

export function resultEvaluation(data: TaskData, row: JsonObject, rewriteIds?: string[]): unknown {
  const dimension = attributionDimension(data.stage);
  if (dimension) return row[dimension.resultKey];
  if (data.stage === "rewrite") {
    const rewrites = (stageRewritten(data.rewriteOf!.stage,row) as { rewrites: { id: string; text: string }[] }).rewrites;
    return { rewrites: rewriteIds ? rewriteIds.map((id) => {
      const item = rewrites.find((item) => item.id === id);
      if (!item) throw new Error("改写槽位缺失：" + id);
      return item;
    }) : rewrites };
  }
  row = originalResultRow(data.stage, row);
  if (data.stage === "attribution-session" || data.stage === "attribution-compact") return row;
  if (data.stage === "criteria" || ["comparison_review", "comparison_verification"].includes(String(row.evaluation_type))) return row.result;
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
  const resultRow = (receipt: SavedReceipt, ref: ResultReference, rewritten?: { stage: string; evaluatorVersion: string }) => {
    const row = getRow(ref);
    if (!["attribution.jsonl", "compact.jsonl"].includes(ref.file!) &&
      (rewritten ? (stageRewritten(rewritten.stage,row) as JsonObject)?.evaluator_version : row.evaluator_version) !== (rewritten?.evaluatorVersion ?? receipt.evaluatorVersion))
      throw new Error("结果评测器版本与收据不一致：" + ref.id);
    return row;
  };
  const catalog = Object.entries(inputs).map(([input_id, c]) => ({
    ...c,
    input_id,
  }));
  const candidates = Object.fromEntries(catalog.map((c) => [c.input_id, c]));
  const plan = Object.entries(savedTasks).map(([id, t]) => {
    const attribution = t.stage.startsWith("attribution-")
      ? candidates[(t.data as unknown as AttributionTaskData).candidate.input_id] : undefined;
    if (t.stage.startsWith("attribution-") && !attribution) throw new Error("归因输入引用缺失：" + id);
    return {
      id,
      stage: t.stage,
      inputIds: t.inputIds,
      dependencies: t.dependencies,
      ...(t.settledDependencies ? { settledDependencies: t.settledDependencies } : {}),
      data: {
        ...t.data,
        stage: t.stage,
        revision: t.revision || 1,
        ...(attribution && Object.keys(t.inputIds).some(key => key !== "answer") ? { referenceCandidates: Object.fromEntries(
          Object.entries(t.inputIds).filter(([key]) => key !== "answer").map(([key, id]) => {
            if (!candidates[id]) throw new Error("事实复核输入引用缺失：" + id);
            return [key, candidates[id]];
          })) } : {}),
        candidates: attribution ? { A: attribution } : Object.fromEntries(
          Object.entries(t.inputIds).map(([label, id]) => {
            if (!candidates[id]) throw new Error("输入引用缺失：" + id);
            return [attributionDimension(t.stage) ? "A" : label, candidates[id]];
          }),
        ),
        ...(attribution ? { candidate: attribution } : {}),
      },
    };
  });
  for (const task of plan) {
    const data = task.data as TaskData;
    if ((data.verificationAudit || data.verificationOf) &&
      (task.stage !== "comparison" || data.verificationAudit !== true || !data.verificationOf?.taskId))
      throw new Error("可选核验必须同时声明核验标记与正式对比来源。");
  }
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
  const savedReceipts = Object.fromEntries(Object.entries(savedTasks).map(([id, task]) => [id, task.receipt]));
  for (const task of plan) {
    const saved = savedTasks[task.id];
    if (!saved) throw new Error("任务状态缺失：" + task.id);
    const {
      receipt,
      stage: _stage,
      inputIds: _inputIds,
      dependencies: _dependencies,
      settledDependencies: _settledDependencies,
      data: _data,
      ...status
    } = saved;
    state.manifest.states[task.id] = status;
    if (taskIds && !taskIds.has(task.id)) continue;
    if (!receipt) continue;
    const { evaluationPatch, submittedPatch, rewriteIds, compact, attribution, ...value } = receipt;
    if (compact) {
      const row = getRow(compact);
      const info = task.data as AttributionTaskData, evaluation = restore(compactFieldResult(row, info.compactField!, info.traceIndex), evaluationPatch ?? []);
      state.receipts[task.id] = { ...value, evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}) } as SubmissionReceipt;
      continue;
    }
    if (attribution) {
      const base = (getRow(attribution) as { turns: unknown[] }).turns[(task.data as AttributionTaskData).traceIndex!];
      const evaluation = restore(base, evaluationPatch ?? []);
      state.receipts[task.id] = { ...value, evaluation, ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}) } as SubmissionReceipt;
      continue;
    }
    if (!receipt.exported) {
      state.receipts[task.id] = {
        ...value,
        ...(submittedPatch ? { submitted: restore(value.evaluation, submittedPatch) } : {}),
      } as SubmissionReceipt;
      continue;
    }
    const data = task.data as TaskData;
    if (data.stage === "attribution-session" || data.stage === "attribution-compact") {
      const file = resultFile(data.stage);
      if (receipt.exported.taskId !== task.id || receipt.exported.file !== file)
        throw new Error("归因 session 结果引用与任务不一致：" + task.id);
      const reference = { id: task.id, file, line: receipt.exported.line };
      const row = resultRow(receipt, reference);
      const evaluation = restore(row, evaluationPatch || []);
      state.receipts[task.id] = { ...value, evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: { ...reference, row } };
      continue;
    }
    const dimension = attributionDimension(data.stage);
    if (dimension) {
      const file = resultFile(data.stage), row = resultRow(receipt, { id: task.id, file });
      if (row.task_id !== task.id || row.source_attribution_task_id !== task.dependencies.source || row.evaluation_type !== dimension.resultKey)
        throw new Error("维度归因结果与归因来源不一致：" + task.id);
      const evaluation = restore(row[dimension.resultKey], evaluationPatch || []);
      state.receipts[task.id] = { ...value, evaluation, ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: { id: task.id, file, row } };
      continue;
    }
    if (data.stage === "criteria" || data.verificationAudit || receipt.exported.file === "comparison-review.jsonl") {
      const resultId = receipt.exported.taskId ?? receipt.exported.comparisonId!;
      if (data.verificationAudit && (receipt.exported.taskId !== task.id || receipt.exported.file !== "comparison-verification.jsonl"))
        throw new Error("可选复核结果引用与任务不一致：" + task.id);
      const row = resultRow(receipt, { id: resultId, file: receipt.exported.file ?? resultFile(data.stage) });
      if (row.task_id !== task.id || row.evaluation_type !== (data.stage === "criteria" ? "criteria" : data.verificationAudit ? "comparison_verification" : "comparison_review"))
        throw new Error("阶段结果身份不一致：" + task.id);
      if (data.verificationAudit && (row.comparison_id !== data.comparisonId || row.source_task_id !== data.verificationOf?.taskId))
        throw new Error("可选复核来源身份不一致：" + task.id);
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
      if (source.stage === "attribution" ? receipt.exported.taskId !== task.id : receipt.exported.taskId !== source.resultId)
        throw new Error("改写结果引用与源任务不一致：" + task.id);
      const file = receipt.exported.file || (source.stage === "attribution" ? "rewrite.jsonl" : resultFile(source.stage));
      const latest = acceptedRewrites(plan, savedReceipts, source.taskId).filter(item => item.receipt.exported).at(-1)!.receipt;
      const row = resultRow(receipt, { id: receipt.exported.taskId!, file }, { stage: source.stage, evaluatorVersion: latest.evaluatorVersion });
      if (source.stage === "attribution" && (row.evaluation_type !== "attribution_rewrite" ||
        row.task_id !== task.id || row.source_attribution_task_id !== source.taskId))
        throw new Error("归因改写结果身份不一致：" + task.id);
      if (
        (source.stage === "attribution" ? row.source_attribution_task_id : row.task_id ?? row.comparison_id) !== source.resultId ||
        (data.rewriteScope
          ? row.batch_id !== data.rewriteScope.batch_id
          : canonical(source.stage==="attribution"?{batch_id:row.batch_id,case_id:row.case_id}:row.case) !== canonical({ batch_id: data.case!.batch_id, case_id: data.case!.case_id }))
      )
        throw new Error("改写结果身份不一致：" + task.id);
      const evaluation = restore(resultEvaluation(data, row, rewriteIds), evaluationPatch || []);
      state.receipts[task.id] = {
        ...value,
        evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        exported: {
          id: source.stage === "attribution" ? task.id : source.resultId,
          auxiliary: true,
          ...(receipt.exported.file ? { file: receipt.exported.file } : {}),
          row,
        },
      };
      continue;
    }
    if (!receipt.exported.comparisonId)
      throw new Error("结果引用类型或任务身份不一致：" + task.id);
    const resultId = receipt.exported.taskId ?? receipt.exported.comparisonId!;
    const file = receipt.exported.file || resultFile("comparison");
    const row = resultRow(receipt, { file, id: resultId });
    if (
      canonical(row.case) !==
        canonical({
          batch_id: data.candidates.A.batch_id,
          case_id: data.candidates.A.case_id,
        }) ||
      row.comparison_id !== resultId
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
  for (const [id, receipt] of Object.entries(state.receipts)) {
    const line = savedTasks[id].receipt?.exported?.line;
    if (receipt.exported && line !== undefined) receipt.exported.line = line;
  }
  return state;
}

export const comparisonCodec: RunCodec<Checkpoint> = {
  encode: encodeState,
  overview: analysisRunOverview,
  decode: decodeState,
  resultId: (row) => {
    const id = row.task_id ?? row.comparison_id;
    if (typeof id !== "string" || !id) throw new Error("结果缺少内部身份；归因结果必须通过检查点行引用读取");
    return id;
  },
  references(checkpoint, taskIds) {
    if (checkpoint.format !== "evaluation-run") throw new Error("不支持此运行格式；只支持 evaluation-run。");
    return Object.entries(checkpoint.tasks).flatMap(([id, task]) => {
      if (taskIds && !taskIds.has(id)) return [];
      if (task.receipt?.compact) return [task.receipt.compact];
      if (task.receipt?.attribution) return [task.receipt.attribution];
      const ref = task.receipt?.exported;
      return ref
        ? [
            {
              id: ref.taskId ?? ref.comparisonId!,
              file: ref.file || resultFile(task.stage),
              ...(ref.line !== undefined ? { line: ref.line } : {}),
            },
          ]
        : [];
    });
  },
};
