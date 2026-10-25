import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError, schemaIssues, resolveEvidenceSelection, type AgentRequest, type ToolAudit, type ValidationIssue} from '@eval/contracts';
import schema from '../../../../schemas/attribution/submission.schema.json' with {type:'json'};
import type {AttributionResult,AttributionSubmission,Evidence} from './types.js';
import {resolveAttributionEvidence} from './source-evidence.js';
import {responsibilityIdentities,responsibilityComponentName} from './responsibility.js';
import {resolveDerivations} from './derivations.js';
import type {AttributionTransition} from './transitions.js';
import {validateEvaluation} from './validate.js';
const shape=new Ajv2020({allErrors:true,strict:false}).compile(schema);
export function validateModelSubmission(request:AgentRequest,draft:unknown,_audit:ToolAudit):ValidationIssue[]{
  const value=draft as Partial<AttributionSubmission>|null,issues:ValidationIssue[]=[];
  if(!value||typeof value!=='object')return issues;
  const available=(request.input.ground_truth as {available:boolean}).available;
  for(const key of ['is_correct','correct_reason'] as const){
    if(!available&&Object.hasOwn(value,key))issues.push({category:'decision',code:'correctness_without_standard',path:'/'+key,message:'无标准答案时不提交正确性字段，程序固定填null；仍调查实际问题。'});
    if(available&&!Object.hasOwn(value,key))issues.push({category:'decision',code:'correctness_required',path:'/'+key,message:'有标准答案时须填写比较判断及具体依据。'});
  }
  return issues;
}
export function resolveModelSubmission(request:AgentRequest,draft:unknown,audit:ToolAudit):AttributionResult{
  const valid=shape(draft),issues=valid?[]:schemaIssues(shape.errors,draft);
  issues.push(...validateModelSubmission(request,draft,audit));
  if(issues.length)throw new ValidationError(issues);
  const value=draft as AttributionSubmission,available=(request.input.ground_truth as {available:boolean}).available;
  const actors=responsibilityIdentities(request),edges=(request.input.answer as {transitions:AttributionTransition[]}).transitions;
  const edge=(index:number,path:string)=>{const found=edges.find(e=>e.transition_index===index);if(!found)throw new ValidationError([{category:'evidence',code:'transition_invalid',path,message:'选择本任务真实边界编号。',actual:index}]);return found;};
  const resolve=(index:number,path:string,observation?:string)=>resolveAttributionEvidence(request,resolveEvidenceSelection(audit.evidenceBank??[],{evidence_index:index,...(observation?{observation}:{})},path),audit,path);
  const result:AttributionResult={meta:{input_id:request.sources.answer.id},summary:value.summary,Problem:value.Problem.map((p,i)=>{
    const path='/Problem/'+i,selected=new Map<string,Evidence>();
    const observations=new Map(p.evidence_indices.flatMap(e=>typeof e==='number'?[]:[[e.image_number,e.observation] as const]));
    const evidence=(index:number,at:string)=>{const proof=resolve(index,at,observations.get(index));selected.set(proof.evidence_id,proof);return proof;};
    p.evidence_indices.forEach((index,j)=>evidence(typeof index==='number'?index:index.image_number,path+'/evidence_indices/'+j));
    const checks=p.checks.map((c,j)=>({...c,kind:edge(c.transition_index,path+'/checks/'+j).kind,
      before_evidence_ids:c.before_evidence_indices.map((index,k)=>evidence(index,path+'/checks/'+j+'/before_evidence_indices/'+k).evidence_id),
      after_evidence_ids:c.after_evidence_indices.map((index,k)=>evidence(index,path+'/checks/'+j+'/after_evidence_indices/'+k).evidence_id)}))
      .map(({before_evidence_indices:_before,after_evidence_indices:_after,...check})=>check);
    const causes=p.causes.map((cause,j)=>{const boundary=edge(cause.transition_index,path+'/causes/'+j),check=checks.find(c=>c.transition_index===cause.transition_index);return {...cause,
      actor_index:boundary.actor_index,component:responsibilityComponentName(boundary.actor_index===null?undefined:actors[boundary.actor_index-1]),kind:boundary.kind,
      role:j===0?'primary' as const:'contributing' as const,evidence_ids:[...new Set([...(check?.before_evidence_ids??[]),...(check?.after_evidence_ids??[])])]};});
    const calculations=p.calculations?.length?resolveDerivations(p.calculations,(index,at)=>evidence(index,at),path+'/calculations'):undefined;
    return {problem_id:'p'+(i+1),text:p.text,reason:p.reason,evidence_status:p.evidence_status,evidence:[...selected.values()],checks,causes,
      ...(p.uncertainty?{uncertainty:p.uncertainty}:{}),...(calculations?{calculations}:{})};
  }),has_standard_answer:available,is_correct:available?value.is_correct!:null,correct_reason:available?value.correct_reason!:null};
  validateEvaluation(request,result,audit);
  return result;
}
