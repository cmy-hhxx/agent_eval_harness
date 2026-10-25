import {selectEvidence,parseEvidenceCoordinates,type AgentRequest,type ToolAudit} from '@eval/contracts';
import {responsibilityDisplay,attributionNormDirectory,buildAttributionTransitions,buildAttributionExecutionNodes,type AttributionResult,type AttributionSubmission} from '@eval/agents/attribution';
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
  // Synthetic fixtures must identify a unique captured call; never select the first same-name actor.
  const boundary=(component:string)=>{
    if(component==='责任主体未确定')return null;
    const matches=(request.input.answer as {transitions:{transition_index:number}[]}).transitions.filter(t=>responsibilityDisplay(request,t.transition_index).component===component);
    if(matches.length!==1)throw new Error('Fixture needs an explicit unique responsibility call');
    return matches[0].transition_index;
  };
  const ref=(id:string)=>selectEvidence(bank,{evidence_id:id}).evidence_index;
  return {summary:result.summary,...(result.has_standard_answer?{is_correct:result.is_correct,correct_reason:result.correct_reason!}:{}),Problem:result.Problem.map(p=>({
    text:p.text,reason:p.reason,evidence_status:p.evidence_status,
    evidence:p.evidence.map(e=>({index:ref(e.evidence_id),purposes:e.purposes,...(parseEvidenceCoordinates(e.evidence_id)?.kind==='image'?{observation:e.quote.replace('[图像观察]','')}:{})})),
    responsibility_boundary:boundary(p.component),attribution_reason:p.attribution_reason,
    ...(p.uncertainties?{uncertainties:p.uncertainties}:{}),
    ...(p.related_responsibilities?{related_responsibilities:p.related_responsibilities.map(r=>({responsibility_boundary:boundary(r.component)!,attribution_reason:r.attribution_reason,evidence_indices:r.evidence_ids.map(ref),...(r.uncertainties?{uncertainties:r.uncertainties}:{})}))}:{}),...(p.calculations?{calculations:p.calculations.map(c=>({...c,operands:Object.fromEntries(Object.entries(c.operands).map(([name,{evidence_id,...o}])=>[name,{...o,evidence_index:ref(evidence_id)}]))}))}:{})}))};
}
