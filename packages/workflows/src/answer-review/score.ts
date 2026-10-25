import {randomUUID} from 'node:crypto';
import type {AgentBinding,JsonObject,PlannedTask,ReviewQuote,RunState,SubmissionReceipt} from '@eval/contracts';
import type {AcceptedScoreCase,ScoreProblemFact} from '@eval/agents/score';
import type {AttributionResult,Evidence} from '@eval/agents/attribution';
import {contentText,type Candidate,type RawInput} from '@eval/workflows/inputs';
export interface ReviewTaskData {candidate:Candidate;rewriteOf?:string}
export function scoreTask(candidate:Candidate,attribution:string):PlannedTask{
  return {id:randomUUID(),stage:'score',inputIds:{case:candidate.input_id},dependencies:{attribution},data:{candidate} satisfies ReviewTaskData};
}
export function isFormalScore(task:PlannedTask,receipt:SubmissionReceipt|undefined){return task.stage==='score'&&receipt&&
  ('final_answer_score' in (receipt.evaluation as object)||'assessment_status' in (receipt.evaluation as object));}

/** Accepted attribution is the factual authority. No trace, investigations or duplicate quotations enter Score. */
export function bindScore(task:PlannedTask,raw:RawInput,dependencies:Record<string,SubmissionReceipt|undefined>):AgentBinding{
  const candidate=(task.data as ReviewTaskData).candidate,receipt=dependencies.attribution;
  if(!receipt)throw Error('评分必须等待本条归因的有效收据。');
  const attribution=receipt.evaluation as AttributionResult;
  const final=raw.messages[candidate.final_index] as {content?:unknown};
  const answer=contentText(final.content??final),question=candidate.question;
  const sources:Record<string,string>={Q:question,A:answer},quotes:ReviewQuote[]=[],byOrigin=new Map<string,string>();
  const add=(source_id:string,text:string)=>{const evidence_id='EV_'+(quotes.length+1);sources[source_id]=text;
    quotes.push({evidence_id,source_id,start:0,end:Array.from(text).length,quote:text});return evidence_id;};
  const questionId=add('Q',question),answerId=add('A',answer);
  const select=(evidence:Evidence)=>{
    const saved=byOrigin.get(evidence.evidence_id);if(saved)return saved;
    let id:string;
    if(!evidence.source&&evidence.message_index===candidate.final_index&&evidence.quote===answer)id=answerId;
    else if(evidence.quote===question)id=questionId;
    else id=add(evidence.evidence_id,evidence.quote);
    byOrigin.set(evidence.evidence_id,id);return id;
  };
  const completion=attribution.criterion_assessments.map(row=>({criterion_id:row.criterion_id,status:row.status,
    evidence_status:row.evidence_status,summary:row.summary,evidence_ids:[...new Set(row.evidence.map(select))]}));
  const problem_facts:ScoreProblemFact[]=[],problems:JsonObject[]=[];
  for(const finding of attribution.findings.filter(finding=>finding.type==='problem')){
    const problem=finding.problem!,needed=new Set(problem.component.flatMap(cause=>cause.evidence_ids));
    const proof=finding.evidence.filter(evidence=>needed.has(evidence.evidence_id)||!evidence.source&&evidence.message_index===candidate.final_index);
    const evidence_ids=[...new Set(proof.map(select))];
    if(!evidence_ids.length)throw Error('已接受归因的问题缺少可供评分引用的依据：'+finding.finding_id);
    const primary=problem.component.find(cause=>cause.role==='primary')!;
    const component=primary.technical_domain==='工具业务实现'?'tool_service':primary.technical_domain==='工具接入与协议'?'tool_call':'candidate_output';
    const fact:ScoreProblemFact={finding_id:finding.finding_id,description:finding.text,impact:finding.assessment.impact,stage:finding.stage,
      attribution:finding.assessment.evidence_status==='established'?'established':'hypothesis',component,evidence_ids,
      required_final_impact:finding.stage==='final_answer'&&finding.assessment.evidence_status==='established'};
    problem_facts.push(fact);problems.push({...fact,reason:finding.reason,importance:finding.importance,
      responsibility_certainties:problem.component.map(cause=>({role:cause.role,certainty:cause.certainty,evidence_gap:cause.evidence_gap}))});
  }
  const accepted={task_id:receipt.taskId,evaluator_version:receipt.evaluatorVersion,core_assessment:attribution.core_assessment,
    completion,problems,strengths:attribution.findings.filter(finding=>finding.type==='strength').map(finding=>({
      dimension:finding.dimension,stage:finding.stage,text:finding.text,reason:finding.reason,evidence_status:finding.assessment.evidence_status,
      evidence_ids:[...new Set(finding.evidence.map(select))]}))};
  const material:AcceptedScoreCase={case_id:candidate.input_id,task_question:question,
    candidate_output_id:'A',evidence:sources,availability:{candidate_output:'available',analysis:'not_collected',tool_trace:'not_collected'},
    public_requirements:{question},attribution_task_id:receipt.taskId,problem_facts,shared_quotes:quotes,
    requires_final_defect:attribution.core_assessment.meets_core===false||attribution.criterion_assessments.some(row=>
      attribution.task_analysis.requirements.some(requirement=>requirement.id===row.criterion_id)&&
      row.evidence_status==='established'&&['unmet','partial'].includes(row.status))};
  const input={case_id:material.case_id,task_question:question,candidate_answer:answer,accepted_attribution:accepted,
    evidence_catalog:quotes.map(({quote,...entry})=>({...entry,...(['Q','A'].includes(entry.source_id)?{}:{quote}),
      ...(!['Q','A'].includes(entry.source_id)?{origin_evidence_id:entry.source_id}:{})}))} as unknown as JsonObject;
  return {agent:'score',profile:'default',request:{input,sources:{case:{id:candidate.input_id,value:material}}}};
}
export function scoreExportState(state:RunState):RunState{return {...state,manifest:{...state.manifest,
  tasks:state.manifest.tasks.filter(task=>task.stage!=='score'||isFormalScore(task,state.receipts[task.id]))}};}
