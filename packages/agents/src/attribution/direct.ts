import { Ajv2020 } from "ajv/dist/2020.js";
import { agentPrompt } from "@eval/prompts";
import { schemaIssues, ValidationError, type AgentProfile, type AgentRequest, type ToolAudit, type ReviewCase, type ReviewQuote } from "@eval/contracts";
import { reviewSources } from "@eval/tools";
import {isChineseAttributionText} from './direct-language.js';
import submissionSchema from "../../../../schemas/attribution/direct-submission.schema.json" with {type:"json"};
import resultSchema from "../../../../schemas/attribution/direct-result.schema.json" with {type:"json"};
export interface DirectFinding {finding_id:string;type:"strength"|"problem";dimension:string;stage:string;importance:string;text:string;reason:string;evidence_status:"established"|"uncertain";evidence_ids:string[];component:string[];label:string|null;definition:string|null}
export interface DirectAttribution {summary:string;findings:DirectFinding[];evidence:ReviewQuote[]}
const validateShape=new Ajv2020({allErrors:true,strict:false}).compile(resultSchema);
export function validateDirectAttribution(request:AgentRequest,value:unknown,audit:ToolAudit){
  if(!validateShape(value))throw new ValidationError(schemaIssues(validateShape.errors,value));
  const result=value as unknown as DirectAttribution,sources=reviewSources(request.sources.case.value as unknown as ReviewCase,audit.review);
  const ids=new Set<string>(),spans=new Set<string>();
  const bad=(path:string,message:string):never=>{throw new ValidationError([{category:"evidence",code:"direct_attribution",path,message}]);};
  const chinese=(text:string,path:string)=>{
    if(!isChineseAttributionText(text))throw new ValidationError([{category:'structure',code:'attribution_language',path,message:'评测点评必须用中文叙述；专有名词、工具名和证据原文可以保留原语言。'}]);
  };
  chinese(result.summary,'/summary');
  for(const [i,row] of result.evidence.entries()){
    const chars=Array.from(sources[row.source_id]??''),span=JSON.stringify([row.source_id,row.start,row.end]);
    if(ids.has(row.evidence_id)||spans.has(span)||row.end<=row.start||row.start<0||row.end>chars.length||chars.slice(row.start,row.end).join('')!==row.quote)bad(`/evidence/${i}`,'共享证据必须唯一并准确引用本题原文。');ids.add(row.evidence_id);spans.add(span);
  }
  const descriptions=new Set<string>(),allowed=new Set([...(request.input.tool_names as string[]),"模型自身推理","执行环境与权限配置","上下文召回","输出呈现"]);
  for(const [i,f] of result.findings.entries()){
    if(f.finding_id!==`f${i+1}`||f.evidence_ids.some(id=>!ids.has(id)))bad(`/findings/${i}`,'问题身份由程序绑定，证据只引用本题共享表。');
    if(f.type==='problem'?!f.label?.trim()||!f.definition?.trim():f.label!==null||f.definition!==null||f.component.length>0)bad(`/findings/${i}`,'问题填写平铺的component/label/definition；优点用空责任数组和null标签、定义。');
    if(f.component.some(name=>!allowed.has(name)))bad(`/findings/${i}/component`,'责任只选择实际工具名或已有责任类别，未知填空数组。');
    for(const field of ['text','reason','label','definition'] as const)if(f[field]!==null)chinese(f[field]!,`/findings/${i}/${field}`);
    const key=f.text.trim();if(!key||descriptions.has(key))bad(`/findings/${i}/text`,'同一问题只记录一次。');descriptions.add(key);
  }
}
const prompt=agentPrompt('attribution',['review_material','review_calculate','read_artifact'],'direct');
export const directAttributionProfile:AgentProfile={id:'direct',...prompt,requestSchema:{type:'object',required:['case_id','task_question','availability','tool_names'],additionalProperties:true},submissionSchema,resultSchema,
  toolNames:['review_material','review_calculate','read_artifact'],
  modelSubmissionSchema(request){const schema=structuredClone(submissionSchema);schema.properties.findings.items.properties.component.items={...schema.properties.findings.items.properties.component.items,enum:[...(request.input.tool_names as string[]),'模型自身推理','执行环境与权限配置','上下文召回','输出呈现']} as any;return schema;},
  resolve(request,draft,audit){const value=draft as Omit<DirectAttribution,'evidence'>;
    const used=new Set(value.findings.flatMap(f=>f.evidence_ids));
    const evidence=[...used].map(id=>{const row=audit.review?.quotes.find(q=>q.evidence_id===id);if(!row)throw new ValidationError([{category:'evidence',code:'direct_attribution',path:'/findings',message:'证据编号必须来自本次review_material.quote返回，不能编造。'}]);return row;});
    const result={...value,findings:value.findings.map((f,i)=>({...f,finding_id:`f${i+1}`})),evidence};validateDirectAttribution(request,result,audit);return result;},validate:validateDirectAttribution,
};
