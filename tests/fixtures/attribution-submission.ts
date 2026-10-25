import {selectEvidence,parseEvidenceCoordinates,type AgentRequest,type ToolAudit} from '@eval/contracts';
import {attributionNormDirectory,buildAttributionTransitions,buildAttributionExecutionNodes,type AttributionResult,type AttributionSubmission} from '@eval/agents/attribution';
import {traceComponentIdentities} from '@eval/tools';
import {businessChains} from '@eval/workflows/review';
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
  Object.assign(answer, {business_chains:chains,component_catalog:actors,execution_nodes:buildAttributionExecutionNodes(raw,actors),transitions:buildAttributionTransitions({
    raw,inputId:request.sources.answer.id,finalIndex:answer.final_message_index,actors,chains})});
}


export function attributionSubmission(request:AgentRequest,result:AttributionResult,audit:ToolAudit):AttributionSubmission{
  setFixtureComponentCatalog(request);const bank=audit.evidenceBank??=[];
  const ref=(id:string)=>selectEvidence(bank,{evidence_id:id}).evidence_index;
  return {summary:result.summary,...(result.has_standard_answer?{is_correct:result.is_correct,correct_reason:result.correct_reason!}:{}),Problem:result.Problem.map(p=>({
    text:p.text,reason:p.reason,evidence_status:p.evidence_status,evidence_indices:p.evidence.map(e=>parseEvidenceCoordinates(e.evidence_id)?.kind==='image'?{image_number:ref(e.evidence_id),observation:e.quote.replace('[图像观察]','')}:ref(e.evidence_id)),
    checks:p.checks.map(c=>({transition_index:c.transition_index,outcome:c.outcome,observation:c.observation,before_evidence_indices:c.before_evidence_ids.map(ref),after_evidence_indices:c.after_evidence_ids.map(ref)})),
    causes:p.causes.map(({transition_index,basis,mechanism_source,reason,certainty,uncertainty})=>({transition_index,basis,mechanism_source,reason,certainty,...(uncertainty?{uncertainty}:{})})),
    ...(p.uncertainty?{uncertainty:p.uncertainty}:{}),...(p.calculations?{calculations:p.calculations.map(c=>({...c,operands:Object.fromEntries(Object.entries(c.operands).map(([name,{evidence_id,...o}])=>[name,{...o,evidence_index:ref(evidence_id)}]))}))}:{})}))};
}
