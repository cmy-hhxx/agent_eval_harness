import {randomUUID} from 'node:crypto';
import type {AgentBinding,JsonObject,PlannedTask,ReviewAudit,ReviewCase,RunState,SubmissionReceipt,WorkflowDefinition} from '@eval/contracts';
import {scoreAxes,scoreAxisPart,combineScoreAxes,scoreFinalMaterial,type ScoreAxis,type ScoreAxisResult,type ScoreEvidence,type ScoreRepair} from '@eval/agents/score';
import type { Candidate } from "@eval/workflows/inputs";
export interface ReviewTaskData {candidate:Candidate;rewriteOf?:string;score_part?:'evidence'|'axis'|'axes'|'final'|'rejected';score_axis?:ScoreAxis;score_axes?:ScoreAxis[];score_repair_used?:boolean;score_evidence_used?:boolean}
export function scoreEvidenceTask(candidate:Candidate):PlannedTask{return {id:randomUUID(),stage:'score',inputIds:{case:candidate.input_id},dependencies:{},data:{candidate,score_part:'evidence'} satisfies ReviewTaskData};}
export function isFormalScore(task:PlannedTask,receipt:SubmissionReceipt|undefined){
  return task.stage==='score'&&receipt&&('final_answer_score' in (receipt.evaluation as object)||'assessment_status' in (receipt.evaluation as object));
}
const task=(data:ReviewTaskData,dependencies:Record<string,string>):PlannedTask=>({id:randomUUID(),stage:'score',inputIds:{case:data.candidate.input_id},dependencies,data});
const judgments=(data:ReviewTaskData,axes:ScoreAxis[],dependencies:Record<string,string>)=>task({...data,
  score_part:axes.length===1?'axis':'axes',score_axis:axes.length===1?axes[0]:undefined,score_axes:axes.length===1?undefined:axes},dependencies);
