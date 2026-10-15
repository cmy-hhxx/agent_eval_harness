import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonical, schemaIssues, ValidationError,
  type EvidenceReference, type ProblemEvent, type ProblemLibrary, type ProblemOccurrence,
} from "@eval/contracts";
import schema from "../../../../schemas/clustering/occurrence-review.schema.json" with { type: "json" };

export interface ProblemOccurrenceReviewDecision {
  id: string;
  model: string;
  items: { occurrence_id: string; reason: string; evidence: EvidenceReference[] }[];
}
export interface ProblemAssociation {
  input_id: string;
  finding_id: string;
  component_id: string;
}
export interface ProblemOccurrenceReviewTarget {
  occurrence_id: string;
  association: ProblemAssociation;
  class_id_at_review: string;
  origin: { run_id: string; task_id: string; submission_id: string };
  attribution: { task_id: string; submission_id: string };
}
export interface ProblemOccurrenceReviewDetail {
  evaluator_version: string;
  decision: ProblemOccurrenceReviewDecision;
  targets: ProblemOccurrenceReviewTarget[];
}
const validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
function fail(message: string): never { throw new Error(message); }
export const problemAssociationKey = (value: ProblemAssociation): string =>
  canonical([value.input_id, value.finding_id, value.component_id]);

export function problemAssociation(library: ProblemLibrary, occurrence: ProblemOccurrence): ProblemAssociation {
  const problem = library.classes[occurrence.class_id];
  if (!problem || !library.components[problem.component_id])
    return fail("问题样本缺少真实问题类或责任组件：" + occurrence.id);
  return { input_id: occurrence.input_id, finding_id: occurrence.finding_id, component_id: problem.component_id };
}

/** Validate the current operator request before it selects any file or model. */
export function validateProblemOccurrenceReviewDecision(decision: unknown): asserts decision is ProblemOccurrenceReviewDecision {
  if (!validator(decision)) throw new ValidationError(schemaIssues(validator.errors, decision));
}

/** Current maintenance requests have one explicit reason and source proof per exact UUID. */
export function validateProblemOccurrenceReview(
  library: ProblemLibrary, decision: unknown,
): asserts decision is ProblemOccurrenceReviewDecision {
  validateProblemOccurrenceReviewDecision(decision);
  const value = decision;
  if (value.model !== library.model) fail("问题库模型身份不一致：" + value.model);
  const selected = new Set<string>();
  for (const item of value.items) {
    if (!item.reason.trim()) fail("问题样本复核理由不能为空");
    if (selected.has(item.occurrence_id)) fail("问题样本复核目标重复：" + item.occurrence_id);
    selected.add(item.occurrence_id);
    const occurrence = library.occurrences.find(entry => entry.id === item.occurrence_id);
    if (!occurrence) fail("未知问题样本 UUID：" + item.occurrence_id);
    problemAssociation(library, occurrence);
  }
}

function reviewDetail(library: ProblemLibrary, event: ProblemEvent): ProblemOccurrenceReviewDetail {
  const detail = event.detail as unknown as ProblemOccurrenceReviewDetail;
  if (typeof detail.evaluator_version !== "string" || !detail.evaluator_version.trim() || !Array.isArray(detail.targets))
    fail("问题样本复核事件损坏：" + event.id);
  validateProblemOccurrenceReview(library, detail.decision);
  if (event.id !== detail.decision.id || detail.targets.length !== detail.decision.items.length)
    fail("问题样本复核事件身份或目标损坏：" + event.id);
  const ids = new Set<string>();
  for (const target of detail.targets) {
    if (!target || typeof target !== "object" || ids.has(target.occurrence_id) ||
      !detail.decision.items.some(item => item.occurrence_id === target.occurrence_id))
      fail("问题样本复核事件目标损坏：" + event.id);
    ids.add(target.occurrence_id);
    const occurrence = library.occurrences.find(item => item.id === target.occurrence_id)!;
    const problem = library.classes[target.class_id_at_review];
    if (!problem || problem.component_id !== target.association?.component_id ||
      canonical(problemAssociation(library, occurrence)) !== canonical(target.association) ||
      canonical(target.origin) !== canonical({
        run_id: occurrence.run_id, task_id: occurrence.task_id, submission_id: occurrence.submission_id,
      }) || typeof target.attribution?.task_id !== "string" || !target.attribution.task_id ||
      typeof target.attribution?.submission_id !== "string" || !target.attribution.submission_id)
      fail("问题样本复核事件的原来源或组件不一致：" + event.id);
  }
  return detail;
}

