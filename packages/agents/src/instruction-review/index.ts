import { Ajv2020 } from "ajv/dist/2020.js";
import { agentPrompt } from "@eval/prompts";
import { schemaIssues, ValidationError, type AgentDefinition, type AgentProfile, type AgentRequest, type ToolAudit, type ReviewCase, type ReviewQuote } from "@eval/contracts";
import { reviewSources } from "@eval/tools";
import submissionSchema from "../../../../schemas/instruction-review/submission.schema.json" with {type:"json"};
import resultSchema from "../../../../schemas/instruction-review/result.schema.json" with {type:"json"};
import requestSchema from "../../../../schemas/instruction-review/request.schema.json" with {type:"json"};

export interface InstructionCheck {rule:string;status:"met"|"violated"|"unverified"|"not_applicable";reason:string;rule_evidence_ids:string[];behavior_evidence_ids:string[]}
export interface InstructionReview {summary:string;checks:InstructionCheck[];evidence:ReviewQuote[]}
const shape=new Ajv2020({allErrors:true,strict:false}).compile(resultSchema);
export function validateInstructionReview(request:AgentRequest,value:unknown,audit:ToolAudit){
  if(!shape(value))throw new ValidationError(schemaIssues(shape.errors,value));
  const result=value as unknown as InstructionReview,sources=reviewSources(request.sources.case.value as ReviewCase,audit.review);
  const fail=(path:string,message:string):never=>{throw new ValidationError([{category:"evidence",code:"instruction_review",path,message}]);};
  const ids=new Map<string,ReviewQuote>(),spans=new Set<string>();
  for(const [i,row]of result.evidence.entries()){
    const source=sources[row.source_id],span=JSON.stringify([row.source_id,row.start,row.end]);
    if(source===undefined||ids.has(row.evidence_id)||spans.has(span)||row.end<=row.start||row.end>Array.from(source).length||Array.from(source).slice(row.start,row.end).join('')!==row.quote)
      fail(`/evidence/${i}`,"证据必须唯一并准确来自本会话登记的原文。");
    const recorded=audit.review?.quotes.find(item=>item.evidence_id===row.evidence_id);
    if(!recorded||JSON.stringify(recorded)!==JSON.stringify(row))fail(`/evidence/${i}`,"证据必须由本次取证账本生成。");
    ids.set(row.evidence_id,row);spans.add(span);
  }
  if((request.input.norm_catalog as unknown[]).length&&!result.checks.length)fail('/checks','有内部规范材料时须记录实际检查或未核验范围。');
  for(const [i,row]of result.checks.entries()){
    if(!row.rule_evidence_ids.length||row.rule_evidence_ids.some(id=>!ids.get(id)?.source_id.startsWith('N')))fail(`/checks/${i}/rule_evidence_ids`,'规则证据只选择本会话明确登记的N来源。');
    if(row.behavior_evidence_ids.some(id=>!ids.has(id)||ids.get(id)!.source_id.startsWith('N')))fail(`/checks/${i}/behavior_evidence_ids`,'行为证据须来自公开任务、实际执行或交付，不能由规则代替。');
    if(['met','violated','not_applicable'].includes(row.status)&&!row.behavior_evidence_ids.length)fail(`/checks/${i}`,'确认遵守或违反须引用实际行为，缺材料时保留unverified。');
  }
}
const prompt=agentPrompt('instruction-review',['review_material','read_artifact'], { fileSubmission: false });
export const instructionReviewProfile:AgentProfile={id:'default',...prompt,
  requestSchema,submissionSchema,resultSchema,
  toolNames:['review_material','read_artifact'],
  resolve(request,draft,audit){const value=draft as Omit<InstructionReview,'evidence'>;
    const used=new Set(value.checks.flatMap(row=>[...row.rule_evidence_ids,...row.behavior_evidence_ids]));
    const evidence=[...used].map(id=>{const row=audit.review?.quotes.find(item=>item.evidence_id===id);if(!row)throw new ValidationError([{category:'evidence',code:'instruction_review',path:'/checks',message:'引用编号必须来自本次review_material.quote。'}]);return row;});
    const result={...value,evidence};validateInstructionReview(request,result,audit);return result;},validate:validateInstructionReview,
};
export const instructionReviewAgent:AgentDefinition={id:'instruction-review',profiles:{default:instructionReviewProfile}};
