import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues, ValidationError, type AgentRequest, type ToolAudit,
  type ValidationIssue, type TaskCriterion,
} from "@eval/contracts";
import { images, traceReadCoverage } from "@eval/tools";
import type { ComparisonInput, ComparisonResult } from "./types.js";
import { criterionAppliesToPair } from "./pair-scope.js";
import { comparisonAdvantageCandidates, comparisonResourceMetrics, comparisonResourcesComparable, requiredSourceReviews } from "./slots.js";
import { comparisonResultIssues } from "./result-checks.js";
import schema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
/** Share the source-owned final-image gate between early feedback and formal validation. */
export function comparisonFinalImageIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as ComparisonInput;
  return Object.entries(input.candidates).flatMap(([label, candidate]) => {
    const raw = request.sources[label]?.value as { messages?: unknown[] } | undefined;
    return images(raw?.messages?.[candidate.final_message_index]).length &&
      !audit.viewedImages.includes(`${label}:${candidate.final_message_index}`)
      ? [{ category: "evidence" as const, code: "final_image_not_viewed", path: `/candidates/${label}`, candidate: label,
        message: `最终回答含图片，必须先 view_image(candidate="${label}", message_index=${candidate.final_message_index}) 查看完整交付。` }]
      : [];
  });
}

/** The same exact full-read coverage applies before material disclosure and final acceptance. */
export function comparisonDeferredFinalIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as ComparisonInput, errors: ValidationIssue[] = [];
  for (const [label, candidate] of Object.entries(input.candidates)) {
    for (const [index, material] of candidate.deferred_final_material.entries()) {
      const coverage = traceReadCoverage(audit, {
        candidate: label, message_index: material.message_index, kind: "text", path: material.path,
        start: 0, end: material.total_chars,
      });
      if (!coverage.covered) errors.push({
        category: "evidence", code: "deferred_final_material_not_read", path: `/candidates/${label}/deferred_final_material/${index}`,
        candidate: label, message: "未完整读取延后展示的最终材料；按缺口用 read_trace 补读并继续 next_offset。", actual: coverage.missing,
        expected: { read_request: { candidate: label, message_index: material.message_index, path: material.path,
          offset: coverage.missing[0]!.start, max_chars: 16000 } },
      });
    }
  }
  return errors;
}

