import type { AgentRequest } from '@eval/contracts';
import { comparisonSlots, type ComparisonResult, type ComparisonSlot, type ComparisonSubmission } from '@eval/agents/comparison';

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
   if (slot.kind === 'resource') return { slot_index, kind: slot.kind, importance: row?.importance ?? 'low' };
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

/** Current flat model submission; canonical fixture judgments stay readable. */
export function flatComparisonSubmission(value: ComparisonSubmission) {
 const {assessments,comparisons,...decision}=value;
 return {...decision,...Object.fromEntries(assessments.flatMap(({candidate,meets_core,core_failure_refs,summary})=>{
  const side=candidate.toLowerCase();return [[`${side}_core`,meets_core],[`${side}_core_refs`,core_failure_refs],[`${side}_summary`,summary]];
 })),comparisons:comparisons.map(({kind: _kind,assessments,...row})=>({...row,...Object.fromEntries((assessments??[]).flatMap(({candidate,status,summary,finding_indices})=>{
  const side=candidate.toLowerCase();return [[`${side}_status`,status],[`${side}_summary`,summary],[`${side}_findings`,finding_indices]];
 }))}))};
}
