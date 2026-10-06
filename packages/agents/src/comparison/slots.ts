import { isDeepStrictEqual } from "node:util";
import { ValidationError, type AgentRequest, type ValidationIssue } from '@eval/contracts';
import { criterionAppliesToPair, findingAppliesToPair, findingCriterion } from './pair-scope.js';
import type { ComparisonInput, ComparisonResult, ComparisonSlot, CriterionStatus, EvidenceStatus } from './types.js';

/** Only recorded valid measurements count; a missing or conflicted metric stays unknown. */
export function comparisonResourceMetrics(input: ComparisonInput, candidate: string) {
 const material = input.candidates[candidate], seconds = material?.original_answer_timing?.finish_seconds,
  tokens = material?.original_answer_usage?.total_tokens;
 return {
  finish_seconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  total_tokens: typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 && !material.original_answer_usage.issues.length ? tokens : null,
 };
}

/** A time on one side and a token count on the other are not a comparable pair. */
export function comparisonResourcesComparable(input: ComparisonInput): boolean {
 const metrics = Object.keys(input.candidates).map(candidate => comparisonResourceMetrics(input,candidate));
 return metrics.length > 1 && (metrics.every(metric => metric.finish_seconds !== null) || metrics.every(metric => metric.total_tokens !== null));
}

/** Empty row IDs may still have an existing source requirement through a cited finding. */
export function comparisonCellCriterionIds(input: ComparisonInput, candidate: string, criterionIds: string[], findingIndices: number[]): string[] {
  if (criterionIds.length) return criterionIds;
  const attribution = input.attributions[candidate];
  return [...new Set(findingIndices.flatMap(index => {
    const requirementIndex = attribution?.findings[index]?.assessment.requirement_index;
    if (typeof requirementIndex !== "number" || !Number.isInteger(requirementIndex) || requirementIndex < 0) return [];
    const criterion = findingCriterion(input, candidate, index);
    return criterion ? [criterion.id] : [];
  }))];
}

/** Source-derived states never create findings or promote uncertain evidence. */
export function comparisonCellState(input: ComparisonInput, candidate: string, criterionIds: string[], findingIndices: number[]): {
  status: CriterionStatus; evidence_status: EvidenceStatus;
} {
  const attribution = input.attributions[candidate];
  const findings = findingIndices.map(index => attribution?.findings[index]);
  const uncertainFinding = findings.some(finding => !finding || finding.assessment.evidence_status === "uncertain");
  if (!criterionIds.length && uncertainFinding) return { status: "unknown", evidence_status: "uncertain" };
  const effectiveCriterionIds = comparisonCellCriterionIds(input, candidate, criterionIds, findingIndices);
  if (effectiveCriterionIds.length) {
    const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
    const byId = new Map(criteria.map(criterion => [criterion.id, criterion]));
    const applicable = effectiveCriterionIds.filter(id => {
      const criterion = byId.get(id);
      return criterion && (!criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate]?.candidate_id));
    });
    const facts = applicable.flatMap(id => attribution?.criterion_assessments.filter(fact => fact.criterion_id === id) ?? []);
    if (effectiveCriterionIds.some(id => !byId.has(id)) || applicable.some(id => facts.filter(fact => fact.criterion_id === id).length !== 1) ||
      facts.some(fact => fact.status === "not_applicable")) return { status: "unknown", evidence_status: "uncertain" };
    let status: CriterionStatus = facts.length ? "met" : "not_applicable";
    for (const candidateStatus of ["unknown", "unmet", "partial"] as const)
      if (facts.some(fact => fact.status === candidateStatus)) { status = candidateStatus; break; }
    return { status, evidence_status: status === "unknown" || uncertainFinding || facts.some(fact => fact.evidence_status === "uncertain")
      ? "uncertain" : "established" };
  }
  if (findingIndices.length) return uncertainFinding
    ? { status: "unknown", evidence_status: "uncertain" }
    : { status: "met", evidence_status: "established" };
  const hasMetric = Object.values(comparisonResourceMetrics(input,candidate)).some(value => value !== null);
  return hasMetric ? { status: "met", evidence_status: "established" } : { status: "unknown", evidence_status: "uncertain" };
}

export function comparisonSlotCellState(input: ComparisonInput, candidate: string, slot: ComparisonSlot) {
 return comparisonCellState(input,candidate,slot.criterion_ids,slot.finding_indices[candidate]);
}