const proof=(receipt:SubmissionReceipt):ReviewAudit=>structuredClone(receipt.audit.review??{quotes:[],sources:[],actions:[],viewed:[],searches:[]});
/** Rejudge all units of a shared issue together; never trim its attribution mechanically. */
function coupledAxes(requested:readonly ScoreAxis[],dependencies:Record<string,string>,state:RunState):ScoreAxis[]{
  const selected=new Set(requested),findings=scoreAxes.flatMap(axis=>{
    const value=state.receipts?.[dependencies[axis]]?.evaluation as ScoreAxisResult|undefined;
    if(!value?.evaluations)return [];
    const part=scoreAxisPart(value,axis);return [...part.findings,...part.verification_requests];
  });
  let previous=-1;
  while(previous!==selected.size){previous=selected.size;for(const finding of findings){
    const axes=scoreAxes.filter(axis=>finding.affected_item_ids.some(id=>id.startsWith(axis)));
    if(axes.some(axis=>selected.has(axis)))axes.forEach(axis=>selected.add(axis));
  }}
  return scoreAxes.filter(axis=>selected.has(axis));
}
export function bindScore(task:PlannedTask,source:ReviewCase&{view:JsonObject},dependencies:Record<string,SubmissionReceipt|undefined>):AgentBinding{
  const data=task.data as ReviewTaskData,seed=dependencies.evidence?proof(dependencies.evidence):undefined;
  const current={...source,...(seed?{review_seed:seed}:{} )};
  const feedback=dependencies.feedback?.evaluation as ScoreRepair|undefined;
  const collected=dependencies.evidence?.evaluation as ScoreEvidence|undefined;
  const input={...source.view,score_phase:data.score_part,repair_used:Boolean(data.score_repair_used),evidence_used:Boolean(data.score_evidence_used),
    ...(feedback?{repair_request:feedback}:{}),...(collected?{verification:(data.score_part==='evidence'?collected:{facts:collected.facts}) as unknown as JsonObject}:{}),
    ...(seed?{verified_sources:seed.sources.map(row=>({source_id:row.id,record_type:row.record.record_type??null,url:row.record.url??null,
      scope:row.record.scope??null,verification_role:row.record.verification_role??null,content_chars:Array.from(row.content).length})),shared_quotes:seed.quotes}:{} )} as JsonObject;
  const context={repair_used:Boolean(data.score_repair_used),evidence_used:Boolean(data.score_evidence_used),
    ...(data.score_part==='axes'?{axis_ids:data.score_axes}:{}),
    ...(data.score_part==='evidence'&&dependencies.evidence?{previous_evidence:dependencies.evidence.evaluation as ScoreEvidence}:{})};
  let profile='evidence';
  if(data.score_part==='axis'){profile=`axis-${data.score_axis!.toLowerCase()}`;input.score_axes=[data.score_axis!];}
  if(data.score_part==='axes'){profile='dimensions';input.score_axes=data.score_axes!;}
  if(data.score_part==='final'){
    profile='default';
    const axes=combineScoreAxes(scoreAxes.map(axis=>scoreAxisPart(dependencies[axis]!.evaluation as ScoreAxisResult,axis)),seed!.quotes);
    const quotes=new Map([...seed!.quotes,...axes.flatMap(part=>part.evidence)].map(q=>[q.evidence_id,q]));
    current.review_seed={...seed!,quotes:[...quotes.values()]};
    input.shared_quotes=current.review_seed.quotes as unknown as JsonObject[];
    input.axis_assessments=scoreFinalMaterial(axes) as unknown as JsonObject[];
    return {agent:'score',profile,request:{input,sources:{case:{id:data.candidate.input_id,value:current},score:{id:task.id,value:{...context,axes}}}}};
  }
  return {agent:'score',profile,request:{input,sources:{case:{id:data.candidate.input_id,value:current},score:{id:task.id,value:context}}}};
}
export const advanceScore:NonNullable<WorkflowDefinition['advance']>=(completed,receipt,state)=>{
  if(completed.stage!=='score')return {tasks:[]};
  const data=completed.data as ReviewTaskData;
  if(isFormalScore(completed,receipt))return {tasks:[]};
  if(data.score_part==='evidence'){
    const value=receipt.evaluation as ScoreEvidence;
    const selected=coupledAxes(data.score_evidence_used&&!value.full_rescore_reason?scoreAxes.filter(axis=>value.changed_item_ids.some(id=>id.startsWith(axis))):scoreAxes,completed.dependencies,state);
    const dependencies:Record<string,string>={evidence:completed.id};
    for(const axis of scoreAxes)if(completed.dependencies[axis])dependencies[axis]=completed.dependencies[axis];
    const panel=selected.length?judgments(data,[...selected],{evidence:completed.id}):undefined;
    for(const axis of selected)dependencies[axis]=panel!.id;
    return {tasks:[...(panel?[panel]:[]),task({...data,score_part:'final',score_axis:undefined,score_axes:undefined},dependencies)]};
  }
  if(data.score_part==='final'){
    const repair=receipt.evaluation as ScoreRepair;
    if(repair.action!=='repair')throw Error('Score最终阶段没有正式结果或修正请求。');
    if(repair.verification_requests.length){
      if(data.score_evidence_used)return {tasks:[task({...data,score_part:'rejected'},{source:completed.id})]};
      return {tasks:[task({...data,score_part:'evidence',score_evidence_used:true},{...completed.dependencies,feedback:completed.id})]};
    }
    if(data.score_repair_used)return {tasks:[task({...data,score_part:'rejected'},{source:completed.id})]};
    const dependencies={...completed.dependencies},axes=coupledAxes(repair.axis_ids,dependencies,state),panel=judgments({...data,score_repair_used:true},axes,{evidence:dependencies.evidence,feedback:completed.id});
    for(const axis of axes)dependencies[axis]=panel.id;
    return {tasks:[panel,task({...data,score_repair_used:true},dependencies)]};
  }
  return {tasks:[]};
};
export const scoreBlockedReason:NonNullable<WorkflowDefinition['blockedReason']>=(task,dependencies)=>{
  if(task.stage!=='score'||(task.data as ReviewTaskData).score_part!=='rejected')return;
  return 'Score修正机会已用完，拒收评分：'+(dependencies.source.evaluation as ScoreRepair).reason;
};
/** Only completed public answers are exported; intermediate receipts remain recovery drafts. */
export function scoreExportState(state:RunState):RunState{return {...state,manifest:{...state.manifest,tasks:state.manifest.tasks.filter(t=>t.stage!=='score'||isFormalScore(t,state.receipts[t.id]))}};}
