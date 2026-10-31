import { canonical, safeId, type PlannedTask, type RunState } from "@eval/contracts";
import { businessDate, type BusinessAnswer } from "@eval/data";
import type { Candidate } from "../inputs/types.js";
import { isDeepStrictEqual } from "node:util";

export function businessCandidates(task: PlannedTask, state: RunState): Candidate[] {
  const data = task.data as { candidate?: Candidate; candidates?: Record<string, Candidate>; rewriteOf?: { taskId: string } };
  if (data.rewriteOf) {
    const source = state.manifest.tasks.find(item => item.id === data.rewriteOf!.taskId);
    return source ? businessCandidates(source, state) : [];
  }
  return data.candidate ? [data.candidate] : Object.values(data.candidates ?? {});
}
export function businessAnswer(candidate: Candidate): BusinessAnswer {
  return { id: candidate.answer_id ?? candidate.input_id, batch: candidate.batch_id, caseId: candidate.case_id,
    model: candidate.version, session: candidate.session_id ?? null,
    traces: candidate.turns?.map(turn => turn.trace_id) ?? [candidate.trace_id],
    source: candidate.source, line: candidate.line, ...(candidate.source_revision ? { revision: candidate.source_revision } : {}) };
}
export function answerBusinessKey(value: Pick<BusinessAnswer, "batch" | "caseId" | "model" | "session" | "traces">) {
  return canonical([value.batch, value.caseId, value.model, value.session, value.traces]);
}
/** Conditions that change the evaluated material, excluding run IDs and evaluator settings. */
export function businessScope(task: PlannedTask) {
  const data = task.data as Record<string, unknown>;
  if (task.stage === "attribution-compact") return {};
  return { hasReference: data.reference !== null && data.reference !== undefined,
    hasReviewQuestions: Array.isArray(data.reviewQuestions) && data.reviewQuestions.length > 0,
    criteriaScope: data.criteriaScope ?? null,
    prediction: data.prediction !== undefined, verification: data.verificationAudit === true,
    standardAnswerReview: data.standardAnswerReview === true,
    ...(!["criteria", "attribution-session", "comparison"].includes(task.stage) ? { instance: task.id, scope: data.scope ?? null } : {}) };
}
/** Compare source-owned material in its original ledger, without copying it into an index. */
export function sameBusinessMaterial(first: PlannedTask, second: PlannedTask): boolean {
  const a = first.data as Record<string, unknown>, b = second.data as Record<string, unknown>;
  return ["reference", "reviewQuestions", "prediction"].every(key => isDeepStrictEqual(a[key] ?? null, b[key] ?? null)) &&
    isDeepStrictEqual(businessScope(first), businessScope(second));
}
export function businessResultKey(stage: string, answers: BusinessAnswer[], scope: unknown) {
  return canonical([stage, answers.map(answer => [answer.model, answer.id]).sort(), scope]);
}
export function completeBusinessResult(task: PlannedTask, state: RunState) {
  const seen = new Set<string>(), tasks = new Map(state.manifest.tasks.map(item => [item.id, item]));
  const visit = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const current = tasks.get(id);
    return !!current && state.manifest.states[id]?.status === "succeeded" &&
      !state.receipts[id]?.incompleteDependencies?.length && Object.values(current.dependencies).every(visit);
  };
  return visit(task.id) && !(task.stage === "comparison" &&
    (state.receipts[task.id]?.evaluation as { status?: string } | undefined)?.status === "needs_review");
}
export function businessDestination(task: PlannedTask, state: RunState, file: string) {
  const candidates = businessCandidates(task, state), data = task.data as Record<string, unknown>;
  const scope = data.scope as { batch_id: string; version: string } | undefined;
  const date = businessDate(candidates[0]?.batch_id ?? scope?.batch_id ?? "");
  if (candidates.some(candidate => candidate.batch_id !== date)) throw new Error("同一正式结果混入不同业务日期");
  safeId(file);
  if (task.stage === "criteria") return { date, file: "criteria/criteria-" + date + ".jsonl" };
  const models = [...new Set(candidates.map(candidate => candidate.version))].sort();
  if (!models.length && scope?.version) models.push(scope.version);
  for (const model of models) safeId(model);
  if (!models.length) throw new Error("正式结果缺少被评模型");
  if (models.length === 1) return { date, file: models[0] + "/" +
    (file === "attribution.jsonl" ? "" : file.replace(/\.jsonl$/, "") + "/") + models[0] +
    (["attribution.jsonl", "compact.jsonl"].includes(file) ? "_" + file.replace(/\.jsonl$/, "") : "") + "-" + date + ".jsonl" };
  if (models.some(model => model.includes("_vs_"))) throw new Error("业务交付模型 ID 不能包含 _vs_ 分隔符");
  const pair = models.join("_vs_");
  return { date, file: file.replace(/\.jsonl$/, "") + "/" + pair + "/" + pair + "-" + date + ".jsonl" };
}
