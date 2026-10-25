import { selectEvidence, type AgentRequest, type TaskAnalysis, type ToolAudit } from "@eval/contracts";
import { attributionNormDirectory, attributionFindingBasis, numericReferenceDirectory, buildAttributionTransitions, type AttributionResult, type AttributionSubmission } from "@eval/agents/attribution";
import { parseEvidenceCoordinates, traceComponentIdentities } from "@eval/tools";
import { businessChains } from "@eval/workflows/review";
import { responsibilitySubmissionFixture } from "./responsibility.js";
type NormChoice = { norm_index: number; requirement_index: number | null; evidence: { evidence_id: string }[] };
/** Construct the current program-owned directory for a hand-built request. */
export function setFixtureNormDirectory(request: AgentRequest) {
  setFixtureComponentCatalog(request);
  const directory = attributionNormDirectory(request);
  Object.assign(request.input.answer as object, { norm_directory: directory });
  return directory;
}
export function setFixtureComponentCatalog(request: AgentRequest) {
  const answer = request.input.answer as { final_message_index: number; component_catalog?: unknown };
  const raw = request.sources.answer.value as import("@eval/workflows/inputs").RawInput;
  const chains = businessChains(raw, request.sources.answer.id, answer.final_message_index);
  const actors = traceComponentIdentities(raw, request.sources.answer.id, answer.final_message_index);
  Object.assign(answer, {business_chains:chains,component_catalog:actors,transitions:buildAttributionTransitions({
    raw,inputId:request.sources.answer.id,finalIndex:answer.final_message_index,actors,chains})});
}

/** Invert a known fixture using its genuine requirement owner or unique physical norm, never its prose. */
export function normSelection(directory: NormChoice[], finding: AttributionResult["findings"][number]): number | null {
  const index = finding.assessment.requirement_index;
  if (index !== null) {
    const associated = directory.filter(norm => norm.requirement_index === index);
    if (associated.length === 1) return associated[0]!.norm_index;
    if (associated.length > 1) throw new Error(`Fixture requirement ${index} has ambiguous norm owners`);
  }
  const own = [...finding.evidence, ...finding.context_evidence ?? []].filter(item => item.source === undefined && item.source_input_id === undefined);
  const intersects = (selected: { evidence_id: string }, norm: { evidence_id: string }) => {
    const a = parseEvidenceCoordinates(selected.evidence_id), b = parseEvidenceCoordinates(norm.evidence_id);
    return a?.kind === "text" && b?.kind === "text" && a.input_id === b.input_id && a.message_index === b.message_index &&
      a.path === b.path && a.start < b.end && b.start < a.end;
  };
  const selected = directory.filter(norm => norm.requirement_index === null &&
    norm.evidence.some(origin => own.some(item => intersects(item, origin))));
  if (selected.length === 1) return selected[0]!.norm_index;
  if (!selected.length && finding.assessment.evidence_status === "uncertain") return null;
  throw new Error(`Fixture finding ${finding.finding_id} has no unique genuine norm owner: ${selected.map(item => item.norm_index).join(",")}`);
}

/** Build the current model payload directly from a known formal fixture and its provided source directory. */
export function attributionSubmission(request: AgentRequest, result: AttributionResult, audit: ToolAudit): AttributionSubmission {
  setFixtureComponentCatalog(request);
  result = structuredClone(result);
  for(const finding of result.findings)for(const cause of finding.problem?.component??[])
    if(!cause.evidence_ids.length)cause.evidence_ids=finding.evidence.map(item=>item.evidence_id);
  const bank=audit.evidenceBank??=[],images=new Map<number,string>();
  const refs=(values:AttributionResult["correctness_evidence"])=>values.map(item=>{
    const selected=selectEvidence(bank,{evidence_id:item.evidence_id});
    if(parseEvidenceCoordinates(item.evidence_id)?.kind==="image")images.set(selected.evidence_index,item.quote.slice("[图像观察]".length));
    return selected.evidence_index;
  });
  const task=request.input.task_analysis as unknown as TaskAnalysis,truth=request.input.ground_truth as {available:boolean;value:unknown};
  const directory=truth.available?numericReferenceDirectory(truth.value):[],norms=attributionNormDirectory(request);
  const correctness=refs(result.correctness_evidence),basis=attributionFindingBasis(request.input);
  const observation=(row:AttributionResult["findings"][number])=>{
    const norm=row.dimension==="instruction_following"?normSelection(norms,row):null;
    const basis_index=row.dimension==="instruction_following" ? norm===null?null:basis.find(item=>item.norm_index===norm)!.basis_index
      : row.assessment.requirement_index===null?null:row.assessment.requirement_index+1;
    return {dimension:row.dimension,stage:row.stage,importance:row.importance,text:row.text,reason:row.reason,
      evidence_status:row.assessment.evidence_status,evidence_indices:refs(row.evidence),basis_index};
  };
  const submission:AttributionSubmission={
    summary:result.summary,meets_core:result.core_assessment.meets_core,core_reason:result.core_assessment.reason,
    core_requirements:result.core_assessment.criterion_ids.map(id=>task.requirements.findIndex(item=>item.id===id)+1),
    ...(truth.available?{is_correct:result.is_correct,correctness_reason:result.correctness_reason,correctness_evidence_indices:correctness}:{}),
    ...(truth.available && result.standard_conflict === true ? {standard_conflict:true} : {}),
    criterion_assessments:result.criterion_assessments.flatMap(row=>row.status==="not_applicable"?[]:[{
      status:row.status,evidence_status:row.evidence_status,summary:row.summary,evidence_indices:refs(row.evidence)}]),
    strengths:result.findings.filter(row=>row.type==="strength").map(observation),
    problems:result.findings.filter(row=>row.type==="problem").map(row=>{
      const observed=observation(row),problem=structuredClone(row.problem!);
      const checks=problem.investigation.map(check=>({transition_index:check.transition_index,outcome:check.outcome,
        observation:check.observation,before_evidence_indices:refs(row.evidence.filter(item=>check.before_evidence_ids.includes(item.evidence_id))),
        after_evidence_indices:refs(row.evidence.filter(item=>check.after_evidence_ids.includes(item.evidence_id)))}));
      return {...observed,impact:row.assessment.impact,diagnosis:problem.diagnosis,label:problem.label,checks,
        calculations:problem.calculations.map(calculation=>({...calculation,operands:Object.fromEntries(Object.entries(calculation.operands)
          .map(([name,{evidence_id,...operand}])=>[name,{...operand,evidence_index:selectEvidence(bank,{evidence_id}).evidence_index}]))})),
        causes:problem.component.map(cause=>responsibilitySubmissionFixture(cause))};
    }),
    numeric_checks:result.numeric_checks.map(({expected,matches:_matches,...row})=>({...row,
      reference_index:directory.findIndex(item=>item.expected===expected)+1,evidence_index:correctness[row.evidence_index]})),
  };
  if(images.size)submission.image_observations=[...images].map(([image_number,text])=>({image_number,text}));
  return submission;
}
