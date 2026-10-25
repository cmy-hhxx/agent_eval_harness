import {Ajv2020} from 'ajv/dist/2020.js';
import {ValidationError,schemaIssues,parseEvidenceCoordinates,type AgentRequest,type ToolAudit,type ValidationIssue} from '@eval/contracts';
import {images,traceReadCoverage} from '@eval/tools';
import schema from '../../../../schemas/attribution/result.schema.json' with {type:'json'};
import type {AttributionResult} from './types.js';
import {componentCatalogIssues,responsibilityIssues} from './responsibility.js';
import {captureMarkerProblemIssues,foreignActualIssues,referenceMaterialIssues,validateAttributionEvidence} from './source-evidence.js';
import {investigationValidator,attributionReadCovered,type InvestigationValidator} from './investigation.js';
import {normDirectoryIssues} from './norm-directory.js';
const validator=new Ajv2020({allErrors:true,strict:false}).compile(schema);
function finalImageReadIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as {answer:{final_message_index:number}};
  const index = input.answer.final_message_index;
  const raw = request.sources.answer.value as { messages: unknown[] };
  return images(raw.messages[index]).length && !audit.viewedImages.includes(`answer:${index}`)
    ? [{ category: "decision", code: "final_image_not_viewed", path: "/Problem",
      message: `最终回答含图片，必须先 view_image(candidate="answer", message_index=${index}) 再判交付是否缺失；表格/名单可能在图片里。` }]
    : [];
}

/** Business rules that can be checked before evidence references are resolved. */

export function validateEvaluation(request:AgentRequest,result:unknown,audit:ToolAudit,investigate:InvestigationValidator=investigationValidator(request)):void{
  if(!validator(result))throw new ValidationError(schemaIssues(validator.errors,result));
  const value=result as unknown as AttributionResult,answer=request.input.answer as {final_message_index:number;deferred_final_material:{message_index:number;path:string;total_chars:number}[]};
  const issues:ValidationIssue[]=[...componentCatalogIssues(request),...normDirectoryIssues(request),...referenceMaterialIssues(request),...finalImageReadIssues(request,audit),...captureMarkerProblemIssues(request,value),...foreignActualIssues(request,value)];
  if(value.has_standard_answer!==(request.input.ground_truth as {available:boolean}).available)issues.push({category:'decision',code:'standard_answer_mismatch',path:'/has_standard_answer',message:'是否有标准答案由真实输入确定。'});
  if(value.meta.input_id!==request.sources.answer.id)issues.push({category:'decision',code:'meta_input_mismatch',path:'/meta/input_id',message:'来源身份必须与真实输入一致。'});
  for(const material of answer.deferred_final_material){const read={candidate:'answer',message_index:material.message_index,kind:'text' as const,path:material.path,start:0,end:material.total_chars};
    if(!traceReadCoverage(audit,read).covered)issues.push({category:'evidence',code:'investigation_read_required',path:'/summary',message:'最终材料尚未完整读取，不能宣告评审完成。',expected:{read_requests:[read]}});}
  const raw=request.sources.answer.value as {messages:unknown[]};
  value.Problem.forEach((problem,i)=>{
    const path='/Problem/'+i;
    if(problem.problem_id!=='p'+(i+1))issues.push({category:'structure',code:'problem_id',path:path+'/problem_id',message:'问题编号由程序按正式记录顺序生成。'});
    issues.push(...validateAttributionEvidence(request,problem.evidence.map((item,j)=>({item,location:path+'/evidence/'+j})),audit));
    const reads=problem.evidence.flatMap(e=>{const p=parseEvidenceCoordinates(e.evidence_id);return p&&p.kind!=='image'?[{candidate:e.source??'answer',message_index:p.message_index,kind:p.kind,path:p.path,start:p.start,end:p.end}]:[];});
    const missing=reads.filter(read=>!attributionReadCovered(audit,read,read.candidate==='answer'?raw:request.sources[read.candidate].value as {messages:unknown[]}));
    if(missing.length)issues.push({category:'evidence',code:'investigation_read_required',path:path+'/evidence',message:'所选证据可读但尚未读取；补齐后再判断。',expected:{read_requests:missing}});
    if(!problem.evidence.some(e=>!e.source&&e.message_index>0))issues.push({category:'evidence',code:'problem_actual_required',path:path+'/evidence',message:'问题须引用本方真实主张、行为或交付，不能只引用题目。'});
    issues.push(...responsibilityIssues(request,problem,problem.evidence,path),...investigate(problem,problem.evidence,audit,path));
  });
  if(issues.length)throw new ValidationError(issues);
}
