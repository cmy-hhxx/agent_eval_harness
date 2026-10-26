import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError, schemaIssues, resolveEvidenceSelection, type AgentRequest, type ToolAudit, type ValidationIssue} from '@eval/contracts';
import schema from '../../../../schemas/attribution/submission.schema.json' with {type:'json'};
import type {AttributionResult,AttributionSubmission,ProblemEvidence} from './types.js';
import {resolveAttributionEvidence} from './source-evidence.js';
import {responsibilityBindingIssues} from './responsibility-binding.js';
import {responsibilityDisplay,UNKNOWN_COMPONENT,type ResponsibilityMaterial} from './responsibility.js';
import {resolveDerivations} from './derivations.js';
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
  if(Array.isArray(value.Problem)&&value.Problem.some(p=>p?.responsibility_boundary===null||(Array.isArray(p?.related_responsibilities)&&p.related_responsibilities.some(r=>r?.responsibility_boundary===null))))issues.push({category:'decision',code:'responsibility_unresolved',path:'/Problem',message:'责任主体无法定位，本次保留问题草稿为未完成；不能删除缺陷、编造主体或正式输出未知责任。'});
  return issues;
}
export function resolveModelSubmission(request:AgentRequest,draft:unknown,audit:ToolAudit):AttributionResult{
  const valid=shape(draft),issues=valid?[]:schemaIssues(shape.errors,draft);
  issues.push(...validateModelSubmission(request,draft,audit));
  if(issues.length)throw new ValidationError(issues);
  const value=draft as AttributionSubmission,available=(request.input.ground_truth as {available:boolean}).available;
  const {transitions:edges,execution_nodes:nodes}=request.input.answer as unknown as ResponsibilityMaterial;
  const edge=(index:number,path:string)=>{const found=edges.find(e=>e.transition_index===index);if(!found)throw new ValidationError([{category:'evidence',code:'transition_invalid',path,message:'选择本任务真实边界编号。',actual:index}]);return found;};
  const chainState=(kind:ResponsibilityMaterial['transitions'][number]['kind'])=>kind==='request_formation'?'已采集该次请求形成及其后继证据。'
    :kind==='execution'?'已采集该次执行输入与返回证据。':kind==='transfer'?'已采集材料传递前后证据。'
      :kind==='generation'?'已采集该次生成输入与输出证据。':'已采集交付内容证据。';
  const resolve=(index:number,path:string,observation?:string)=>resolveAttributionEvidence(request,resolveEvidenceSelection(audit.evidenceBank??[],{evidence_index:index,...(observation?{observation}:{})},path),audit,path);
  const result:AttributionResult={meta:{input_id:request.sources.answer.id},summary:value.summary,Problem:value.Problem.map((p,i)=>{
    const seenBoundaries=new Set<number>();
    const selectBoundary=(selection:string|null,at:string)=>{if(selection===null)return null;const index=Number(selection.slice('boundary:'.length));edge(index,at);if(seenBoundaries.has(index))throw new ValidationError([{category:'decision',code:'responsibility_duplicate',path:at,message:'同一问题的同一责任调用只登记一次。'}]);seenBoundaries.add(index);return index;};
    const primary=selectBoundary(p.responsibility_boundary,'/Problem/'+i+'/responsibility_boundary');
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
    const explicit=new Map<number,{role:'primary'|'related';reason:string;evidence_ids:string[]}>();
    const related=p.related_responsibilities?.map((r,j)=>{
      const at=path+'/related_responsibilities/'+j;
      const ids=r.evidence_indices.map((index,k)=>{
        const proof=resolve(index,at+'/evidence_indices/'+k,observations.get(index));
        return proof.evidence_id;
      });
      const relatedBoundary=selectBoundary(r.responsibility_boundary,at);
      const bindingIssues=responsibilityBindingIssues(request,relatedBoundary,r.evidence_indices.map(index=>resolve(index,at)),audit,at);
      if(bindingIssues.length)throw new ValidationError(bindingIssues);
      explicit.set(relatedBoundary!,{role:'related',reason:r.attribution_reason,evidence_ids:ids});
      return {...responsibilityDisplay(request,relatedBoundary),
        attribution_reason:r.attribution_reason,evidence_ids:ids,...(r.uncertainties?{uncertainties:r.uncertainties}:{})};
    });
    const bindingIssues=responsibilityBindingIssues(request,primary,[...selected.values()].filter(e=>e.purposes.includes('归因')),audit,path+'/responsibility_boundary');
    if(bindingIssues.length)throw new ValidationError(bindingIssues);
    const calculations=p.calculations?.length?resolveDerivations(p.calculations,(index,at)=>{
      const proof=resolve(index,at,observations.get(index));
      return proof;
    }):undefined;
    // Responsibility is a model decision; the chain is a program projection of the selected
    // boundaries and only those captured ancestors that share the selected evidence.
    const selectedEvidence=[...selected.values()],attributionEvidence=selectedEvidence.filter(item=>item.purposes.includes('归因')).map(item=>item.evidence_id);
    explicit.set(primary! ,{role:'primary',reason:p.attribution_reason,evidence_ids:attributionEvidence.length?attributionEvidence:selectedEvidence.map(item=>item.evidence_id)});
    const chainEvidence=[...attributionEvidence,...(related??[]).flatMap(item=>item.evidence_ids)];
    const evidenceIds=new Set(chainEvidence.length?chainEvidence:selectedEvidence.map(item=>item.evidence_id));
    const context=new Set<number>();
    const visit=(index:number)=>{
      for(const predecessor of edge(index,path+'/responsibility_chain').predecessors){
        if(explicit.has(predecessor)||context.has(predecessor))continue;
        const boundary=edge(predecessor,path+'/responsibility_chain');
        if(![...boundary.before,...boundary.after].some(item=>evidenceIds.has(item.evidence_id)))continue;
        context.add(predecessor);visit(predecessor);
      }
    };
    for(const index of explicit.keys())visit(index);
    const chain=[...new Set([...explicit.keys(),...context])].sort((a,b)=>a-b).flatMap(index=>{
      const boundary=edge(index,path+'/responsibility_chain'),entry=explicit.get(index);
      const displayed=responsibilityDisplay(request,index).component;
      if(!entry&&boundary.kind!=='transfer'&&displayed===UNKNOWN_COMPONENT)return [];
      const captured=[...boundary.before,...boundary.after].map(item=>item.evidence_id).filter(id=>evidenceIds.has(id));
      return [{component:boundary.kind==='transfer'&&!entry?null:displayed,stage:boundary.kind,
        state:entry?.reason??chainState(boundary.kind),role:entry?.role??'context' as const,
        message_index:nodes.find(node=>node.execution_node_index===boundary.execution_node_index)?.message_index??null,
        evidence_ids:[...new Set(entry?.evidence_ids.length?entry.evidence_ids:captured)]}];
    });
    return {problem_id:'p'+(i+1),text:p.text,reason:p.reason,evidence_status:p.evidence_status,evidence:[...selected.values()],
      ...responsibilityDisplay(request,primary),
      responsibility_chain:chain,
      attribution_reason:p.attribution_reason,...(p.uncertainties?{uncertainties:p.uncertainties}:{}),
      ...(related?{related_responsibilities:related}:{}),...(calculations?{calculations}:{})};
  }),has_standard_answer:available,is_correct:available?value.is_correct!:null,correct_reason:available?value.correct_reason!:null};
  validateEvaluation(request,result,audit);
  return result;
}
