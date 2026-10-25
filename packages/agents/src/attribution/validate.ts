import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError,schemaIssues,type AgentRequest,type ToolAudit,type ValidationIssue} from '@eval/contracts';
import schema from '../../../../schemas/attribution/result.schema.json' with {type:'json'};
import type {AttributionResult} from './types.js';
import {responsibilityIssues} from './responsibility.js';
import {validateDerivations} from './derivations.js';
const validator=new Ajv2020({allErrors:true,strict:false}).compile(schema);

/** Final shape checks. Submission additionally checks call binding and final-generation material. */
export function validateEvaluation(request:AgentRequest,result:unknown,_audit:ToolAudit):void{
  if(!validator(result))throw new ValidationError(schemaIssues(validator.errors,result));
  const value=result as unknown as AttributionResult,issues:ValidationIssue[]=[];
  if(value.has_standard_answer!==(request.input.ground_truth as {available:boolean}).available)issues.push({category:'decision',code:'standard_answer_mismatch',path:'/has_standard_answer',message:'是否有标准答案由真实输入确定。'});
  if(value.meta.input_id!==request.sources.answer.id)issues.push({category:'decision',code:'meta_input_mismatch',path:'/meta/input_id',message:'来源身份必须与真实输入一致。'});
  value.Problem.forEach((problem,i)=>{
    const path='/Problem/'+i;
    if(problem.problem_id!=='p'+(i+1))issues.push({category:'structure',code:'problem_id',path:path+'/problem_id',message:'问题编号由程序按正式记录顺序生成。'});
    issues.push(...responsibilityIssues(request,problem,problem.evidence,path),...validateDerivations(problem.calculations??[],path+'/calculations'));
  });
  if(issues.length)throw new ValidationError(issues);
}