export function validateEvaluation(request:AgentRequest,result:unknown,audit:ToolAudit,inspectionReviews:ComparisonResult['review_requests']=[]):void{
 if(!validator(result))throw new ValidationError(schemaIssues(validator.errors,result));
 const input=request.input as unknown as ComparisonInput,value=result as ComparisonResult,labels=Object.keys(input.candidates);
 const errors:ValidationIssue[]=[...comparisonResultIssues(request,value),...comparisonFinalImageIssues(request,audit),...comparisonDeferredFinalIssues(request,audit)];
 const add=(code:string,path:string,message:string,candidate?:string)=>errors.push({category:'decision',code,path,message,candidate});
 if(!isDeepStrictEqual(value.task_analysis,input.task_analysis))add('task_analysis_changed','/task_analysis','共同评测规则不得改写。');
 const criteria=[...input.task_analysis.requirements,...input.task_analysis.scoring_points,...input.task_analysis.red_flags];
 const byId=new Map<string,TaskCriterion>(criteria.map(item=>[item.id,item]));
 const applicable=(label:string,id:string)=>{const criterion=byId.get(id);return criterion&&(!criterion.applies_to.length||criterion.applies_to.includes(input.candidates[label]?.candidate_id));};
 const hasReview=(label:string)=>value.review_requests.some(item=>item.candidate===label);
 for(const review of requiredSourceReviews(request))if(value.status!=='needs_review'||!hasReview(review.candidate))add('source_review_required','/review_requests','未解决的来源冲突须先复核。',review.candidate);
 if(!isDeepStrictEqual(Object.keys(value.assessments).sort(),labels.slice().sort()))add('assessment_incomplete','/assessments','必须分别评审双方核心交付。');
 for(const [candidate,assessment]of Object.entries(value.assessments)){
  if(!labels.includes(candidate))continue;
  if(assessment.meets_core===null&&value.status!=='needs_review')add('assessment_review_required','/review_requests','核心交付不能判定时必须保留具体待复核原因。',candidate);
  if(assessment.meets_core!==false&&assessment.core_failure_refs.length)add('core_failure_refs_unexpected',`/assessments/${candidate}/core_failure_refs`,'只有核心失败填写失败要求。',candidate);
  if(assessment.meets_core===false){
   if(!assessment.core_failure_refs.length)add('core_failure_unproven',`/assessments/${candidate}/core_failure_refs`,'核心失败须引用共同 requirements 及本次比较中已证实的缺陷。',candidate);
   for(const id of assessment.core_failure_refs){
    const criterion=input.task_analysis.requirements.find(item=>item.id===id);
    const cells=value.decision_basis.comparisons.filter(row=>row.criterion_ids.includes(id)).map(row=>row.assessments[candidate]);
    if(!criterion||!criterionAppliesToPair(input,criterion)||!cells.some(cell=>cell?.evidence_status==='established'&&['unmet','partial'].includes(cell.status)&&cell.finding_indices.length))
     add('core_failure_unproven',`/assessments/${candidate}/core_failure_refs`,'核心失败仅引用双方共同要求、已证实未达标的比较格和既有 Problem；缺少归因记录须请求来源复核。',candidate);
   }
  }
 }
 for(const [index,review]of value.review_requests.entries()){
  if(!labels.includes(review.candidate))add('review_candidate_invalid',`/review_requests/${index}`,'复核须指向现有候选。');
  if(!review.criterion_ids.length&&!review.finding_indices.length&&!inspectionReviews.some(item=>isDeepStrictEqual(item,review))&&!requiredSourceReviews(request).some(item=>isDeepStrictEqual(item,review)))add('review_reference_missing',`/review_requests/${index}`,'复核须定位现有要求或问题。');
  if(review.criterion_ids.some(id=>!byId.has(id))||review.finding_indices.some(i=>!input.attributions[review.candidate]?.Problem[i]))add('review_reference_invalid',`/review_requests/${index}`,'复核引用必须存在。');
 }
 for(const [index,row]of value.decision_basis.comparisons.entries()){
  const path=`/decision_basis/comparisons/${index}`;
  if(!isDeepStrictEqual(Object.keys(row.assessments).sort(),labels.slice().sort()))add('comparison_incomplete',path,'同一比较行须覆盖双方。');
  if(row.criterion_ids.some(id=>!byId.has(id)))add('criterion_missing',path,'比较行只使用既有规则。');
  for(const [candidate,cell]of Object.entries(row.assessments)){
   if(!labels.includes(candidate))continue;
   const problems=cell.finding_indices.map(i=>input.attributions[candidate]?.Problem[i]);
   if(problems.some(item=>!item))add('finding_missing',path,'只能引用本方已接受 Problem 的零起始位置。',candidate);
   if(cell.evidence_status==='established'&&problems.some(item=>item?.evidence_status==='uncertain'))add('finding_evidence_strengthened',path,'不可把不确定问题提升为已证实。',candidate);
   if(row.criterion_ids.length){
    const inScope=row.criterion_ids.some(id=>applicable(candidate,id));
    if((cell.status==='not_applicable')===Boolean(inScope))add('criterion_scope_invalid',path,'状态必须遵守原规则的适用范围。',candidate);
    if(['unmet','partial'].includes(cell.status)&&cell.evidence_status==='established'&&!cell.finding_indices.length)add('comparison_defect_unregistered',path,'已确认缺陷须引用正式 Problem；归因漏项时请求来源复核，不能由比较新增问题。',candidate);
    if(cell.status==='unknown'&&cell.evidence_status!=='uncertain')add('criterion_unknown_established',path,'未知状态不能确证。',candidate);
   }
  }
  if(row.better_candidates.length&&!comparisonAdvantageCandidates(row.assessments).length)add('comparison_advantage_unproven',path,'双方同口径且有确证判断时才可认定优势。');
  if(!row.criterion_ids.length&&row.better_candidates.length&&!comparisonResourcesComparable(input))add('comparison_resource_incomparable',path,'资源优势须使用双方同种有效指标。');
  if(!row.criterion_ids.length)for(const [candidate,cell]of Object.entries(row.assessments))if(cell.evidence_status==='established'&&!Object.values(comparisonResourceMetrics(input,candidate)).some(item=>item!==null))add('unlinked_observation_unproven',path,'无资源数据不能生成已确认资源判断。',candidate);
 }
 if(value.status==='decided'){
  const ranked=value.ranking.flat();
  if(!isDeepStrictEqual(ranked.slice().sort(),labels.slice().sort()))add('ranking_incomplete','/ranking','排名须恰好覆盖双方一次。');
  const tier=(label:string)=>value.ranking.findIndex(row=>row.includes(label));
  const failed=labels.filter(label=>value.assessments[label]?.meets_core===false),passed=labels.filter(label=>value.assessments[label]?.meets_core===true);
  if(new Set(failed.map(tier)).size>1||passed.some(label=>failed.some(other=>tier(label)>=tier(other))))add('core_ranking_contradiction','/ranking','核心失败同层且排在通过者之后。');
  if(passed.length===labels.length&&value.ranking.length>1){const winner=value.ranking[0][0];if(!value.decision_basis.comparisons.some(row=>row.importance!=='low'&&row.better_candidates.includes(winner)))add('ranking_unproven','/ranking','双方可用时，分层须由确证的实质共同优势支持。');}
 }
 if(errors.length)throw new ValidationError(errors);
}
