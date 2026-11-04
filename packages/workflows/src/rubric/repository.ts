import { difference, restore, type JsonObject, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { createRunRepository, type RunCodec } from "@eval/data";
import { businessResultRepository } from "../review/business-result-repository.js";
import type { Candidate, RawInput } from "@eval/workflows/inputs";

type StoredReceipt = Omit<SubmissionReceipt, "evaluation" | "submitted" | "exported"> & {
  result?: {id: string; file: string; line?: number};
  evaluation?: unknown;
  submittedPatch?: ReturnType<typeof difference>;
};

/** Rubric runs keep the same checkpoint shape as every other run, with their own kind tag. */
interface Checkpoint extends Omit<RunState, "receipts"> {
  kind: "rubric";
  receipts: Record<string, StoredReceipt>;
}

const codec: RunCodec<Checkpoint> = {
  encode(state) {
    return {kind: "rubric", manifest: state.manifest, usage: state.usage, recordedAttempts: state.recordedAttempts,
      receipts: Object.fromEntries(Object.entries(state.receipts).map(([id, receipt]) => {
        const {evaluation, submitted, exported, ...metadata} = receipt;
        return [id, {...metadata,
          ...(exported ? {result: {id: exported.id, file: exported.file!, line: exported.line}} : {evaluation}),
          ...(submitted === undefined ? {} : {submittedPatch: difference(evaluation, submitted)})}];
      }))};
  },
  references(checkpoint, selected) {
    if (checkpoint.kind !== "rubric") throw new Error("该目录不是 rubric 运行");
    return Object.entries(checkpoint.receipts).flatMap(([id, receipt]) =>
      receipt.result && (!selected || selected.has(id)) ? [receipt.result] : []);
  },
  resultId: row => {
    const id = row.task_id;
    if (typeof id !== "string" || !id) throw new Error("rubric 结果缺少 task_id");
    return id;
  },
  decode(checkpoint, getRow, selected) {
    if (checkpoint.kind !== "rubric") throw new Error("该目录不是 rubric 运行");
    const state: RunState = {manifest: checkpoint.manifest, usage: checkpoint.usage,
      recordedAttempts: checkpoint.recordedAttempts, receipts: {}};
    for (const [id, saved] of Object.entries(checkpoint.receipts)) {
      if (selected && !selected.has(id)) continue;
      const {result, submittedPatch, ...receipt} = saved;
      const task = state.manifest.tasks.find(item => item.id === id);
      if (!task || !state.manifest.states[id] || saved.taskId !== id) throw new Error("rubric 收据缺少对应任务：" + id);
      const row = result ? getRow(result) : undefined;
      const evaluation = row ? row.result : saved.evaluation;
      state.receipts[id] = {...receipt, evaluation,
        ...(submittedPatch ? {submitted: restore(evaluation as JsonObject, submittedPatch)} : {}),
        ...(result ? {exported: {...result, row: row!}} : {})} as SubmissionReceipt;
    }
    return state;
  },
};

export const rubricRepository = businessResultRepository(createRunRepository(codec, (task, state, inputs) => {
  if (task.stage !== "rubric-case") return null;
  const receipt = state.receipts[task.id]!;
  if (receipt.exported) return receipt.exported;
  const {candidate} = task.data as {candidate: Candidate};
  const raw = inputs[candidate.input_id] as RawInput;
  return {id: task.id, file: "rubric.jsonl", row: {
    evaluation_type: "rubric", evaluator_version: receipt.evaluatorVersion, task_id: task.id,
    batch_id: candidate.batch_id, case_id: candidate.case_id, version: candidate.version,
    trace_meta: raw.turns?.map(turn => turn.meta ?? null) ?? [raw.meta ?? null],
    session_meta: raw.session_meta ?? raw.meta ?? null, source: raw._source ?? null, result: receipt.evaluation,
  }};
}));