/** Scope and already bound facts determine available choices, never their semantic direction. */
export function comparisonAdvantageCandidates(assessments: Record<string, ReturnType<typeof comparisonCellState>>, shared = true): string[] {
 return shared && Object.values(assessments).every(cell => cell.evidence_status === 'established' &&
  !['unknown','not_applicable'].includes(cell.status)) ? Object.keys(assessments) : [];
}

/** Stable source-owned rows: the model selects prose and advantages, never joins references. */
export function comparisonSlots(request: AgentRequest): ComparisonSlot[] {
 const input = request.input as unknown as ComparisonInput, labels = Object.keys(input.candidates);
 const empty = () => Object.fromEntries(labels.map(label => [label, [] as number[]]));
 const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags]
  .filter(criterion => !criterion.applies_to.length || labels.some(label => criterion.applies_to.includes(input.candidates[label].candidate_id)));
 const slots: ComparisonSlot[] = criteria.map(criterion => ({ aspect: criterion.text.slice(0,60), criterion_ids: [criterion.id],
  shared: criterionAppliesToPair(input, criterion), kind: 'criterion', optional: !criterionAppliesToPair(input, criterion), finding_indices: empty() }));
 for (const [candidate, attribution] of Object.entries(input.attributions)) for (const [finding_index, finding] of attribution.findings.entries()) {
  const criterion = findingCriterion(input, candidate, finding_index);
  const shared = findingAppliesToPair(input, candidate, finding_index, request.sources[candidate]?.value);
  const slot = criterion && slots.find(slot => slot.criterion_ids.includes(criterion.id) && (!slot.shared || shared));
  if (slot) {
   slot.finding_indices[candidate].push(finding_index);
   if (finding.type === 'strength' || finding.importance !== 'low') slot.optional = false;
  }
  // Independent findings remain in the source assessment. A missing counterpart is not a comparison fact.
 }
 const hasResource = labels.some(label => Object.values(comparisonResourceMetrics(input,label)).some(value => value !== null));
 if (hasResource) slots.push({ aspect: '原始完成时长与用量', criterion_ids: [], shared: true, kind: 'resource', optional: true, finding_indices: empty() });
 return slots;
}

/** Each fixed cell owns its review choice; the model never copies a row or source association. */
export function resolveSourceReviews(request: AgentRequest, rows: Record<string, string | null>[]): ComparisonResult['review_requests'] {
 const input = request.input as unknown as ComparisonInput, slots = comparisonSlots(request);
 if (rows.length !== slots.length) throw new ValidationError([{ category: 'decision', code: 'source_review_slot_count', path: '/source_reviews',
  actual: rows.length, expected: slots.length, message: `按 comparison_slots 的同一顺序填写恰好 ${slots.length} 行，每行保留 A/B；无来源疑点填 null，不复制槽位 ID 或索引。` }]);
 const issues: ValidationIssue[] = [];
 const reviews = rows.flatMap((row,index) => Object.entries(row).flatMap(([candidate,reason]) => {
  if (reason === null) return [];
  const slot = slots[index], path = `/source_reviews/${index}/${candidate}`;
  if (!input.candidates[candidate] || slot.kind === 'resource' ||
   !slot.criterion_ids.length && !slot.finding_indices[candidate]?.length)
   { issues.push({ category: 'decision', code: 'review_slot_invalid', path,
    message: '本格只能复核本方适用的要求或本方既有 finding；资源和排名取舍不能回写来源归因，该格来源复核填 null。' }); return []; }
  const ids = slot.criterion_ids.filter(id => {
   const criterion = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags].find(item => item.id === id)!;
   return !criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate].candidate_id);
  });
  if (!ids.length && !slot.finding_indices[candidate].length) {
   issues.push({ category: 'decision', code: 'review_slot_scope', path, message: '该格不适用于本方，不能借用他方私规；本格来源复核填 null。' }); return [];
  }
  return [{ candidate, criterion_ids: ids, finding_indices: [...slot.finding_indices[candidate]], reason }];
 }));
 if (issues.length) throw new ValidationError(issues);
 return reviews;
}

