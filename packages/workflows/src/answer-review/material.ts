import type { ReviewCase } from "@eval/contracts";
import { isToolSpan, type Candidate, type RawInput } from "@eval/workflows/comparison";
/** Candidate private instructions never enter either independent evaluator's source map. */
function publicValue(value: unknown): unknown {
  if(Array.isArray(value))return value.map(publicValue).filter(v=>v!==undefined);
  if(!value||typeof value!=='object')return value;
  const row=value as Record<string,unknown>;
  if(row.role==='system'||row.role==='developer')return undefined;
  return Object.fromEntries(Object.entries(row).filter(([key])=>!['system_prompt','developer_prompt','systemPrompt','developerPrompt'].includes(key)).flatMap(([key,child])=>{const clean=publicValue(child);return clean===undefined?[]:[[key,clean]];}));
}
function content(value:unknown):string{return typeof value==='string'?value:JSON.stringify(value??'',null,2);}
export function answerReviewMaterial(candidate:Candidate,raw:RawInput,caseId:string){
  const messages=raw.messages as Record<string,unknown>[];
  const final=publicValue(messages[candidate.final_index]) as Record<string,unknown>;
  const evidence:Record<string,string>={Q:candidate.question,A:content(final?.content??final)};
  const origins:Record<string,unknown>={Q:{kind:'question'},A:{message_index:candidate.final_index,kind:'final_answer'}};
  const toolNames=new Set<string>();let index=0,analysis=false,tool=false;
  for(const [message_index,message] of messages.entries()){
    if(message_index===candidate.final_index)continue;
    const value=publicValue(message) as Record<string,unknown>|undefined;if(!value)continue;
    if(message.role==='user'&&content(message.content)===candidate.question)continue;
    const sourceId=`C${String(++index).padStart(3,'0')}`;evidence[sourceId]=JSON.stringify(value,null,2);origins[sourceId]={message_index,kind:message.type??message.role};
    const isTool = ['function_call','function_call_output','tool_call','tool_result'].includes(String(value.type)) ||
      value.role === 'tool' || isToolSpan(value);
    if(isTool){tool=true;if(typeof value.name==='string')toolNames.add(value.name);}
    if(!isTool && (['reasoning','llm_turn'].includes(String(value.type)) ||
      value.type==='span' && ['reasoning','thinking'].includes(String(value.name)) ||
      value.role==='assistant' || value.reasoning || value.analysis)) analysis=true;
  }
  if(candidate.reference!==null&&candidate.reference!==undefined){evidence.R=content(candidate.reference);origins.R={kind:'provided_reference'};}
  const material:ReviewCase={case_id:caseId,task_question:candidate.question,candidate_output_id:'A',evidence,
    availability:{candidate_output:'available',analysis:analysis?'available':'not_collected',tool_trace:tool?'partial':'not_collected'},public_requirements:{question:candidate.question}};
  // Present short calls and useful return prefixes together, with explicit remaining ranges.
  let remaining=16000;
  const initial_sources=Object.entries(evidence).filter(([id])=>id!=='Q'&&id!=='A').map(([source_id,text])=>{
    const chars=Array.from(text),end=Math.min(chars.length,chars.length<=2400?chars.length:1200,remaining);remaining-=end;
    return {source_id,start:0,end,content:chars.slice(0,end).join(''),next_start:end<chars.length?end:null};
  });
  const shown={case_id:caseId,task_question:candidate.question,candidate_output_id:'A',availability:material.availability,public_requirements:material.public_requirements,
    candidate_response:Array.from(evidence.A).slice(0,12000).join(''),answer_requires_more:Array.from(evidence.A).length>12000,
    initial_sources,tool_availability:{external_search:Boolean(process.env.SEARCH_API_KEY)},
    evidence_catalog:Object.entries(evidence).map(([source_id,text])=>({source_id,length:Array.from(text).length})),tool_names:[...toolNames]};
  return {material,shown,origins};
}
