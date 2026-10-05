import type { AgentRequest } from '@eval/contracts';
import { comparisonSlots, verificationCheckAspects, type ComparisonMaterialInspection, type ComparisonVerificationInput,
 type ComparisonResult, type ComparisonSlot, type ComparisonSubmission, type ComparisonVerificationSubmission } from '@eval/agents/comparison';

/** Fixed subcheck positions are model choices; canonical checkpoints retain one result per rule. */
export function comparisonInspectionSubmission(request: AgentRequest, value: ComparisonMaterialInspection) {
 if (!Array.isArray(value.checks) || !Array.isArray(value.concerns)) return value;
 const input = request.input as unknown as ComparisonVerificationInput;
 return { checks: value.checks.flatMap(({ candidate: _candidate, criterion_id: _criterion, answer_evidence: _scope, ...check }) =>
   verificationCheckAspects.map(() => structuredClone(check))),
  concerns: value.concerns.map(({ criterion_ids, ...concern }) => ({ ...concern,
   requirement_indices: criterion_ids.map(id => {
    const index = input.task_analysis.requirements.findIndex(criterion => criterion.id === id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
   }) })) };
}

function sourceReviews(result: ComparisonResult | undefined, slots: ComparisonSlot[], candidates: string[]) {
 return slots.map(slot => Object.fromEntries(candidates.map(candidate => [candidate,
  result?.review_requests.filter(review => review.candidate === candidate &&
   (slot.criterion_ids.some(id => review.criterion_ids.includes(id)) ||
    slot.finding_indices[candidate]?.some(index => review.finding_indices.includes(index))))
   .map(review => review.reason).join('；') || null])));
}

/** Final verification only selects cells that need review, without copied associations. */
export function comparisonSourceReviews(request: AgentRequest, result?: ComparisonResult) {
 const input = request.input as { candidates: Record<string, unknown> };
 return sourceReviews(result, comparisonSlots(request), Object.keys(input.candidates)).flatMap((row, slot_index) =>
  Object.entries(row).flatMap(([candidate, reason]) => reason === null ? [] : [{ slot_index, candidate, reason }]));
}

export function comparisonVerificationSubmission(request: AgentRequest, selections: Partial<ComparisonVerificationSubmission> = {}): ComparisonVerificationSubmission {
 return { concern_matches: [], concern_refutations: [], source_reviews: comparisonSourceReviews(request), ...selections };
}

/** Fixtures use the current thin submission; the canonical result remains a separate contract. */
export function comparisonSubmission(result: ComparisonResult, slots: ComparisonSlot[]): ComparisonSubmission {
 const rows = result.decision_basis?.comparisons ?? [];
 return { assessments: Object.fromEntries(Object.entries(result.assessments).map(([candidate,item]) => [candidate,{ summary:item.summary }])),
  comparisons: slots.map(slot => {
   const row = [...rows].sort((a,b) => {
    const score = (row:ComparisonResult["decision_basis"]["comparisons"][number]) => Object.entries(slot.finding_indices).reduce((sum,[label,indices]) => sum+indices.filter(index => row.assessments[label]?.finding_indices.includes(index)).length,0);
    return score(b)-score(a);
   }).find(row => slot.kind === 'resource' ? !row.criterion_ids.length && Object.values(row.assessments).every(cell => !cell.finding_indices.length)
    : slot.criterion_ids.some(id => row.criterion_ids.includes(id)) || Object.entries(slot.finding_indices).some(([label,indices]) =>
     indices.some(index => row.assessments[label]?.finding_indices.includes(index))));
   if (!row && slot.optional) return null;
   return { importance: row?.importance ?? 'medium', better_candidate: row?.better_candidates[0] ?? null,
    assessments: Object.fromEntries(Object.entries(result.assessments).map(([candidate,item]) => [candidate, {
     summary: row?.assessments[candidate]?.summary ?? item.summary }])) };
  }), preference: result.ranking?.length > 1 ? result.ranking[0][0] : null,
  tradeoff: result.decision_basis?.tradeoff ?? '来源存在待核事项。' };
}
export function requestComparisonSubmission(request: AgentRequest, result: ComparisonResult) {
 return comparisonSubmission(result, comparisonSlots(request));
}
