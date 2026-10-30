import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { createRunRepository, type RunCodec, type ResultEncoder } from "@eval/data";
import { clusteringProfile } from "@eval/agents/clustering";
import { rewriteProfile } from "@eval/agents/rewrite";
import { difference, restore } from "@eval/contracts";
import { clusteringJobItems, jobBatchIds, jobObservations, type ClusteringJobConfig, type ClusteringJobRow, type ClusteringJobTask } from "./clustering-job-types.js";
import rowSchema from "../../../../schemas/workflow/clustering-job.schema.json" with { type: "json" };

type StoredReceipt = Omit<SubmissionReceipt, "evaluation" | "submitted" | "exported"> & {
  result?: { id: string; file: string };
  evaluation?: unknown;
  submittedPatch?: ReturnType<typeof difference>;
};
interface Checkpoint extends Omit<RunState, "receipts"> {
  kind: "clustering-job";
  receipts: Record<string, StoredReceipt>;
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRow = ajv.compile(rowSchema);
const validators = { clustering: ajv.compile(clusteringProfile.resultSchema!), rewrite: ajv.compile(rewriteProfile.resultSchema!) };
function checkedRow(row: ClusteringJobRow) {
  if (!validateRow(row)) throw new Error("跨 run 聚类结果结构无效：" + ajv.errorsText(validateRow.errors));
  if (!validators[row.stage](row.result)) throw new Error("跨 run 聚类结果无效：" + ajv.errorsText(validators[row.stage].errors));
  return row;
}
const codec: RunCodec<Checkpoint> = {
  encode(state) {
    return { kind: "clustering-job", manifest: state.manifest, usage: state.usage, recordedAttempts: state.recordedAttempts,
      receipts: Object.fromEntries(Object.entries(state.receipts).map(([id, receipt]) => {
        const { evaluation, submitted, exported, ...metadata } = receipt;
        return [id, { ...metadata,
          ...(exported ? { result: { id: exported.id, file: exported.file! } } : { evaluation }),
          ...(submitted === undefined ? {} : { submittedPatch: difference(evaluation, submitted) }) }];
      })) };
  },
  references(checkpoint, selected) {
    if (checkpoint.kind !== "clustering-job") throw new Error("该目录不是独立聚类作业");
    return Object.entries(checkpoint.receipts).flatMap(([id, receipt]) =>
      receipt.result && (!selected || selected.has(id)) ? [receipt.result] : []);
  },
  resultId: row => String(row.task_id),
  decode(checkpoint, getRow, selected) {
    if (checkpoint.kind !== "clustering-job" || !(checkpoint.manifest.config as ClusteringJobConfig).clusteringJob)
      throw new Error("该目录不是独立聚类作业");
    const state: RunState = { manifest: checkpoint.manifest, usage: checkpoint.usage,
      recordedAttempts: checkpoint.recordedAttempts, receipts: {} };
    for (const [id, saved] of Object.entries(checkpoint.receipts)) {
      if (selected && !selected.has(id)) continue;
      const { result, submittedPatch, ...receipt } = saved;
      const task = state.manifest.tasks.find(task => task.id === id);
      if (!task || !state.manifest.states[id] || saved.taskId !== id) throw new Error("聚类作业收据缺少对应任务：" + id);
      const data = task.data as ClusteringJobTask;
      const row = result ? checkedRow(getRow(result) as ClusteringJobRow) : undefined;
      if (row && (result!.id !== id || result!.file !== `${task.stage}.jsonl` || row.task_id !== id ||
        row.job_id !== state.manifest.runId || row.stage !== task.stage || row.model !== data.model ||
        row.submission_id !== receipt.submissionId || row.evaluator_version !== receipt.evaluatorVersion ||
        row.source_task_id !== data.rewriteOf || canonical(row.items.map(item => item.id)) !== canonical(data.itemIds)))
        throw new Error("聚类作业结果身份与收据不一致：" + id);
      const evaluation = row ? row.result : receipt.evaluation;
      state.receipts[id] = { ...receipt, evaluation,
        ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
        ...(row ? { exported: { ...result!, row } } : {}) };
    }
    return state;
  },
};
const encodeResult: ResultEncoder = (task, state, inputs) => {
  const receipt = state.receipts[task.id], data = task.data as ClusteringJobTask;
  const observations = jobObservations(inputs, data);
  const row = checkedRow({ job_id: state.manifest.runId, task_id: task.id,
    submission_id: receipt.submissionId, evaluator_version: receipt.evaluatorVersion,
    stage: task.stage as "clustering" | "rewrite", model: data.model,
    batch_ids: jobBatchIds(inputs, data),
    ...(data.rewriteOf ? { source_task_id: data.rewriteOf } : {}),
    items: clusteringJobItems(observations), result: receipt.evaluation });
  return { id: task.id, file: `${task.stage}.jsonl`, row, ...(data.rewriteOf ? { auxiliary: true } : {}) };
};
export const clusteringJobStorage = createRunRepository(codec, encodeResult);