/** The immutable accepted rows remain present; withdrawals affect only the current view. */
export function effectiveProblemOccurrences(library: ProblemLibrary): ProblemOccurrence[] {
  const rejected = new Set<string>();
  const latest = new Map<string, string | null>();
  const byId = new Map(library.occurrences.map(item => [item.id, item]));
  const reviewIds = new Set<string>();
  for (const event of library.events) {
    if (event.type === "assignments_replaced") {
      const targets = event.detail.targets;
      if (!Array.isArray(targets) || typeof event.detail.submission_id !== "string")
        fail("重新归类事件损坏：" + event.id);
      for (const target of targets) {
        if (!target || typeof target !== "object" || Array.isArray(target) ||
          typeof target.input_id !== "string" || typeof target.finding_id !== "string" ||
          typeof target.component_id !== "string" || !library.components[target.component_id] ||
          (target.occurrence_id !== null && typeof target.occurrence_id !== "string")) fail("重新归类目标损坏：" + event.id);
        const association = { input_id: target.input_id, finding_id: target.finding_id, component_id: target.component_id };
        const key = problemAssociationKey(association);
        if (target.occurrence_id !== null) {
          const occurrence = byId.get(target.occurrence_id);
          if (!occurrence || problemAssociationKey(problemAssociation(library, occurrence)) !== key)
            fail("重新归类目标改变了问题身份或责任组件：" + event.id);
        }
        latest.set(key, target.occurrence_id);
      }
    }
    if (event.type !== "occurrence_rejected") continue;
    if (reviewIds.has(event.id)) fail("问题样本复核事件 UUID 重复：" + event.id);
    reviewIds.add(event.id);
    for (const target of reviewDetail(library, event).targets) rejected.add(problemAssociationKey(target.association));
  }
  return rejected.size || latest.size
    ? library.occurrences.filter(item => {
      const key = problemAssociationKey(problemAssociation(library, item));
      return !rejected.has(key) && (!latest.has(key) || latest.get(key) === item.id);
    })
    : library.occurrences;
}

/** A reused operation UUID must always mean the same explicit source-review decision. */
export function acceptedProblemOccurrenceReview(
  library: ProblemLibrary, decision: ProblemOccurrenceReviewDecision,
): ProblemOccurrenceReviewDetail | undefined {
  validateProblemOccurrenceReview(library, decision);
  const matches = library.events.filter(entry => entry.id === decision.id);
  if (matches.length > 1) fail("问题样本复核事件 UUID 重复：" + decision.id);
  const event = matches[0];
  if (!event) return undefined;
  if (event.type !== "occurrence_rejected") fail("问题样本复核 UUID 已被其他事件使用：" + decision.id);
  const detail = reviewDetail(library, event);
  if (canonical(detail.decision) !== canonical(decision)) fail("问题样本复核 UUID 对应冲突决定：" + decision.id);
  return detail;
}

/** Append one trusted source-review event; never mutate accepted samples or class lineage. */
export function applyProblemOccurrenceReview(
  library: ProblemLibrary,
  decision: ProblemOccurrenceReviewDecision,
  targets: ProblemOccurrenceReviewTarget[],
  options: { evaluatorVersion: string; at?: string },
): ProblemLibrary {
  if (acceptedProblemOccurrenceReview(library, decision)) return library;
  if (!options.evaluatorVersion.trim()) fail("问题样本复核缺少 evaluatorVersion");
  const event: ProblemEvent = {
    id: decision.id, type: "occurrence_rejected", at: options.at ?? new Date().toISOString(),
    detail: structuredClone({ evaluator_version: options.evaluatorVersion, decision, targets }),
  };
  reviewDetail(library, event);
  return { ...library, updated_at: event.at, events: [...library.events, event] };
}
