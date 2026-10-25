import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type ReviewCase, type ValidationIssue } from "@eval/contracts";
import { reviewSources } from "@eval/tools";
import { scoreDirectory } from "@eval/prompts";
import schema from "../../../../schemas/score/result.schema.json" with {type:"json"};
import type { ScoreResult, ScoreException, Judgment, Rating, Applicability, ScoreAxisResult, ScoreAxis } from "./types.js";
const validateShape = new Ajv2020({allErrors:true,strict:false}).compile(schema);
const directory = scoreDirectory as {units:Record<string,string>;diagnostics:Record<string,string>;parents:Record<string,string>;core_grades:Record<string,string>;final_grades:Record<string,string>;always_units:string[];always_diagnostics:string[]};
const known = new Set(["task_requirement","observed_behavior","both"]);
export function validateScore(request: AgentRequest, result: unknown, audit: ToolAudit) {
  if (!validateShape(result)) throw new ValidationError(schemaIssues(validateShape.errors,result));
  validateScoreBody(request,result as ScoreResult|ScoreException,audit);
}
export function validateScoreAxis(request:AgentRequest,result:ScoreAxisResult,audit:ToolAudit,axis:ScoreAxis){
  validateScoreBody(request,result,audit,[axis+'1',axis+'2']);
}
export function validateScoreJudgments(request:AgentRequest,result:ScoreAxisResult,audit:ToolAudit,axes:ScoreAxis[]){
  validateScoreBody(request,result,audit,axes.flatMap(axis=>[axis+'1',axis+'2']));
}
function validateScoreBody(request:AgentRequest,value:ScoreResult|ScoreException|ScoreAxisResult,audit:ToolAudit,expectedUnits=Object.keys(directory.units)){
  const material=request.sources.case.value as unknown as ReviewCase, issues:ValidationIssue[]=[];
  const bad=(path:string,message:string)=>issues.push({category:"decision",code:"score_contract",path,message});
  if(value.case_id!==material.case_id)bad('/case_id','必须使用执行器提供的本题ID。');
  const sources=reviewSources(material,audit.review),answer=sources[material.candidate_output_id];
  const question=Boolean(material.task_question?.trim()||sources.Q?.trim());
  if('assessment_status' in value){
    if(value.assessment_status==='host_empty_response' && (material.availability.candidate_output!=='available'||answer===undefined||answer.trim()||value.missing_material.length))bad('/assessment_status','只有完整捕获的真实空答才用host_empty_response。');
    if(value.assessment_status==='needs_material' && (question&&answer!==undefined&&!['not_collected','unavailable'].includes(material.availability.candidate_output)||!value.missing_material.length))bad('/assessment_status','缺少完整题面或候选回答才用needs_material，并列出真实缺项。');
    if(value.assessment_status==='blocked_by_rule_conflict'&&!value.affected_units.length)bad('/affected_units','阻断规则冲突须定位受影响单元。');
    if(issues.length)throw new ValidationError(issues);return;
  }
  if(!question||!answer?.trim()||['not_collected','unavailable'].includes(material.availability.candidate_output))bad('/','正常评分需要完整题面和已捕获非空回答；否则使用原异常结构。');
  const shared=new Map(value.evidence.map(row=>[row.evidence_id,row])),spans=new Set<string>();
  if(shared.size!==value.evidence.length)bad('/evidence','共享证据ID不可重复。');
  for(const [i,row] of value.evidence.entries()){
    const chars=Array.from(sources[row.source_id]??''),key=canonical([row.source_id,row.start,row.end]);
    if(!Object.hasOwn(sources,row.source_id)||row.start<0||row.end<=row.start||row.end>chars.length||chars.slice(row.start,row.end).join('')!==row.quote)bad(`/evidence/${i}`,'引用须精确对应本题原文的Unicode码点区间。');
    if(spans.has(key))bad(`/evidence/${i}`,'同一片段只保存一次，复用共享编号。');spans.add(key);
  }
  const refs=(ids:string[],path:string)=>{for(const id of ids)if(!shared.has(id))bad(path,'引用了不存在的共享证据。');};
  const basis=(row:Judgment,path:string)=>{
    refs(row.evidence_ids,path+'/evidence_ids');
    if(!row.reason.trim())bad(path+'/reason','理由须说明本题实际依据或缺口。');
    if(!row.evidence_ids.length&&(row.status==='met'||row.status==='violated'||!row.host_basis?.length))bad(path,'确定判断需要原文证据；无证据的待核或不适用需要真实host_basis。');
    for(const host of row.host_basis??[]){
      const allowed=row.status==='not_applicable'?['no_public_or_observed_trigger']:row.status==='unverified'?['unknown_trigger','missing_observation']:[];
      if(!allowed.includes(host.rule_id)||!(host.pointer.startsWith('/availability/')||host.pointer==='/public_requirements'||host.pointer.startsWith('/public_requirements/')))bad(path+'/host_basis','元信息只能支持待核或不适用；pointer须以/开头，如/public_requirements或/availability/analysis。');
      try{let actual:any=material;for(const key of host.pointer.split('/').slice(1))actual=actual[key.replaceAll('~1','/').replaceAll('~0','~')];if(canonical(actual)!==canonical(host.value))throw Error();
        if(host.rule_id==='missing_observation'&&(!host.pointer.startsWith('/availability/')||!['partial','not_collected','unavailable'].includes(actual)))throw Error();
      }catch{bad(path+'/host_basis','元信息值必须与本题实际记录一致。');}
    }
  };
  const rating=(row:Rating,path:string,final=false)=>{
    basis(row,path);const limit=final?10:4;
    if(row.status==='not_applicable'){if(final||row.score!==null||row.score_range!==null||row.grade!=='不适用')bad(path,'不适用分数和区间为空，总分不能不适用。');return;}
    if((row.score===null)===(row.score_range===null))bad(path,'单点与区间必须且只能选一种。');
    if(row.score_range){const[a,b]=row.score_range;if(a>=b||a<0||b>limit||row.grade!=='待核'||row.status==='met'||row.status==='violated'&&b===limit)bad(path,'区间需有宽度；已确认违反的上界不能包含满分。');}
    else if(!Number.isInteger(row.score)||row.score!<0||row.score!>limit||row.status==='unverified'||row.status==='met'&&row.score!==limit||row.status==='violated'&&row.score===limit||row.grade!==(final?directory.final_grades:directory.core_grades)[String(row.score)])bad(path,'状态、整数分数和档位须符合原skill契约；程序不代选分数。');
  };
  const app=(row:Judgment&{applicability:Applicability},path:string,always:boolean)=>{
    if((row.status==='met'||row.status==='violated'||always)&&!known.has(row.applicability)||row.status==='not_applicable'&&row.applicability!=='not_triggered'||row.status==='unverified'&&row.applicability==='not_triggered'||row.applicability==='undetermined'&&row.status!=='unverified')issues.push({
      category:'decision',code:'score_contract',path:path+'/applicability',
      message:always?'本项始终是验收义务，适用依据选 task_requirement、observed_behavior 或 both；缺证仍可保留 unverified 与区间，不必改判满足或违反。':'适用依据须与状态对应：满足或违反用已触发依据，未触发用 not_applicable，触发未明用 unverified。',
      actual:{status:row.status,applicability:row.applicability},
      expected:{applicability:always||['met','violated'].includes(row.status)?[...known]:row.status==='not_applicable'?['not_triggered']:[...known,'undetermined'],
        ...(always?{status:['met','violated','unverified']}:{} )},
    });
  };
  const items=new Map(value.evaluations.map(row=>[row.item_id,row])),diagnostics=new Map(value.diagnostics.map(d=>[d.diagnostic_id,d]));
  if(items.size!==expectedUnits.length||value.evaluations.length!==expectedUnits.length||expectedUnits.some(id=>!items.has(id)))bad('/evaluations','本阶段固定核心单元必须各出现一次。');
  const expectedDiagnostics=Object.keys(directory.parents).filter(id=>expectedUnits.includes(directory.parents[id]));
  if(diagnostics.size!==expectedDiagnostics.length||value.diagnostics.length!==expectedDiagnostics.length||expectedDiagnostics.some(id=>!diagnostics.has(id)))bad('/diagnostics','本阶段固定诊断必须各出现一次。');
  for(const [i,row] of value.evaluations.entries()){
    const path=`/evaluations/${i}`;rating(row,path);app(row,path,directory.always_units.includes(row.item_id));
    if(row.item_name!==directory.units[row.item_id])bad(path+'/item_name','固定单元名称不匹配。');
    const expected=Object.keys(directory.parents).filter(id=>directory.parents[id]===row.item_id);
    for(const d of value.diagnostics.filter(d=>expected.includes(d.diagnostic_id))){basis(d,path+'/'+d.diagnostic_id);app(d,path+'/'+d.diagnostic_id,directory.always_diagnostics.includes(d.diagnostic_id));
      if(d.diagnostic_name!==directory.diagnostics[d.diagnostic_id])bad(path,'固定诊断名称不匹配。');
      if(known.has(d.applicability)&&!known.has(row.applicability)||row.status==='not_applicable'&&d.status!=='not_applicable'||d.status==='violated'&&row.status!=='violated'||row.status==='met'&&!['met','not_applicable'].includes(d.status))bad(path,'父子项状态不一致，不能以一个正确细项抹去其他缺陷或待核。');
    }
  }
  const findings=new Map(value.findings.map(row=>[row.finding_id,row])),descriptions=new Set<string>(),confirmedItems=new Set<string>(),confirmedDiagnostics=new Set<string>(),unmapped=new Set<string>();
  if(findings.size!==value.findings.length)bad('/findings','问题编号不能重复。');
  for(const [i,f] of value.findings.entries()){
    const path=`/findings/${i}`,publicRule=f.component==='public_rule',confirmed=f.attribution==='established'&&!publicRule;
    refs(f.evidence_ids,path+'/evidence_ids');if(!f.evidence_ids.length)bad(path,'问题记录需要真实证据。');
    const description=f.description.trim().toLowerCase();if(!description||descriptions.has(description))bad(path,'同一问题只记录一次。');descriptions.add(description);
    if(!publicRule&&!f.affected_item_ids.length)bad(path,'候选问题需要实际受影响单元。');
    for(const id of f.affected_item_ids){if(!items.has(id)||!publicRule&&!['violated','unverified'].includes(items.get(id)!.status))bad(path,'问题不能关联满足或不适用单元。');if(confirmed)confirmedItems.add(id);}
    if(f.primary_diagnostic_id==='unmapped'){if(!f.unmapped_reason?.trim()||f.diagnostic_ids.length)bad(path,'无法映射需明确原因，不填伪造诊断。');if(confirmed)f.affected_item_ids.forEach(id=>unmapped.add(id));}
    else{if(!f.diagnostic_ids.includes(f.primary_diagnostic_id)||f.unmapped_reason!=null)bad(path,'主诊断应在关联目录中。');
      for(const id of f.diagnostic_ids){if(!f.affected_item_ids.includes(directory.parents[id])||!diagnostics.has(id)||!publicRule&&!['violated','unverified'].includes(diagnostics.get(id)!.status))bad(path,'问题与诊断及其父单元必须对应。');if(confirmed)confirmedDiagnostics.add(id);}}
  }
  for(const row of value.evaluations){if(row.status==='violated'&&(!confirmedItems.has(row.item_id)||!unmapped.has(row.item_id)&&!value.diagnostics.some(d=>directory.parents[d.diagnostic_id]===row.item_id&&d.status==='violated')))bad('/evaluations','违反单元需要已确认的非题目问题和受影响诊断。');for(const d of value.diagnostics.filter(d=>directory.parents[d.diagnostic_id]===row.item_id))if(d.status==='violated'&&!confirmedDiagnostics.has(d.diagnostic_id)&&!unmapped.has(row.item_id))bad('/evaluations','违反诊断缺少已确认问题。');}
  if(!('final_answer_score' in value)){if(issues.length)throw new ValidationError(issues);return;}
  const final=value.final_answer_score;rating(final,'/final_answer_score',true);
  if(final.finding_ids.some(id=>!findings.has(id)))bad('/final_answer_score/finding_ids','总分引用不存在的问题。');
  const defects=final.finding_ids.flatMap(id=>{const f=findings.get(id);return f&&f.attribution==='established'&&f.component!=='public_rule'?[f]:[];});
  if(final.status==='met'&&final.finding_ids.length||final.status==='violated'&&!defects.length||final.status==='unverified'&&defects.length)bad('/final_answer_score','总分须保留实际交付缺陷；已恢复的过程问题不自动关联总分。');
  refs(value.probability_evidence_ids,'/probability_evidence_ids');
  if(value.explicit_probability===null?value.probability_evidence_ids.length:!value.probability_evidence_ids.length||value.probability_evidence_ids.some(id=>shared.get(id)?.source_id!==material.candidate_output_id))bad('/explicit_probability','概率只引用候选最终回答的明确单点概率；不存在时为null。');
  if(issues.length)throw new ValidationError(issues);
}
