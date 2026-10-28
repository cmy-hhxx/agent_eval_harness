import {agentPrompt,scoreDirectory} from '@eval/prompts';
import {ValidationError,type AgentDefinition,type AgentProfile,type AgentRequest,type ReviewCase,type ReviewQuote} from '@eval/contracts';
import resultSchema from '../../../../schemas/score/result.schema.json' with {type:'json'};
import submissionSchema from '../../../../schemas/score/submission.schema.json' with {type:'json'};
import {validateScore} from './validate.js';
import type {ScoreResult,Rating,ScoreFinding} from './types.js';
export * from './types.js';
export {validateScore} from './validate.js';
export interface ScoreProblemFact {
  finding_id:string;description:string;reason:string;
  attribution:ScoreFinding['attribution'];component:ScoreFinding['component'];
  evidence_ids:string[];
}
export interface AcceptedScoreCase extends ReviewCase {
  attribution_task_id:string;problem_facts:ScoreProblemFact[];shared_quotes:ReviewQuote[];
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
    Object.assign(schema.properties.problem_assignments,{minItems:count,maxItems:count});
    Object.assign(schema.properties.problem_assignments.items.properties.finding_index,{maximum:Math.max(0,count-1)});return schema;},
  renderPrompt(input,policy,failure){return prompt.renderPrompt({...input,score_directory:{
    units:units.map((id,index)=>({unit_index:index+1,id,name:scoreDirectory.units[id]})),
    diagnostics:diagnostics.map((id,index)=>({diagnostic_index:index+1,id,name:scoreDirectory.diagnostics[id],parent:scoreDirectory.parents[id]}))}},policy,failure);},
  resolve(request,draft,audit){
    const value=draft as any,material=source(request);
    if(value.problem_assignments.length!==material.problem_facts.length)fail('/problem_assignments','按已接受归因的问题目录逐项映射，不增删或复核问题。');
    const indexed=<T>(rows:T[],key:string,count:number,path:string):T[]=>{
      const byIndex=new Map<number,T>();
      rows.forEach((row,index)=>{
        const number=(row as any)[key];
        if(byIndex.has(number))fail(`${path}/${index}/${key}`,`编号 ${number} 重复；每项必须恰好提交一次。`);
        byIndex.set(number,row);
      });
      for(let index=0;index<count;index++)if(!byIndex.has(index+1))fail(path,`${path} 缺少编号 ${index+1}。`);
      return Array.from({length:count},(_,index)=>byIndex.get(index+1)!);
    };
    const evaluationRows=indexed<any>(value.evaluations,'unit_index',units.length,'/evaluations');
    const diagnosticRowsRaw=indexed<any>(value.diagnostics,'diagnostic_index',diagnostics.length,'/diagnostics');
    const assignmentMap=new Map<number,any>();
    value.problem_assignments.forEach((row:any,index:number)=>{
      if(assignmentMap.has(row.finding_index))fail(`/problem_assignments/${index}/finding_index`,`问题编号 ${row.finding_index} 重复；每个已接受问题必须恰好映射一次。`);
      assignmentMap.set(row.finding_index,row);
    });
    for(let index=0;index<material.problem_facts.length;index++)if(!assignmentMap.has(index))fail('/problem_assignments',`缺少问题编号 ${index} 的映射。`);
    const assignmentRows=material.problem_facts.map((_,index)=>assignmentMap.get(index));
    const findings:ScoreFinding[]=material.problem_facts.map((fact,index)=>{
      const assignment=assignmentRows[index];
      const affected=assignment.affected_unit_indices.map((n:number)=>units[n-1]),mapped=assignment.diagnostic_indices.map((n:number)=>diagnostics[n-1]);
      return {finding_id:fact.finding_id,description:fact.description,attribution:fact.attribution,component:fact.component,
        evidence_ids:[...fact.evidence_ids],affected_item_ids:affected,diagnostic_ids:mapped,
        primary_diagnostic_id:mapped[0]??'unmapped',...(mapped.length?{}:{unmapped_reason:assignment.unmapped_reason})};
    });
    const finding_ids=material.problem_facts.flatMap((fact,index)=>assignmentRows[index].final_delivery_affected?[fact.finding_id]:[]);
    const evaluations=evaluationRows.map((row:any)=>{const{unit_index,...judgment}=row;
      return {...grade(judgment),applicability:judgment.applicability,item_id:units[unit_index-1],
        item_name:scoreDirectory.units[units[unit_index-1]]};});
    const diagnosticRows=diagnosticRowsRaw.map((row:any)=>{const{diagnostic_index,...judgment}=row;
      return {...judgment,diagnostic_id:diagnostics[diagnostic_index-1],
        diagnostic_name:scoreDirectory.diagnostics[diagnostics[diagnostic_index-1]]};});
    const result:ScoreResult={case_id:material.case_id,evaluations,diagnostics:diagnosticRows,findings,
      final_answer_score:{...grade(value.final_answer_score,true),finding_ids},
      explicit_probability:value.explicit_probability,probability_evidence_ids:value.probability_evidence_ids,evidence:[]};
    const used=new Set<string>([...evaluations,...diagnosticRows,...findings,result.final_answer_score,{evidence_ids:result.probability_evidence_ids}].flatMap(row=>row.evidence_ids));
    result.evidence=[...used].map(id=>material.shared_quotes.find(quote=>quote.evidence_id===id)??fail('/evidence_ids','只引用已列出的归因、原问或完整回答证据编号。'));
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
    }
  },
};
export const scoreAgent:AgentDefinition={id:'score',profiles:{default:scoreProfile}};
