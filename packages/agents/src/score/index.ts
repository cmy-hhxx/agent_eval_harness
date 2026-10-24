import {agentPrompt,scoreDirectory} from '@eval/prompts';
import {canonical,ValidationError,type AgentDefinition,type AgentProfile,type AgentRequest,type ReviewAudit,type ReviewCase,type ReviewQuote,type ToolAudit} from '@eval/contracts';
import resultSchema from '../../../../schemas/score/result.schema.json' with {type:'json'};
import axisSchema from '../../../../schemas/score/axis-submission.schema.json' with {type:'json'};
import evidenceSchema from '../../../../schemas/score/evidence-submission.schema.json' with {type:'json'};
import evidenceResultSchema from '../../../../schemas/score/evidence-result.schema.json' with {type:'json'};
import axisResultSchema from '../../../../schemas/score/axis-result.schema.json' with {type:'json'};
import finalSchema from '../../../../schemas/score/final-submission.schema.json' with {type:'json'};
import {validateScore,validateScoreAxis} from './validate.js';
import {scoreAxes,type ScoreAxis,type ScoreAxisResult,type ScoreEvidence,type ScoreException,type ScoreFinding,type ScoreRepair,type ScoreResult,type Rating} from './types.js';
export * from './types.js';
export {validateScore} from './validate.js';
export interface ScoreContext {axis?:ScoreAxis;axes?:ScoreAxisResult[];repair_used?:boolean;evidence_used?:boolean;previous_evidence?:ScoreEvidence}
function fail(path:string,message:string):never{throw new ValidationError([{category:'decision',code:'score_contract',path,message}]);}
const material=(request:AgentRequest)=>request.sources.case.value as unknown as ReviewCase;
export function scoreAudit(request:AgentRequest,audit:ToolAudit):ReviewAudit{
  return audit.review??=structuredClone(material(request).review_seed??{quotes:[],sources:[],actions:[],viewed:[],searches:[]});
}
function quotes(request:AgentRequest,audit:ToolAudit,rows:{evidence_ids:string[]}[]){
  const proof=scoreAudit(request,audit),used=new Set(rows.flatMap(row=>row.evidence_ids));
  return [...used].map(id=>proof.quotes.find(q=>q.evidence_id===id)??fail('/evidence_ids','证据编号必须来自本题已取得的quote结果。'));
}
function rating<T extends Omit<Rating,'grade'>>(row:T,final=false):T&{grade:string}{
  const grades=final?scoreDirectory.final_grades:scoreDirectory.core_grades;
  return {...row,grade:row.status==='not_applicable'?'不适用':row.score_range?'待核':grades[String(row.score)]};
}
/** Exact spans alone determine evidence identity; no semantic judgment or score is derived here. */
export function combineScoreAxes(parts:ScoreAxisResult[],sharedQuotes:ReviewQuote[]):ScoreAxisResult[]{
  const spans=new Map(sharedQuotes.map(quote=>[canonical([quote.source_id,quote.start,quote.end]),quote]));
  return parts.map(part=>{
    const refs=new Map<string,string>();
    for(const quote of part.evidence){const key=canonical([quote.source_id,quote.start,quote.end]);let row=spans.get(key);
      if(row&&row.quote!==quote.quote)fail('/evidence','同一坐标对应不同证据原文。');
      if(!row){row={...quote,evidence_id:`EV_${spans.size+1}`};spans.set(key,row);}refs.set(quote.evidence_id,row.evidence_id);}
    const evidence_ids=(ids:string[])=>ids.map(id=>refs.get(id)??fail('/evidence_ids','分项引用缺失证据。'));
    const references=(text:string)=>text.replace(/\bEV_\d+\b/g,id=>refs.get(id)??id);
    const axis=part.evaluations[0].item_id[0];
    return {...part,evaluations:part.evaluations.map(row=>({...row,reason:references(row.reason),evidence_ids:evidence_ids(row.evidence_ids)})),
      diagnostics:part.diagnostics.map(row=>({...row,reason:references(row.reason),evidence_ids:evidence_ids(row.evidence_ids)})),
      findings:part.findings.map(row=>({...row,finding_id:`${axis}:${row.finding_id}`,description:references(row.description),evidence_ids:evidence_ids(row.evidence_ids)})),
      evidence:[...new Set(part.evidence.map(q=>refs.get(q.evidence_id)!))].map(id=>[...spans.values()].find(q=>q.evidence_id===id)!)};
  });
}
export function scoreFinalMaterial(parts:ScoreAxisResult[]){
  return parts.map(({evaluations,diagnostics,evidence:_evidence,case_id:_case,...part})=>({...part,
    evaluations:evaluations.map(({score:_score,score_range:_range,grade:_grade,item_name:_name,...row})=>row),
    diagnostics:diagnostics.map(({diagnostic_name:_name,...row})=>row)}));
}
function profile(id:string,promptName:string,submissionSchema:AgentProfile['submissionSchema'],toolNames:string[],resolve:NonNullable<AgentProfile['resolve']>,validate?:AgentProfile['validate']):AgentProfile{
  const prompt=agentPrompt('score',toolNames,promptName);
  return {id,...prompt,requestSchema:{type:'object',required:['case_id','task_question','availability'],additionalProperties:true},submissionSchema,
    toolNames,renderPrompt:(input,policy,failure)=>{
      const axis=id.startsWith('axis-')?id.at(-1)!.toUpperCase():undefined;
      const select=(values:Record<string,string>)=>Object.fromEntries(Object.entries(values).filter(([key])=>!axis||key.startsWith(axis)));
      const directory={units:select(scoreDirectory.units),...(id==='evidence'?{}:{diagnostics:select(scoreDirectory.diagnostics)})};
      return prompt.renderPrompt({...input,score_directory:directory},policy,failure);
    },resolve,validate};
}
const evidenceProfile=profile('evidence','evidence',evidenceSchema,['score_material','score_calculate','score_external','read_artifact'],(request,draft,audit)=>{
  const proof=scoreAudit(request,audit),value=draft as Omit<ScoreEvidence,'changed_item_ids'>|Omit<ScoreException,'case_id'>;
  if('assessment_status' in value){const result={...value,case_id:material(request).case_id};validateScore(request,result,audit);return result;}
  const previous=(request.sources.score.value as unknown as ScoreContext).previous_evidence;
  for(const row of value.facts){quotes(request,audit,[row]);if(!row.affected_item_ids.length&&!value.full_rescore_reason||row.affected_item_ids.some(id=>!Object.hasOwn(scoreDirectory.units,id)))fail('/facts','新事实须定位实际相关核心项，不能隔离影响时明确full_rescore_reason。');}
  if(value.full_rescore_reason&&!value.facts.length)fail('/full_rescore_reason','没有新事实不能全量重评；缺口保留待核。');
  const known=new Map(Object.keys(scoreDirectory.units).map(id=>[id,new Set((previous?.facts??[]).filter(row=>row.affected_item_ids.includes(id)).flatMap(row=>row.evidence_ids))]));
  const changed=[...new Set(value.facts.flatMap(row=>row.affected_item_ids.filter(id=>row.evidence_ids.some(ref=>!known.get(id)!.has(ref)))))];
  if(value.full_rescore_reason&&!changed.length&&value.facts.every(row=>row.evidence_ids.every(id=>previous?.facts.some(old=>old.evidence_ids.includes(id)))))fail('/full_rescore_reason','没有新事实不能全量重评；重复旧引用不构成新事实。');
  if(proof.actions.length>6||new Set(proof.sources.flatMap(s=>typeof s.record.url==='string'?[s.record.url]:[])).size>3)fail('/facts','全题外部核验预算超限。');
  const facts=[...new Map([...(previous?.facts??[]),...value.facts].map(row=>[canonical([[...row.affected_item_ids].sort(),[...row.evidence_ids].sort()]),row])).values()];
  return {...value,facts,changed_item_ids:value.full_rescore_reason?Object.keys(scoreDirectory.units):changed};
});
const axisProfiles=Object.fromEntries(scoreAxes.map(axis=>[`axis-${axis.toLowerCase()}`,profile(`axis-${axis.toLowerCase()}`,`axis-${axis.toLowerCase()}`,axisSchema,['score_material','read_artifact'],(request,draft,audit)=>{
  const value=draft as ScoreAxisResult;
  const result:ScoreAxisResult={...value,case_id:material(request).case_id,evaluations:value.evaluations.map(row=>({...rating(row),item_name:scoreDirectory.units[row.item_id]})),
    diagnostics:value.diagnostics.map(row=>({...row,diagnostic_name:scoreDirectory.diagnostics[row.diagnostic_id]})),
    evidence:quotes(request,audit,[...value.evaluations,...value.diagnostics,...value.findings])};
  validateScoreAxis(request,result,audit,axis);
  for(const row of value.verification_requests)if(row.affected_item_ids.some(id=>!id.startsWith(axis)))fail('/verification_requests','只提请本轴的关键缺口。');
  return result;
},(request,value,audit)=>validateScoreAxis(request,value as ScoreAxisResult,audit,axis))]));
evidenceProfile.resultSchema=evidenceResultSchema;
for(const axis of scoreAxes){const p=axisProfiles['axis-'+axis.toLowerCase()];p.resultSchema=axisResultSchema;
  p.modelSubmissionSchema=()=>{const schema=structuredClone(axisSchema);const units=[axis+'1',axis+'2'],diagnostics=Object.keys(scoreDirectory.diagnostics).filter(id=>id.startsWith(axis));
    schema.$defs.evaluation.properties.item_id.enum=units;schema.$defs.diagnostic.properties.diagnostic_id.enum=diagnostics;
    schema.$defs.finding.properties.affected_item_ids.items.enum=units;schema.$defs.finding.properties.diagnostic_ids.items.enum=diagnostics;
    schema.$defs.finding.properties.primary_diagnostic_id.enum=[...diagnostics,'unmapped'];return schema;};
}
export const scoreProfile=profile('default','default',finalSchema,['score_material','read_artifact'],(request,draft,audit)=>{
  const context=request.sources.score.value as unknown as ScoreContext,value=draft as ScoreRepair|{final_answer_score:ScoreResult['final_answer_score'];finding_groups:string[][];explicit_probability:number|null;probability_evidence_ids:string[]};
  if('action' in value){
    if(!value.axis_ids.length&&!value.verification_requests.length)fail('/axis_ids','修正请求必须定位具体轴或证据缺口。');
    if(context.evidence_used&&value.verification_requests.length)fail('/verification_requests','统一补查已用完，verification_requests必须为空；剩余缺证保留待核，既有判词矛盾用axis_ids定向重评。');
    return value;
  }
  const parts=context.axes!;
  if(parts.some(p=>p.verification_requests.length)&&!context.evidence_used)fail('/verification_requests','须先统一补查分项已提出的关键证据缺口。');
  const all=parts.flatMap(p=>p.findings),byId=new Map(all.map(f=>[f.finding_id,f])),seen=new Set<string>(),aliases=new Map<string,string>();
  const findings:ScoreFinding[]=value.finding_groups.map((group,index)=>{
    const rows=group.map(id=>{if(seen.has(id))fail('/finding_groups','问题必须且只能归入一组。');seen.add(id);return byId.get(id)??fail('/finding_groups','问题分组引用不存在的记录。');});
    const first=rows[0];if(!first)fail('/finding_groups','问题分组不能为空。');
    if(rows.some(f=>f.component!==first.component||f.attribution!==first.attribution||((f.primary_diagnostic_id==='unmapped')!==(first.primary_diagnostic_id==='unmapped'))))fail('/finding_groups','归属或确定性不一致的问题不能强行合并。');
    const finding_id=`f${index+1}`;group.forEach(id=>aliases.set(id,finding_id));
    const union=(key:'affected_item_ids'|'diagnostic_ids'|'evidence_ids')=>[...new Set(rows.flatMap(row=>row[key]))];
    return {...first,finding_id,affected_item_ids:union('affected_item_ids'),diagnostic_ids:union('diagnostic_ids'),evidence_ids:union('evidence_ids')};
  });
  if(seen.size!==all.length)fail('/finding_groups','所有分项问题都须保留；相同问题合并，不能丢弃。');
  const proof=scoreAudit(request,audit),evidence=new Map(proof.quotes.map(q=>[q.evidence_id,q]));
  const result:ScoreResult={case_id:material(request).case_id,final_answer_score:{...rating(value.final_answer_score,true),finding_ids:[...new Set(value.final_answer_score.finding_ids.map(id=>aliases.get(id)??fail('/final_answer_score/finding_ids','总分只能关联已提交问题。')))]},
    evaluations:parts.flatMap(p=>p.evaluations),diagnostics:parts.flatMap(p=>p.diagnostics),findings,evidence:[...evidence.values()],explicit_probability:value.explicit_probability,probability_evidence_ids:value.probability_evidence_ids};
  const used=new Set([...result.evaluations,...result.diagnostics,...result.findings,result.final_answer_score,{evidence_ids:result.probability_evidence_ids}].flatMap(r=>r.evidence_ids));
  result.evidence=result.evidence.filter(q=>used.has(q.evidence_id));validateScore(request,result,audit);return result;
},(request,value,audit)=>{if(!('action' in (value as object)))validateScore(request,value,audit);});
scoreProfile.modelSubmissionSchema=request=>{
  const schema=structuredClone(finalSchema),context=request.sources.score.value as unknown as ScoreContext;
  if(context.evidence_used){const repair=schema.oneOf[1].properties;Object.assign(repair.verification_requests!,{maxItems:0});Object.assign(repair.axis_ids!,{minItems:1});}
  return schema;
};
scoreProfile.resultSchema={...resultSchema,oneOf:[...resultSchema.oneOf,finalSchema.oneOf[1]]} as AgentProfile['resultSchema'];
export const scoreAgent:AgentDefinition={id:'score',profiles:{default:scoreProfile,evidence:evidenceProfile,...axisProfiles}};
