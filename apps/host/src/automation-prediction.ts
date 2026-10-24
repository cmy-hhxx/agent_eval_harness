import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson, writeJson } from "@eval/data";
import type { RemoteDay } from "@eval/contracts";
import {
  predictionReadiness, readPredictionAnswers, type Checkpoint, type EvalConfig,
  type PredictionSelection,
} from "@eval/workflows/comparison";
import { loadAutomationConfig, type AutomationConfig } from "./automation-config.js";

export interface PredictionDay {
  date: string;
  runId: string;
  selections: PredictionSelection[];
}
interface PredictionScope {
  date: string;
  questionId: string;
  caseId: string;
  comparisonIds: string[];
}
export async function predictionOrigin(config: AutomationConfig) {
  if (!config.prediction) throw new Error("Prediction source missing");
  const source = await loadAutomationConfig(config.prediction.sourceConfig);
  if (source.prediction) throw new Error("Prediction source must reference an original evaluation task");
  if (source.predictionResults !== config.sourceDirectory)
    throw new Error("Original automation must register this predictionResults directory");
  if (source.publication.mongoCollection !== config.publication.mongoCollection ||
      source.publication.mongoDatabase !== config.publication.mongoDatabase ||
      source.publication.mongoUriEnv !== config.publication.mongoUriEnv)
    throw new Error("Prediction destination must match the original evaluation task");
  return source;
}
async function sourceCheckpoint(output: string, runId: string) {
  try { return await readJson<Checkpoint>(path.join(output, runId, "state.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Map by exact ID or unique same-date question text, then retain only existing accepted battles. */
export async function discoverPrediction(config: AutomationConfig, output: string, now = Date.now()) {
  const origin = await predictionOrigin(config);
  const answers = await readPredictionAnswers(config.prediction!.answersFile);
  let scope: PredictionScope[] = [];
  try { scope = await readJson(path.join(config.sourceDirectory, "scope.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!Array.isArray(scope) || scope.some(item => !item || typeof item.date !== "string" ||
      typeof item.questionId !== "string" || typeof item.caseId !== "string" ||
      !Array.isArray(item.comparisonIds) || item.comparisonIds.some(id => typeof id !== "string" || !id) ||
      new Set(item.comparisonIds).size !== item.comparisonIds.length) ||
      new Set(scope.map(item => JSON.stringify([item.date, item.questionId]))).size !== scope.length)
    throw new Error("Invalid prediction scope");
  const days = new Map<string, PredictionDay>(), checkpoints = new Map<string, Checkpoint | undefined>();
  const diagnostics: { questionId: string; date: string; reason: string; targetId?: string }[] = [];
  for (const answer of answers.values()) {
    if (config.fromDate && answer.batch_id < config.fromDate || config.throughDate && answer.batch_id > config.throughDate) continue;
    const date = answer.batch_id, runId = origin.runPrefix + date;
    if (!checkpoints.has(runId)) checkpoints.set(runId, await sourceCheckpoint(output, runId));
    const state = checkpoints.get(runId);
    const diagnostic = (reason: string, targetId?: string) =>
      diagnostics.push({ questionId: answer.question_id, date, reason, ...(targetId ? { targetId } : {}) });
    if (!state) { diagnostic("original_run_missing"); continue; }
    const candidates = Object.values(state.inputs).filter(input => input.batch_id === date);
    const registered = scope.find(item => item.date === date && item.questionId === answer.question_id);
    const byId = candidates.filter(input => input.case_id === (registered?.caseId ?? answer.question_id));
    const matches = byId.length ? byId : candidates.filter(input => input.question === answer.text);
    const ids = new Set(matches.map(input => input.case_id));
    if (ids.size !== 1 || matches.some(input => input.question !== answer.text))
      throw new Error(`Prediction original identity is missing or ambiguous: ${date}/${answer.question_id}`);
    const caseId = [...ids][0];
    let tasks = Object.values(state.tasks).filter(task => task.stage === "comparison" &&
      !task.data.verificationAudit && task.status === "succeeded" && task.receipt &&
      task.receipt.exported?.file !== "comparison-review.jsonl" &&
      Object.values(task.inputIds).every(id => state.inputs[id]?.case_id === caseId));
    if (registered) {
      if (registered.caseId !== caseId || registered.comparisonIds.some(id => !tasks.some(task => task.data.comparisonId === id)))
        throw new Error("Registered original prediction comparison is missing: " + answer.question_id);
      tasks = tasks.filter(task => registered.comparisonIds.includes(task.data.comparisonId!));
    } else scope.push({ date, questionId: answer.question_id, caseId,
      comparisonIds: tasks.map(task => task.data.comparisonId!) });
    if (!tasks.length) { diagnostic("no_accepted_comparison"); continue; }
    const readiness = predictionReadiness(answer, now);
    for (const target of readiness.excluded) diagnostic(target.reason, target.targetId);
    if (!readiness.ready) { diagnostic(readiness.targets.length ? "waiting_for_outcome" : "no_verifiable_forecast"); continue; }
    const day = days.get(date) ?? { date, runId: config.runPrefix + date, selections: [] };
    for (const task of tasks) {
      if (!task.data.comparisonId || !task.data.group || task.data.group.length !== 2)
        throw new Error("Original comparison identity missing: " + runId);
      const selection: PredictionSelection = {
        batchId: date, caseId, questionId: answer.question_id, versions: [...task.data.group].sort(),
        sourceRunId: runId, sourceComparisonId: task.data.comparisonId,
        targetIds: readiness.targets.map(target => target.target_id),
      };
      if (day.selections.some(item => item.caseId === caseId && isDeepStrictEqual(item.versions, selection.versions)))
        throw new Error("Duplicate prediction comparison: " + answer.question_id);
      day.selections.push(selection);
    }
    days.set(date, day);
  }
  return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), diagnostics, scope };
}
export function predictionRemoteDay(day: PredictionDay): RemoteDay {
  const models = new Map<string, Set<string>>();
  for (const selection of day.selections) for (const version of selection.versions) {
    if (!models.has(version)) models.set(version, new Set());
    models.get(version)!.add(selection.caseId);
  }
  return { date: day.date, rows: Object.fromEntries([...models].map(([id, cases]) => [id, cases.size])) };
}
export async function syncPrediction(config: AutomationConfig, output: string, date: string, beforeReplace: () => Promise<void>) {
  const discovered = await discoverPrediction(config, output), day = discovered.days.find(item => item.date === date);
  if (!day) throw new Error("Prediction targets are no longer ready: " + date);
  const file = path.join(config.sourceDirectory, date, "selection.json");
  let previous: PredictionDay | undefined;
  try { previous = await readJson(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const changed = !isDeepStrictEqual(previous, day);
  await writeJson(path.join(config.sourceDirectory, "scope.json"), discovered.scope);
  if (changed) { await beforeReplace(); await writeJson(file, day); }
  await writeJson(path.join(config.sourceDirectory, "exclusions.json"), discovered.diagnostics);
  return { changed, bytes: Buffer.byteLength(JSON.stringify(day)) };
}
export async function predictionEvaluationConfig(config: AutomationConfig, output: string, base: EvalConfig, date: string): Promise<EvalConfig> {
  const origin = await predictionOrigin(config);
  const day = await readJson<PredictionDay>(path.join(config.sourceDirectory, date, "selection.json"));
  if (day.date !== date || !day.selections.length) throw new Error("Prediction selection missing: " + date);
  const state = await sourceCheckpoint(output, origin.runPrefix + date);
  if (!state) throw new Error("Prediction original run missing: " + date);
  const original = state.config as EvalConfig, versions = new Set(day.selections.flatMap(item => item.versions));
  return {
    ...base,
    inputs: {
      default_batch_id: date, batches: [date], case_ids: [...new Set(day.selections.map(item => item.caseId))],
      versions: original.inputs.versions.filter(version => versions.has(version.id)).map(version => ({
        ...version, sources: [...new Set(Object.values(state.inputs).filter(input => input.version === version.id &&
          day.selections.some(item => item.caseId === input.case_id && item.versions.includes(version.id))).map(input => input.source))]
          .map(file => ({ kind: "file" as const, path: file })),
      })),
    },
    comparisons: [...new Map(day.selections.map(item => [JSON.stringify(item.versions), item.versions])).values()],
    prediction: { answersFile: config.prediction!.answersFile, evaluationTaskId: origin.id, selections: day.selections },
    clustering: { ...base.clustering, enabled: false },
  };
}
