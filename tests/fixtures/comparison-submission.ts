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

/** Verification choices are explicit; never infer them from an upstream verdict. */
export function comparisonVerificationSubmission(selections: Partial<ComparisonVerificationSubmission> = {}): ComparisonVerificationSubmission {
 return { concern_matches: [], source_reviews: [], ...selections };
}

/** Fixtures use the current thin submission; the canonical result remains a separate contract. */
export function comparisonSubmission(result: ComparisonResult, slots: ComparisonSlot[]): ComparisonSubmission {
 const rows = result.decision_basis?.comparisons ?? [];
 return { assessments:Object.entries(result.assessments).map(([candidate,assessment])=>({candidate,...structuredClone(assessment)})),
  comparisons: slots.map((slot,slot_index) => {
   const row = [...rows].sort((a,b) => {
    const score = (row:ComparisonResult["decision_basis"]["comparisons"][number]) => Object.entries(slot.finding_indices).reduce((sum,[label,indices]) => sum+indices.filter(index => row.assessments[label]?.finding_indices.includes(index)).length,0);
    return score(b)-score(a);
   }).find(row => slot.kind === 'resource' ? !row.criterion_ids.length && Object.values(row.assessments).every(cell => !cell.finding_indices.length)
    : slot.criterion_ids.some(id => row.criterion_ids.includes(id)) || Object.entries(slot.finding_indices).some(([label,indices]) =>
     indices.some(index => row.assessments[label]?.finding_indices.includes(index))));
   if (!row && slot.optional) return undefined;
   if (slot.kind === 'resource') return { slot_index, kind: slot.kind, importance: row?.importance ?? 'medium' };
   const assessments = row?.assessments ?? Object.fromEntries(Object.keys(result.assessments).map(label=>[label,{status:'met',evidence_status:'已确认',summary:'受控检查已完成。',finding_indices:[]}]));
   return { slot_index, kind: slot.kind, importance: row?.importance ?? 'medium', better_candidate: row?.better_candidates[0] ?? null,
     assessments:Object.entries(assessments).map(([candidate,assessment])=>({candidate,...assessment})) };
  }).filter((row): row is NonNullable<typeof row> => row !== undefined),
  quality_winner: result.ranking?.length > 1 ? result.ranking[0][0] : null,
  relative_preference: result.ranking?.[0]?.[0] === 'B' ? 'B' : 'A',
  tradeoff: result.decision_basis.tradeoff };
}
export function requestComparisonSubmission(request: AgentRequest, result: ComparisonResult) {
 const draft = comparisonSubmission(result, comparisonSlots(request));
 const passed=Object.keys(result.assessments).filter(label=>result.assessments[label].meets_core===true);
 if(passed.length===1&&Object.values(result.assessments).some(item=>item.meets_core===false))draft.relative_preference=passed[0] as 'A'|'B';
 return draft;
}
