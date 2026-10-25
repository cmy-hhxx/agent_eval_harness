import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError, schemaIssues, resolveEvidenceSelection, type AgentRequest, type ToolAudit, type ValidationIssue} from '@eval/contracts';
import schema from '../../../../schemas/attribution/submission.schema.json' with {type:'json'};
import type {AttributionResult,AttributionSubmission,ProblemEvidence} from './types.js';
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
    const path='/Problem/'+i,selected=new Map<string,ProblemEvidence>();
    const observations=new Map(p.evidence.map(e=>[e.index,e.observation]));
    const evidence=(index:number,at:string)=>{
      const proof=resolve(index,at,observations.get(index)), existing=selected.get(proof.evidence_id);
      if(existing)return existing;
      const entry={...proof,purposes:[] as ProblemEvidence['purposes']};selected.set(proof.evidence_id,entry);return entry;
    };
    p.evidence.forEach((item,j)=>{
      const proof=evidence(item.index,path+'/evidence/'+j);
      proof.purposes=[...new Set([...proof.purposes,...item.purposes])];
    });
    const component=(index:number|null,at:string)=>{
      if(index===null)return null;
      const boundary=edge(index,at);
      return boundary.actor_index===null?null:responsibilityComponentName(actors[boundary.actor_index-1]);
    };
    const related=p.related_responsibilities?.map((r,j)=>{
      const at=path+'/related_responsibilities/'+j;
      const ids=r.evidence_indices.map((index,k)=>{
        const proof=resolve(index,at+'/evidence_indices/'+k,observations.get(index));
        if(!selected.get(proof.evidence_id)?.purposes.includes('归因'))throw new ValidationError([{category:'evidence',code:'responsibility_evidence',path:at,message:'关联责任引用本问题中用途为归因的证据；原文只登记一次。'}]);
        return proof.evidence_id;
      });
      return {responsibility_boundary:r.responsibility_boundary,component:component(r.responsibility_boundary,at),
        attribution_reason:r.attribution_reason,evidence_ids:ids,...(r.uncertainties?{uncertainties:r.uncertainties}:{})};
    });
    const calculations=p.calculations?.length?resolveDerivations(p.calculations,(index,at)=>{
      const proof=resolve(index,at,observations.get(index));
      if(!selected.has(proof.evidence_id))throw new ValidationError([{category:'evidence',code:'derivation_evidence',path:at,message:'计算原数须引用本问题已登记的证据。'}]);
      return proof;
    }):undefined;
    return {problem_id:'p'+(i+1),text:p.text,reason:p.reason,evidence_status:p.evidence_status,evidence:[...selected.values()],
      responsibility_boundary:p.responsibility_boundary,component:component(p.responsibility_boundary,path+'/responsibility_boundary'),
      attribution_reason:p.attribution_reason,...(p.uncertainties?{uncertainties:p.uncertainties}:{}),
      ...(related?{related_responsibilities:related}:{}),...(calculations?{calculations}:{})};
  }),has_standard_answer:available,is_correct:available?value.is_correct!:null,correct_reason:available?value.correct_reason!:null};
  validateEvaluation(request,result,audit);
  return result;
}
