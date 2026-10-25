import { ValidationError, type AgentRequest, type ValidationIssue } from '@eval/contracts';
import { criterionAppliesToPair } from './pair-scope.js';
import type { ComparisonInput, ComparisonResult, ComparisonSlot, CriterionStatus, EvidenceStatus } from './types.js';

/** Only recorded valid measurements count; a missing or conflicted metric stays unknown. */
export function comparisonResourceMetrics(input: ComparisonInput, candidate: string) {
 const material = input.candidates[candidate], seconds = material?.original_answer_timing?.finish_seconds,
  tokens = material?.original_answer_usage?.total_tokens;
 return {
  finish_seconds: typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  // Usage normalization already nulls invalid totals; cache issues do not invalidate them.
  total_tokens: typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null,
 };
}

function comparableResourceMetrics(input: ComparisonInput) {
 const metrics = Object.keys(input.candidates).map(candidate => comparisonResourceMetrics(input,candidate));
 return (['finish_seconds','total_tokens'] as const).filter(key => metrics.length > 1 && metrics.every(metric => metric[key] !== null));
}

/** A time on one side and a token count on the other are not a comparable pair. */
export function comparisonResourcesComparable(input: ComparisonInput): boolean {
 return comparableResourceMetrics(input).length > 0;
}

/** Resource direction is measured dominance, never a model's quality preference. */
export function comparisonResourceAdvantage(input: ComparisonInput): string | null {
 const labels=Object.keys(input.candidates),keys=comparableResourceMetrics(input);
 const metrics=Object.fromEntries(labels.map(label=>[label,comparisonResourceMetrics(input,label)]));
 return labels.find(label=>keys.length>0 && labels.every(other=>other===label ||
  keys.every(key=>metrics[label][key]!<=metrics[other][key]!) &&
  keys.some(key=>metrics[label][key]!<metrics[other][key]!))) ?? null;
}

/** Resource states are mechanical measurements. Requirement judgments belong to the model. */
export function comparisonCellState(input: ComparisonInput, candidate: string, _criterionIds: string[], _findingIndices: number[]): {
 status: CriterionStatus; evidence_status: EvidenceStatus;
} {
 return Object.values(comparisonResourceMetrics(input,candidate)).some(value=>value!==null)
  ? {status:'met',evidence_status:'已确认'} : {status:'unknown',evidence_status:'待核实'};
}
export function comparisonSlotCellState(input: ComparisonInput,candidate:string,slot:ComparisonSlot) {
 return comparisonCellState(input,candidate,slot.criterion_ids,slot.finding_indices[candidate]);
}
export function comparisonAdvantageCandidates(assessments:Record<string,{status:CriterionStatus;evidence_status:EvidenceStatus}>,shared=true):string[]{
 return shared && Object.values(assessments).every(cell=>cell.evidence_status==='已确认'&&!['unknown','not_applicable'].includes(cell.status))?Object.keys(assessments):[];
}
export function comparisonSlots(request:AgentRequest):ComparisonSlot[]{
 const input=request.input as unknown as ComparisonInput,labels=Object.keys(input.candidates);
 const empty=()=>Object.fromEntries(labels.map(label=>[label,[] as number[]]));
 const criteria=[...input.task_analysis.requirements,...input.task_analysis.scoring_points,...input.task_analysis.red_flags]
  .filter(criterion=>!criterion.applies_to.length||labels.some(label=>criterion.applies_to.includes(input.candidates[label].candidate_id)));
 const slots:ComparisonSlot[]=criteria.map(criterion=>({aspect:criterion.text.slice(0,60),criterion_ids:[criterion.id],
  shared:criterionAppliesToPair(input,criterion),kind:'criterion',optional:!criterionAppliesToPair(input,criterion),finding_indices:empty()}));
 if(labels.some(label=>Object.values(comparisonResourceMetrics(input,label)).some(value=>value!==null)))slots.push({
  aspect:'原始完成时长与用量',criterion_ids:[],shared:true,kind:'resource',optional:false,finding_indices:empty()});
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

/** Only actual source verification blockers require attribution review. */
export function requiredSourceReviews(request:AgentRequest):ComparisonResult['review_requests']{
 const input=request.input as unknown as ComparisonInput;
 return Object.entries(input.source_review??{}).flatMap(([candidate,rows])=>rows.filter(row=>row.requires_review).map(row=>({
  candidate,criterion_ids:input.task_analysis.requirements.filter(item=>!item.applies_to.length||item.applies_to.includes(input.candidates[candidate].candidate_id)).map(item=>item.id),
  finding_indices:[],reason:row.reason,
 })));
}
export function comparisonSlotChoices(request:AgentRequest){
 const input=request.input as unknown as ComparisonInput,labels=Object.keys(input.candidates);
 const criteria=[...input.task_analysis.requirements,...input.task_analysis.scoring_points,...input.task_analysis.red_flags];
 return comparisonSlots(request).map((slot,slot_index)=>{
  const applicable_candidates=labels.filter(candidate=>!slot.criterion_ids.length||slot.criterion_ids.some(id=>{
   const criterion=criteria.find(item=>item.id===id)!;return !criterion.applies_to.length||criterion.applies_to.includes(input.candidates[candidate].candidate_id);
  }));
  return {slot_index,aspect:slot.aspect,scope:slot.shared?'pair':'source_only',optional:slot.optional,kind:slot.kind,
   advantage_candidates:slot.shared?labels:[],applicable_candidates,reviewable_candidates:slot.kind==='resource'?[]:applicable_candidates,
   standards:slot.criterion_ids.map(id=>criteria.find(item=>item.id===id)!),
   ...(slot.kind==='resource'?{resource_metrics:Object.fromEntries(labels.map(label=>[label,comparisonResourceMetrics(input,label)])),comparable_metrics:comparableResourceMetrics(input)}:{}),
   observations:Object.fromEntries(labels.map(label=>[label,input.attributions[label].Problem.map((item,finding_index)=>({finding_index,...item}))]))};
 });
}