/** Known source blockers stay pending without asking the model to repeat them. */
export function requiredSourceReviews(request: AgentRequest): ComparisonResult['review_requests'] {
 const input = request.input as unknown as ComparisonInput, reviews: ComparisonResult['review_requests'] = [];
 for (const [candidate, attribution] of Object.entries(input.attributions)) {
  const blockers = input.source_review?.[candidate]?.filter(item => item.requires_review) ?? [];
  const core = attribution.core_assessment;
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const applicable = criteria.filter(criterion => !criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate].candidate_id));
  const byId = new Map(criteria.map(criterion => [criterion.id,criterion]));
  const facts = attribution.criterion_assessments;
  const sourceMismatch = !isDeepStrictEqual(attribution.task_analysis,input.task_analysis) || facts.length !== criteria.length ||
    new Set(facts.map(fact => fact.criterion_id)).size !== criteria.length || criteria.some(criterion => !facts.some(fact => fact.criterion_id === criterion.id)) ||
    facts.some(fact => !byId.has(fact.criterion_id) || (fact.status === "not_applicable") === applicable.some(criterion => criterion.id === fact.criterion_id));
  const privateCore = core.meets_core === false && !core.criterion_ids.some(id => input.task_analysis.requirements.some(criterion =>
   criterion.id === id && criterionAppliesToPair(input, criterion) && facts.some(fact => fact.criterion_id === id &&
    fact.evidence_status === "established" && ["unmet","partial"].includes(fact.status))));
  if (blockers.length || core.meets_core === null || privateCore || sourceMismatch) reviews.push({ candidate,
   criterion_ids: [...new Set([...core.criterion_ids.filter(id => byId.has(id)), ...((blockers.length || sourceMismatch) ? applicable.map(criterion => criterion.id) : [])])],
   finding_indices: [], reason: blockers.map(item => item.reason).join('；') || (sourceMismatch ? '来源标准、适用范围或逐项状态与固定任务不一致，须核查来源归因。' : privateCore
    ? '核心失败仅由专有要求支持，须独立核查共同交付可用性。' : core.reason) });
  const uncovered = attribution.findings.flatMap((finding,index) => finding.type === 'problem' && finding.importance !== 'low' &&
    !findingCriterion(input,candidate,index) && findingAppliesToPair(input,candidate,index,request.sources[candidate]?.value) ? [index] : []);
  if (uncovered.length) reviews.push({ candidate, criterion_ids: [], finding_indices: uncovered,
    reason: `以下实质观察尚未绑定可逐项比较的共同要求，不能据此判定没有差距：${uncovered.map(index => attribution.findings[index].text).join('；')}` });
 }
 return reviews;
}

/** Model-facing choices contain meaning and scope, never canonical association IDs. */
export function comparisonSlotChoices(request: AgentRequest) {
 const input = request.input as unknown as ComparisonInput;
 const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
 return comparisonSlots(request).map((slot, slot_index) => ({ slot_index, aspect: slot.aspect, scope: slot.shared ? 'pair' : 'source_only',
  optional: slot.optional, kind: slot.kind,
  advantage_candidates: comparisonAdvantageCandidates(Object.fromEntries(Object.keys(input.candidates).map(candidate =>
   [candidate,comparisonSlotCellState(input,candidate,slot)])),slot.shared && (slot.kind !== 'resource' || comparisonResourcesComparable(input))),
  applicable_candidates: Object.keys(input.candidates).filter(candidate => slot.criterion_ids.length
   ? slot.criterion_ids.some(id => { const criterion = criteria.find(criterion => criterion.id === id)!;
     return !criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate].candidate_id); })
   : slot.shared || slot.finding_indices[candidate].length > 0),
  reviewable_candidates: Object.keys(input.candidates).filter(candidate => slot.kind !== 'resource' &&
   (slot.finding_indices[candidate].length > 0 || slot.criterion_ids.some(id => {
    const criterion = criteria.find(criterion => criterion.id === id)!;
    return !criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate].candidate_id);
   }))),
  standards: slot.criterion_ids.map(id => { const criterion = criteria.find(criterion => criterion.id === id)!;
   return { text: criterion.text, ...(criterion.acceptance_rule === criterion.text ? {} : { acceptance_rule: criterion.acceptance_rule }) }; }),
  observations: Object.fromEntries(Object.entries(slot.finding_indices).map(([candidate,indices]) => [candidate,
   indices.map(index => { const finding = input.attributions[candidate].findings[index];
    return { type: finding.type, text: finding.text, evidence_status: finding.assessment.evidence_status }; })])) }));
}
