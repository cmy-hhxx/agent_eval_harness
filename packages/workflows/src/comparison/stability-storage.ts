import type { JsonObject, PlannedTask, ResultReference, RunState, SubmissionReceipt } from "@eval/contracts";
import { createRunRepository, type RunCodec } from "@eval/data";
import type { Candidate, TaskData } from "./types.js";

interface SavedTask extends Omit<PlannedTask, "data"> { data: Omit<TaskData, "candidates"> & { candidateIds: Record<string, string> } }
interface Checkpoint {
  manifest: Omit<RunState["manifest"], "tasks"> & { tasks: SavedTask[] };
  receipts: Record<string, Omit<SubmissionReceipt, "evaluation" | "submitted" | "exported"> & {
    result?: ResultReference; evaluation?: unknown; submitted?: unknown;
  }>;
  usage: RunState["usage"];
  recordedAttempts: number;
}
const codec: RunCodec<Checkpoint> = {
  encode(state) {
    return { ...state, manifest: { ...state.manifest, tasks: state.manifest.tasks.map(task => {
      const { candidates, ...data } = task.data as TaskData;
      return { ...task, data: { ...data, candidateIds: Object.fromEntries(Object.entries(candidates).map(([label, value]) => [label, value.input_id])) } };
    }) }, receipts: Object.fromEntries(Object.entries(state.receipts).map(([id, receipt]) => {
      const { evaluation, submitted, exported, ...metadata } = receipt;
      // Host first checkpoints the accepted receipt, then writes result rows, then replaces the body with a reference.
      return [id, { ...metadata, ...(exported ? { result: { file: "stability-results.jsonl", id } } :
        { evaluation, ...(submitted === undefined ? {} : { submitted }) }) }];
    })) };
  },
  references(saved, ids) {
    if (!saved.manifest || !(saved.manifest.config as { stability?: unknown }).stability)
      throw new Error("Not a stability experiment checkpoint");
    return Object.entries(saved.receipts).flatMap(([id, receipt]) => (!ids || ids.has(id)) && receipt.result ? [receipt.result] : []);
  },
  resultId: row => String(row.task_id),
  decode(saved, readRow, ids) {
    if (!saved.manifest || !(saved.manifest.config as { stability?: unknown }).stability)
      throw new Error("Not a stability experiment checkpoint");
    const catalog = new Map((saved.manifest.inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate]));
    const tasks = saved.manifest.tasks.map(task => {
      const { candidateIds, ...data } = task.data;
      const candidates = Object.fromEntries(Object.entries(candidateIds).map(([label, id]) => {
        const candidate = catalog.get(id);
        if (!candidate) throw new Error("Missing experiment input reference: " + id);
        return [label, candidate];
      }));
      return { ...task, data: { ...data, candidates } };
    });
    const receipts: RunState["receipts"] = {};
    for (const [id, savedReceipt] of Object.entries(saved.receipts)) {
      if (ids && !ids.has(id)) continue;
      const { result, ...metadata } = savedReceipt;
      if (!result) {
        if (!Object.hasOwn(metadata, "evaluation")) throw new Error("Experiment checkpoint lost its accepted receipt: " + id);
        receipts[id] = { ...metadata, evaluation: metadata.evaluation };
        continue;
      }
      const row = readRow(result);
      if (row.task_id !== id || !Object.hasOwn(row, "evaluation")) throw new Error("Invalid experiment result: " + id);
      receipts[id] = { ...metadata, evaluation: row.evaluation,
        ...(Object.hasOwn(row, "submitted") ? { submitted: row.submitted } : {}), exported: { ...result, row } };
    }
    return { ...saved, manifest: { ...saved.manifest, tasks }, receipts };
  },
};

/** Dedicated rows keep experimental rewrites independent and never enter formal comparison exports. */
export const stabilityRepository = createRunRepository(codec, (task, state) => {
  const receipt = state.receipts[task.id]!;
  const row: JsonObject = { task_id: task.id, stage: task.stage, evaluation: receipt.evaluation,
    evaluator_version: receipt.evaluatorVersion, judge: receipt.judge,
    ...(receipt.submitted === undefined ? {} : { submitted: receipt.submitted }) };
  return { file: "stability-results.jsonl", id: task.id, row };
});
