import { fileSourceReader } from "@eval/data";
import { object, type JsonObject } from "@eval/contracts";

export interface PredictionAnswer extends JsonObject {
  question_id: string;
  batch_id: string;
  text: string;
  question_time: string;
  prediction_results: PredictionTarget[];
}
export interface PredictionTarget extends JsonObject {
  target_id: string;
  start_date: string;
  end_date: string;
  status: string;
  answer: string;
  answer_scope: "actual_outcome" | "event_realization_only";
}
/** Coordinates of an accepted comparison, never a second copy of its original answers. */
export interface PredictionSelection {
  batchId: string;
  caseId: string;
  questionId: string;
  versions: string[];
  sourceRunId: string;
  sourceComparisonId: string;
  targetIds: string[];
}
export interface PredictionConfig {
  answersFile: string;
  evaluationTaskId: string;
  selections: PredictionSelection[];
}
export interface PredictionMetadata {
  source_evaluation_task_id: string;
  source_run_id: string;
  source_comparison_id: string;
  question_id: string;
  question_time: string;
  targets: { target_id: string; start_date: string; end_date: string }[];
}
const date = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
export const predictionKey = (batch: string, id: string) => JSON.stringify([batch, id]);

export async function readPredictionAnswers(file: string): Promise<Map<string, PredictionAnswer>> {
  const revision = await fileSourceReader.revision(file), answers = new Map<string, PredictionAnswer>();
  for await (const { line, index } of fileSourceReader.lines(file, revision)) {
    if (!line.trim()) continue;
    const row = object(JSON.parse(line));
    if (!text(row.question_id) || !date(row.batch_id) || !text(row.text) ||
        !text(row.question_time) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.question_time) ||
        !Number.isFinite(Date.parse(row.question_time)) || !Array.isArray(row.prediction_results) ||
        !row.prediction_results.length)
      throw new Error(`Invalid prediction answer identity/time: ${file}:${index}`);
    const ids = new Set<string>();
    for (const value of row.prediction_results) {
      const target = object(value);
      if (!text(target.target_id) || ids.has(target.target_id) || !date(target.start_date) ||
          !date(target.end_date) || target.start_date > target.end_date || !text(target.status) ||
          typeof target.answer !== "string" || !["actual_outcome", "event_realization_only"].includes(String(target.answer_scope)))
        throw new Error(`Invalid prediction target: ${file}:${index}`);
      ids.add(target.target_id);
    }
    const key = predictionKey(row.batch_id, row.question_id);
    if (answers.has(key)) throw new Error("Duplicate prediction question: " + key);
    answers.set(key, row as PredictionAnswer);
  }
  return answers;
}

/** Day-only deadlines mature after that Beijing calendar day; same-day forecasts need a precise cutoff. */
export function predictionReadiness(answer: PredictionAnswer, now = Date.now()) {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const asked = new Date(Date.parse(answer.question_time) + 8 * 3600_000).toISOString().slice(0, 10);
  const excluded: { targetId: string; reason: string }[] = [];
  const targets = answer.prediction_results.filter(target => {
    const reason = target.end_date < asked ? "target_before_question" :
      target.end_date === asked ? "same_day_cutoff_missing" :
      target.answer_scope !== "actual_outcome" ? "probability_not_verifiable_from_one_outcome" : undefined;
    if (reason) excluded.push({ targetId: target.target_id, reason });
    return !reason;
  });
  const ready = targets.length > 0 && targets.every(target =>
    target.end_date < today && target.status === "resolved" && !!target.answer.trim());
  return { targets, excluded, ready };
}

export function predictionMaterial(config: PredictionConfig, selection: PredictionSelection, answer: PredictionAnswer) {
  const readiness = predictionReadiness(answer);
  if (!readiness.ready || selection.targetIds.length !== readiness.targets.length ||
      !selection.targetIds.every(id => readiness.targets.some(target => target.target_id === id)))
    throw new Error("Prediction is not ready or its target scope changed: " + selection.questionId);
  const metadata: PredictionMetadata = {
    source_evaluation_task_id: config.evaluationTaskId,
    source_run_id: selection.sourceRunId,
    source_comparison_id: selection.sourceComparisonId,
    question_id: answer.question_id,
    question_time: answer.question_time,
    targets: readiness.targets.map(({ target_id, start_date, end_date }) => ({ target_id, start_date, end_date })),
  };
  return {
    metadata,
    reference: {
      evaluation_purpose: "prediction",
      question_time: answer.question_time,
      prediction_results: readiness.targets,
      excluded_targets: readiness.excluded,
      excluded_non_forecast_parts: answer.excluded_non_forecast_parts ?? [],
    },
  };
}
