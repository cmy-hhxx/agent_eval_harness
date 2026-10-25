import {agentPrompt,scoreDirectory} from '@eval/prompts';
import {ValidationError,type AgentDefinition,type AgentProfile,type AgentRequest,type ReviewCase,type ReviewQuote} from '@eval/contracts';
import resultSchema from '../../../../schemas/score/result.schema.json' with {type:'json'};
import submissionSchema from '../../../../schemas/score/submission.schema.json' with {type:'json'};
import {validateScore} from './validate.js';
import type {ScoreResult,Rating,ScoreFinding} from './types.js';
export * from './types.js';
export {validateScore} from './validate.js';
export interface ScoreProblemFact {
  finding_id:string;description:string;impact:string;stage:string;
  attribution:ScoreFinding['attribution'];component:ScoreFinding['component'];
  evidence_ids:string[];required_final_impact:boolean;
}
export interface AcceptedScoreCase extends ReviewCase {
  attribution_task_id:string;problem_facts:ScoreProblemFact[];shared_quotes:ReviewQuote[];requires_final_defect:boolean;
}
const source=(request:AgentRequest)=>request.sources.case.value as unknown as AcceptedScoreCase;
const fail=(path:string,message:string):never=>{throw new ValidationError([{category:'decision',code:'score_contract',path,message}]);};
const units=Object.keys(scoreDirectory.units),diagnostics=Object.keys(scoreDirectory.diagnostics);
const prompt=agentPrompt('score',[],{fileSubmission:false});
const grade=(row:Omit<Rating,'grade'>,final=false):Rating=>({...row,grade:row.status==='not_applicable'?'不适用':row.score_range?'待核':
  (final?scoreDirectory.final_grades:scoreDirectory.core_grades)[String(row.score)]});
export const scoreProfile:AgentProfile={
  id:'default',...prompt,toolNames:[],
  requestSchema:{type:'object',required:['case_id','task_question','candidate_answer','accepted_attribution','evidence_catalog'],additionalProperties:true},
  submissionSchema,resultSchema,
  modelSubmissionSchema(request){const schema=structuredClone(submissionSchema),count=source(request).problem_facts.length;
    Object.assign(schema.properties.problem_assignments,{minItems:count,maxItems:count});return schema;},
  renderPrompt(input,policy,failure){return prompt.renderPrompt({...input,score_directory:{
    units:units.map((id,index)=>({unit_index:index+1,id,name:scoreDirectory.units[id]})),
    diagnostics:diagnostics.map((id,index)=>({diagnostic_index:index+1,id,name:scoreDirectory.diagnostics[id],parent:scoreDirectory.parents[id]}))}},policy,failure);},
  resolve(request,draft,audit){
    const value=draft as any,material=source(request);
    if(value.problem_assignments.length!==material.problem_facts.length)fail('/problem_assignments','按已接受归因的问题目录逐项映射，不增删或复核问题。');
    const findings:ScoreFinding[]=material.problem_facts.map((fact,index)=>{
      const assignment=value.problem_assignments[index];
      if(fact.required_final_impact&&!assignment.final_delivery_affected)
        fail(`/problem_assignments/${index}/final_delivery_affected`,'归因已确认的最终交付缺陷必须进入总分，不能以核心结果仍可用为由忽略。');
      const affected=assignment.affected_unit_indices.map((n:number)=>units[n-1]),mapped=assignment.diagnostic_indices.map((n:number)=>diagnostics[n-1]);
      return {finding_id:fact.finding_id,description:fact.description,attribution:fact.attribution,component:fact.component,
        evidence_ids:[...fact.evidence_ids],affected_item_ids:affected,diagnostic_ids:mapped,
        primary_diagnostic_id:mapped[0]??'unmapped',...(mapped.length?{}:{unmapped_reason:assignment.unmapped_reason})};
    });
    const finding_ids=material.problem_facts.flatMap((fact,index)=>value.problem_assignments[index].final_delivery_affected?[fact.finding_id]:[]);
    if(material.requires_final_defect&&!material.problem_facts.some(fact=>fact.attribution==='established'&&finding_ids.includes(fact.finding_id)))
      fail('/problem_assignments','归因已确认必要交付未完全满足，总分必须保留对应的已确认交付缺陷。');
    const evaluations=value.evaluations.map((row:any,index:number)=>({...grade(row),item_id:units[index],item_name:scoreDirectory.units[units[index]]}));
    const diagnosticRows=value.diagnostics.map((row:any,index:number)=>({...row,diagnostic_id:diagnostics[index],diagnostic_name:scoreDirectory.diagnostics[diagnostics[index]]}));
    const result:ScoreResult={case_id:material.case_id,evaluations,diagnostics:diagnosticRows,findings,
      final_answer_score:{...grade(value.final_answer_score,true),finding_ids},
      explicit_probability:value.explicit_probability,probability_evidence_ids:value.probability_evidence_ids,evidence:[]};
    const used=new Set<string>([...evaluations,...diagnosticRows,...findings,result.final_answer_score,{evidence_ids:result.probability_evidence_ids}].flatMap(row=>row.evidence_ids));
    result.evidence=[...used].map(id=>material.shared_quotes.find(quote=>quote.evidence_id===id)??fail('/evidence_ids','只引用程序提供的归因或原问、完整回答证据编号。'));
    validateScore(request,result,audit);return result;
  },
  validate(request,result,audit){
    validateScore(request,result,audit);
    if('assessment_status' in (result as object))return;
    const value=result as ScoreResult,facts=source(request).problem_facts;
    if(value.findings.length!==facts.length)fail('/findings','正式问题须逐项保留源归因。');
    for(const[index,fact]of facts.entries()){
      const row=value.findings[index];
      if(row.finding_id!==fact.finding_id||row.description!==fact.description||row.attribution!==fact.attribution||row.component!==fact.component||JSON.stringify(row.evidence_ids)!==JSON.stringify(fact.evidence_ids))
        fail(`/findings/${index}`,'评分不能重写归因问题、确定性、责任归属或证据。');
      if(fact.required_final_impact&&!value.final_answer_score.finding_ids.includes(fact.finding_id))fail('/final_answer_score','不能遗漏已确认的最终交付缺陷。');
    }
  },
};
export const scoreAgent:AgentDefinition={id:'score',profiles:{default:scoreProfile}};
