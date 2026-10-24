import path from "node:path";
import {Ajv2020} from 'ajv/dist/2020.js';
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {canonical,HttpError,type AgentBinding,type PlannedTask,type RunState,type RunManifest,type WorkflowDefinition,type JsonObject,type SubmissionReceipt,type TaskPlan,type RunReference} from "@eval/contracts";
import {createRunRepository,readJson,writeJson,atomicWrite,runLock,exists,type RunCodec} from "@eval/data";
import { analysisTraceMap, attributionTrace, validateOriginalAttributionEvidence, bindAttributionMaterial, bindInstructionReview, instructionReviewRow, pendingTaskProgress } from "@eval/workflows/review";
import { collectInputs, contentText, locateRecordStream, loadRunInputs, normalizeInput, type Candidate, type RawInput, type EvaluationConfig } from "@eval/workflows/inputs";
import {attributionProfile,type AttributionResult} from "@eval/agents/attribution";
import attributionOutputSchema from '../../../../schemas/workflow/answer-review-attribution.schema.json' with {type:'json'};
import rewrittenSchema from '../../../../schemas/workflow/rewritten.schema.json' with {type:'json'};
import type {ScoreResult} from "@eval/agents/score";
import {answerReviewMaterial} from "./material.js";
import {scoreEvidenceTask,bindScore,advanceScore,scoreBlockedReason,isFormalScore,scoreExportState,type ReviewTaskData} from './score.js';
export {answerReviewMaterial} from "./material.js";
export * from './incremental.js';
export * from './watch.js';
export interface AnswerReviewConfig extends EvaluationConfig {workflow:'answer-review';rewrite:{attribution:boolean};reviewStages?:('score'|'attribution')[];reviewTaskIds?:string[]}
type TaskData=ReviewTaskData;
const sourceMeta=Symbol('source meta: export only');
const sourceTrace=Symbol('original trace: workflow only');
function loadReviewInputs(manifest:RunManifest,records?:Map<string,Candidate>){return loadRunInputs(manifest,undefined,undefined,records,source=>{
  const record=source as Record<string,unknown>;
  return {raw:normalizeInput(source),origin:record._source,metadata:Object.hasOwn(record,'meta')?{meta:record.meta}:{}};
});}
export function attributionTextSlots(value:AttributionResult){return [{id:'summary',text:value.summary,label:'归因总结'},...value.findings.flatMap((f,i)=>[
  {id:`findings.${i}.text`,text:f.text,label:'实际表现'}, {id:`findings.${i}.reason`,text:f.reason,label:'证据与影响'},
  ...(f.problem?[{id:`findings.${i}.problem.label`,text:f.problem.label,label:'问题名称'},{id:`findings.${i}.problem.definition`,text:f.problem.definition,label:'问题定义'}]:[]),
])];}
export async function planAnswerReview(config:AnswerReviewConfig){
  const indexed=await collectInputs(config,undefined,{materializeInputs:false});
  const catalog=indexed.catalog,stages=config.reviewStages??['score','attribution'],tasks:PlannedTask[]=[];
  for(const candidate of catalog)for(const stage of stages){const task:PlannedTask=stage==='score'?scoreEvidenceTask(candidate):{id:randomUUID(),stage,inputIds:{answer:candidate.input_id},dependencies:{},data:{candidate} satisfies TaskData};tasks.push(task);
    if(stage==='attribution'&&config.rewrite.attribution)tasks.push({id:randomUUID(),stage:'rewrite',inputIds:{},dependencies:{source:task.id},data:{candidate,rewriteOf:task.id} satisfies TaskData});}
  const manifest={config,tasks,inputCatalog:catalog} as RunManifest,inputs=prepareInputs(await loadReviewInputs(manifest),catalog);
  const summary={workflow:'answer-review',cases:catalog.length,valid_inputs:catalog.length,score_tasks:tasks.filter(t=>t.stage==='score').length,attribution_tasks:tasks.filter(t=>t.stage==='attribution').length,rewrite_tasks:tasks.filter(t=>t.stage==='rewrite').length,criteria_tasks:0,comparison_tasks:0,issues:indexed.issues};
  return {tasks,inputs,catalog,summary};
}
/** Limit a pilot by business case while retaining every model and selected stage for that case. */
export function answerReviewPilotTaskIds(plan:TaskPlan,count:number){
  if(!Number.isSafeInteger(count)||count<1)throw Error('pilot-cases must be positive');
  const cases=new Set([...new Set((plan.catalog as Candidate[]).map(c=>canonical([c.batch_id,c.case_id])))].sort().slice(0,count));
  return plan.tasks.filter(task=>{const c=(task.data as TaskData).candidate;return cases.has(canonical([c.batch_id,c.case_id]));}).map(task=>task.id);
}
function prepareInputs(raw:Record<string,unknown>,catalog:Candidate[]){
  const result:Record<string,unknown>={};
  for(const candidate of catalog)if(Object.hasOwn(raw,candidate.input_id))Object.defineProperty(result,candidate.input_id,{enumerable:true,get(){
    const source=raw[candidate.input_id] as {raw:RawInput;origin?:Record<string,unknown>;metadata:Record<string,unknown>};
    const value=attributionTrace(source.raw,candidate.input_id,candidate.final_index);
    const original=typeof source.origin?.original_file==='string'?source.origin.original_file:undefined,slash=original?.indexOf('/')??-1;
    const metadata={...source.metadata,trace_id:candidate.trace_id,answer_model:candidate.llm,input_file:candidate.source,input_line:candidate.line,
      source_archive:slash>=0?original!.slice(0,slash):null,source_member:slash>=0?original!.slice(slash+1):null,
      source_line:source.origin?.original_line??null,source_item:source.origin?.original_item??null,
      business_date:source.origin?.business_date??(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(candidate.batch_id)?candidate.batch_id:null)};
    return Object.defineProperties(value,{[sourceMeta]:{value:metadata},[sourceTrace]:{value:source.raw}});
  }});
  return result;
}
export function bindAnswerReview(task:PlannedTask,inputs:Record<string,unknown>,dependencies:Record<string,SubmissionReceipt|undefined>):AgentBinding{
  const data=task.data as TaskData;
  if(task.stage==='instruction-review')return bindInstructionReview(data.candidate,(inputs[data.candidate.input_id] as {[sourceTrace]:RawInput})[sourceTrace]);
  if(task.stage==='rewrite')return {agent:'rewrite',profile:'default',request:{input:{kind:'attribution',case:{batch_id:data.candidate.batch_id,case_id:data.candidate.case_id},items:attributionTextSlots(dependencies.source!.evaluation as AttributionResult)},sources:{}}};
  if(task.stage==='attribution')return bindAttributionMaterial(data.candidate,
    (inputs[data.candidate.input_id] as {[sourceTrace]:RawInput})[sourceTrace]);
  const original=(inputs[data.candidate.input_id] as {[sourceTrace]:RawInput})[sourceTrace];
  const source=answerReviewMaterial(data.candidate,original,data.candidate.input_id);
  return bindScore(task,{...source.material,view:source.shown},dependencies);
}
export const answerReviewWorkflow:WorkflowDefinition={
  id:'answer-review',plan:config=>planAnswerReview(config as AnswerReviewConfig),bind:bindAnswerReview,blockedReason:scoreBlockedReason,
  advance:(task,receipt,state,inputs)=>{
    if(task.stage==='score')return advanceScore(task,receipt,state,inputs);
    if(task.stage==='attribution'){
      const candidate=(task.data as TaskData).candidate,original=(inputs[candidate.input_id] as {[sourceTrace]:RawInput})[sourceTrace];
      validateOriginalAttributionEvidence(receipt.evaluation,{[candidate.input_id]:original},receipt.audit);
    }
    if(task.stage!=='attribution'||state.manifest.tasks.some(item=>item.stage==='instruction-review'&&item.dependencies.source===task.id))return {tasks:[]};
    const inputId=task.inputIds.answer;
    if(!inputId)throw Error('归因后置检查缺少本方原始输入身份。');
    const candidate=(task.data as TaskData).candidate;
    return {tasks:[{id:randomUUID(),stage:'instruction-review',inputIds:{case:inputId},dependencies:{source:task.id},data:{candidate}}]};
  },
  async reconcile(_run,state,current){
    const manifest=state.manifest,saved=manifest.config as AnswerReviewConfig,config=current as AnswerReviewConfig;
    const stages=config.reviewStages??['score','attribution'];
    manifest.config={...saved,execution:config.execution,rewrite:config.rewrite,reviewStages:stages};
    const records=new Map<string,Candidate>(),raw=await loadReviewInputs(manifest,records);
    const catalog=(manifest.inputCatalog as Candidate[]).map(candidate=>({...records.get(candidate.input_id)!,input_id:candidate.input_id}));
    const byId=new Map(catalog.map(candidate=>[candidate.input_id,candidate]));
    for(const task of manifest.tasks){
      const data=task.data as TaskData,previous=data.candidate,candidate=byId.get(previous.input_id)!;
      if(!state.receipts[task.id]&&task.stage!=='rewrite'&&!isDeepStrictEqual(
        [previous.question,previous.final_index,previous.reference,previous.trace_id],
        [candidate.question,candidate.final_index,candidate.reference,candidate.trace_id]))
        manifest.states[task.id]=pendingTaskProgress(manifest.states[task.id],true);
      data.candidate=candidate;
    }
    manifest.inputCatalog=catalog;
    const priorScope=manifest.executionScope&&new Set(manifest.executionScope);
    const priorInputs=priorScope&&new Set(manifest.tasks.filter(task=>priorScope.has(task.id)).map(task=>(task.data as TaskData).candidate.input_id));
    const explicit=config.inputs.records&&new Map(config.inputs.records.map(row=>[canonical([row.model,row.batch_id,row.case_id]),row]));
    let selected=catalog.filter(candidate=>{
      const key=canonical([candidate.version,candidate.batch_id,candidate.case_id]);
      if(explicit){
        const row=explicit.get(key);if(!row)return false;
        if(row.trace_id!==undefined&&row.trace_id!==candidate.trace_id)throw Error('清洗范围与实际trace_id不一致');
      }else if(priorInputs&&!priorInputs.has(candidate.input_id))return false;
      return (!config.inputs.batches?.length||config.inputs.batches.includes(candidate.batch_id))&&
        (!config.inputs.case_ids?.length||config.inputs.case_ids.includes(candidate.case_id));
    });
    if(!explicit&&config.inputs.limit){
      const cases=new Set([...new Set(selected.map(c=>canonical([c.batch_id,c.case_id])))].sort().slice(0,config.inputs.limit));
      selected=selected.filter(c=>cases.has(canonical([c.batch_id,c.case_id])));
    }
    const tasks=new Map(manifest.tasks.filter(task=>task.stage!=='rewrite').map(task=>[canonical([task.stage,(task.data as TaskData).candidate.input_id]),task]));
    const rewrites=new Set(manifest.tasks.filter(task=>task.stage==='rewrite').map(task=>(task.data as TaskData).rewriteOf));
    const add=(task:PlannedTask)=>{manifest.tasks.push(task);manifest.states[task.id]={status:'pending',attempts:0};};
    for(const candidate of selected)for(const stage of stages){
      const key=canonical([stage,candidate.input_id]);let task=tasks.get(key);
      if(!task){task=stage==='score'?scoreEvidenceTask(candidate):{id:randomUUID(),stage,inputIds:{answer:candidate.input_id},dependencies:{},data:{candidate} satisfies TaskData};add(task);tasks.set(key,task);}
      if(stage==='attribution'&&config.rewrite.attribution&&!rewrites.has(task.id)){
        add({id:randomUUID(),stage:'rewrite',inputIds:{},dependencies:{source:task.id},data:{candidate,rewriteOf:task.id} satisfies TaskData});
        rewrites.add(task.id);
      }
    }
    const selectedIds=new Set(selected.map(candidate=>candidate.input_id));
    const exact=config.reviewTaskIds&&new Set(config.reviewTaskIds);
    if(exact&&[...exact].some(id=>!manifest.tasks.some(task=>task.id===id)))throw Error('恢复范围包含未知任务');
    manifest.executionScope=manifest.tasks.filter(task=>selectedIds.has((task.data as TaskData).candidate.input_id)&&
      (!exact||exact.has(task.id))&&(stages.includes(task.stage as 'score'|'attribution')||task.stage==='instruction-review'&&stages.includes('attribution')||task.stage==='rewrite'&&stages.includes('attribution')&&config.rewrite.attribution)).map(task=>task.id);
    manifest.preflight={...manifest.preflight,...Object.fromEntries(['score','attribution','instruction-review','rewrite'].map(stage=>[stage+'_tasks',manifest.tasks.filter(task=>task.stage===stage).length]))};
    return {tasks:manifest.tasks,inputs:prepareInputs(raw,catalog),catalog,summary:manifest.preflight};
  },
};
const resultFile=(stage:string)=>stage==='score'?'score.jsonl':stage==='instruction-review'?'instruction_review.jsonl':'attribution.jsonl';
const validateAttributionOutput=new Ajv2020({allErrors:true,strict:false})
  .addSchema(attributionProfile.resultSchema!,'/attribution/result.schema.json')
  .addSchema(rewrittenSchema,'/workflow/rewritten.schema.json')
  .addSchema(attributionOutputSchema,'/workflow/answer-review-attribution.schema.json')
  .getSchema('/workflow/answer-review-attribution.schema.json')!;
function attributionEvaluation(row:JsonObject){
  const properties=(attributionProfile.resultSchema as {properties:Record<string,unknown>}).properties;
  return Object.fromEntries(Object.keys(properties).filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
}
const resultEncoder=(task:PlannedTask,state:RunState,inputs:Record<string,unknown>)=>{
  const receipt=state.receipts[task.id],data=task.data as TaskData;
  const metadata=(inputs[data.candidate.input_id] as {[sourceMeta]:Record<string,unknown>}|undefined)?.[sourceMeta];
  if(!metadata)throw Error('缺少源输入，不能静默遗漏meta：'+data.candidate.input_id);
  if(task.stage==='instruction-review')return receipt.exported?{...receipt.exported,row:{...receipt.exported.row,...metadata}}:{id:task.id,file:'instruction_review.jsonl',row:{...instructionReviewRow(task,receipt,data.candidate),...metadata}};
  const missingMeta=(row:JsonObject)=>!Object.hasOwn(row,'meta')&&Object.hasOwn(metadata,'meta')?{meta:metadata.meta}:{};
  if(task.stage==='rewrite'){
    const source=state.receipts[data.rewriteOf!]!,row=source.exported!.row;
    const updated={...row,...missingMeta(row),rewritten:{evaluator_version:receipt.evaluatorVersion,...receipt.evaluation as object}} as JsonObject;
    if(!validateAttributionOutput(updated))throw Error('归因改写导出契约无效：'+JSON.stringify(validateAttributionOutput.errors));
    return {id:data.rewriteOf!,file:'attribution.jsonl',auxiliary:true,row:updated};
  }
  if(receipt.exported){const row={...receipt.exported.row,...missingMeta(receipt.exported.row)};
    if(task.stage==='attribution'&&!validateAttributionOutput(row))throw Error('归因续跑导出契约无效：'+JSON.stringify(validateAttributionOutput.errors));
    return {...receipt.exported,row};}
  const candidate=data.candidate;
  const row={evaluation_type:task.stage,evaluator_version:receipt.evaluatorVersion,task_id:task.id,submission_id:receipt.submissionId,
    input_id:candidate.input_id,batch_id:candidate.batch_id,case_id:candidate.case_id,version:candidate.version,...metadata,
    ...(task.stage==='attribution'?receipt.evaluation as object:{evaluation:receipt.evaluation}),
    ...(receipt.audit.review?{verification:receipt.audit.review}:{}),judge:receipt.judge} as JsonObject;
  if(task.stage==='attribution'&&!validateAttributionOutput(row))throw Error('归因导出契约无效：'+JSON.stringify(validateAttributionOutput.errors));
  return {id:task.id,file:resultFile(task.stage),row};
};
interface Checkpoint {workflow:'answer-review';manifest:Omit<RunManifest,'tasks'|'states'|'inputs'|'inputCatalog'>;inputs:Record<string,Candidate>;tasks:Record<string,{task:Omit<PlannedTask,'id'|'data'>;data:Omit<TaskData,'candidate'>&{input_id:string};state:RunManifest['states'][string];receipt?:any}>;usage:RunState['usage'];recordedAttempts:number}
const codec:RunCodec<Checkpoint>={
  encode(state){const {tasks,states,inputs:_inputs,inputCatalog,...manifest}=state.manifest;
    const completedScores=new Map(tasks.filter(t=>isFormalScore(t,state.receipts[t.id])&&state.receipts[t.id].exported).map(t=>[(t.data as TaskData).candidate.input_id,t.id]));return {workflow:'answer-review',manifest,inputs:Object.fromEntries((inputCatalog as Candidate[]).map(c=>[c.input_id,c])),usage:state.usage,recordedAttempts:state.recordedAttempts,
    tasks:Object.fromEntries(tasks.map(task=>{const {id,data,...definition}=task,info=data as TaskData,receipt=state.receipts[id];let saved:any;
      if(receipt){const {evaluation,submitted:_submitted,exported,...rest}=receipt;const {review:_review,...audit}=rest.audit;
        const completed=task.stage==='score'&&!exported?completedScores.get(info.candidate.input_id):undefined;
        saved={...rest,audit:exported||completed?audit:rest.audit,...(exported?{exported:{id:exported.id,file:exported.file}}:{evaluation:completed?{completed_by:completed}:evaluation})};}
      return [id,{task:definition,data:{...Object.fromEntries(Object.entries(info).filter(([key])=>key!=='candidate')),input_id:info.candidate.input_id},state:states[id],...(saved?{receipt:saved}:{})}];}))};},
  references(checkpoint,ids){if(checkpoint.workflow!=='answer-review')throw Error('该run不属于独立Score/Attribution流程');return Object.entries(checkpoint.tasks).flatMap(([id,row])=>!ids||ids.has(id)?row.receipt?.exported?[row.receipt.exported]:[]:[]);},
  resultId:row=>String(row.task_id),
  decode(checkpoint,read,ids){if(checkpoint.workflow!=='answer-review')throw Error('该run不属于独立Score/Attribution流程');
    const tasks:PlannedTask[]=[],receipts:RunState['receipts']={},states:RunManifest['states']={};
    for(const[id,row]of Object.entries(checkpoint.tasks)){tasks.push({id,...row.task,data:{...Object.fromEntries(Object.entries(row.data).filter(([key])=>key!=='input_id')),candidate:checkpoint.inputs[row.data.input_id]}});states[id]=row.state;
      if(row.receipt&&(!ids||ids.has(id))){const saved=row.receipt,exported=saved.exported?{...saved.exported,row:read(saved.exported)}:undefined;
        receipts[id]={...saved,evaluation:saved.evaluation??(row.task.stage==='rewrite'?{rewrites:(exported?.row.rewritten as any)?.rewrites}:row.task.stage==='attribution'?attributionEvaluation(exported!.row):row.task.stage==='instruction-review'?exported?.row.instruction_review:exported?.row.evaluation),audit:{...saved.audit,...(exported?.row.verification?{review:exported.row.verification}:{})},...(exported?{exported}:{})};}}
    return {manifest:{...checkpoint.manifest,tasks,states,inputs:Object.fromEntries(Object.keys(checkpoint.inputs).map(id=>[id,{id,name:id}])),inputCatalog:Object.values(checkpoint.inputs)},receipts,usage:checkpoint.usage,recordedAttempts:checkpoint.recordedAttempts};
  },
};
const reviewRepository=createRunRepository(codec,resultEncoder);
export const answerReviewRepository={...reviewRepository,createResultWriter(run:string,inputs:Record<string,unknown>){
  const write=reviewRepository.createResultWriter(run,inputs);return (state:RunState)=>write(scoreExportState(state));
}};
/** Add newly published answers to the existing day; never replace accepted tasks or result identities. */
export async function appendAnswerReviewInputs(run:string,config:AnswerReviewConfig){
  const release=await runLock(run);
  try{
    const state=await answerReviewRepository.readRun(run),plan=await planAnswerReview(config);
    if((plan.summary.issues as unknown[]).length||plan.catalog.length!==config.inputs.records?.length)throw Error('日期追加范围校验失败');
    const key=(c:Candidate)=>canonical([c.version,c.batch_id,c.case_id]);
    const catalog=state.manifest.inputCatalog as Candidate[],known=new Map(catalog.map(c=>[key(c),c]));let added=0;
    const taskKeys=new Set(state.manifest.tasks.map(task=>canonical([task.stage,(task.data as TaskData).candidate.input_id])));
    for(const candidate of plan.catalog){const prior=known.get(key(candidate));
      if(prior&&prior.trace_id!==candidate.trace_id)throw Error('同一回答身份的trace_id发生变化');
      const selected=prior??candidate;
      if(!prior){catalog.push(candidate);known.set(key(candidate),candidate);added++;}
      for(const stage of config.reviewStages??['score','attribution']){
        const identity=canonical([stage,selected.input_id]);if(taskKeys.has(identity))continue;
        const task:PlannedTask=stage==='score'?scoreEvidenceTask(selected):{id:randomUUID(),stage,inputIds:{answer:selected.input_id},dependencies:{},data:{candidate:selected} satisfies TaskData};
        state.manifest.tasks.push(task);state.manifest.states[task.id]={status:'pending',attempts:0};taskKeys.add(identity);
      }
    }
    const saved=state.manifest.config as AnswerReviewConfig;
    const versions=new Map([...saved.inputs.versions,...config.inputs.versions].map(v=>[v.id,v]));
    state.manifest.config={...saved,execution:config.execution,rewrite:config.rewrite,reviewStages:config.reviewStages??['score','attribution'],inputs:{...saved.inputs,
      records:config.inputs.records,
      versions:[...versions.values()].map(v=>({...v,sources:[...new Set(catalog.filter(c=>c.version===v.id).map(c=>c.source))].map(file=>({kind:'file' as const,path:file}))}))}};
    state.manifest.preflight={...state.manifest.preflight,valid_inputs:catalog.length,cases:new Set(catalog.map(c=>canonical([c.batch_id,c.case_id]))).size,
      score_tasks:state.manifest.tasks.filter(t=>t.stage==='score').length,attribution_tasks:state.manifest.tasks.filter(t=>t.stage==='attribution').length};
    await answerReviewRepository.writeRun(run,state);return added;
  }finally{await release();}
}
/** An explicit retry reopens selected failures without replacing task identities or refunding their ledgers. */
export async function prepareAnswerReviewRetry(run:string,traceIds?:ReadonlySet<string>,stages:readonly string[]=['score','attribution','instruction-review'],taskIds?:ReadonlySet<string>){
  const release=await runLock(run);
  try{const state=await answerReviewRepository.readRun(run),retried:string[]=[],changedStages=new Set<string>();
    for(const task of state.manifest.tasks){const progress=state.manifest.states[task.id];
      if(!stages.includes(task.stage)||taskIds&&!taskIds.has(task.id)||traceIds&&!traceIds.has((task.data as TaskData).candidate.trace_id??'')||state.receipts[task.id]||!['failed','timed_out','cancelled','blocked','running'].includes(progress.status))continue;
      progress.status='pending';delete progress.nextRetryAt;retried.push(task.id);changedStages.add(task.stage);
    }
    // Reopen only dependent unfinished work; accepted upstream results and all ledgers stay intact.
    for(let changed=true;changed;){changed=false;
      for(const task of state.manifest.tasks){
        if(retried.includes(task.id)||state.receipts[task.id]||!Object.values(task.dependencies).some(id=>retried.includes(id)))continue;
        const progress=state.manifest.states[task.id];progress.status='pending';delete progress.nextRetryAt;
        retried.push(task.id);changedStages.add(task.stage);changed=true;
      }
    }
    state.manifest.executionScope=retried;
    state.manifest.pausedStages=(state.manifest.pausedStages??[]).filter(p=>!changedStages.has(p.stage));
    await answerReviewRepository.writeRun(run,state);return retried;
  }finally{await release();}
}
/** Continuous recovery retains task identities and spent budgets; terminal content failures stay reported. */
export async function prepareAnswerReviewAutomaticResume(run:string,traceIds:ReadonlySet<string>,stages:readonly string[]=['score','attribution','instruction-review']){
  const release=await runLock(run);
  try{
    const state=await answerReviewRepository.readRun(run),policy=(state.manifest.config as AnswerReviewConfig).execution;
    const eligible=state.manifest.tasks.filter(task=>{
      const c=(task.data as TaskData).candidate,p=state.manifest.states[task.id],failure=p.failure;
      if(!stages.includes(task.stage)||!traceIds.has(c.trace_id??'')||state.receipts[task.id]||failure?.stopped)return false;
      if((failure?.contentSubmissions??0)>=1+(policy.stageRepairAttempts?.[task.stage]??policy.repairAttempts)||
        policy.maxTaskAttempts!==undefined&&p.attempts>=policy.maxTaskAttempts)return false;
      return ['pending','running','cancelled','timed_out'].includes(p.status)||p.attempts===0||
        Boolean(failure?.errors.some(e=>['transport','interruption'].includes(e.category)||e.code==='attribution_language'));
    });
    if(eligible.length){
      state.manifest.executionScope=eligible.map(t=>t.id);
      state.manifest.pausedStages=(state.manifest.pausedStages??[]).filter(p=>!stages.includes(p.stage));
      await answerReviewRepository.writeRun(run,state);
    }
    return new Set(eligible.map(task=>task.id));
  }finally{await release();}
}
export async function reportAnswerReview(run:string,state?:RunState){
  state ??= await answerReviewRepository.readRun(run);
  const stages:Record<string,Record<string,number>>={};for(const task of state.manifest.tasks){const status=state.manifest.states[task.id]?.status??'pending';const row=stages[task.stage]??={};row[status]=(row[status]??0)+1;}
  const results=state.manifest.tasks.filter(t=>isFormalScore(t,state.receipts[t.id])).flatMap(t=>state.receipts[t.id]?[{task:t,receipt:state.receipts[t.id]}]:[]);
  const selected=new Set(state.manifest.executionScope??state.manifest.tasks.map(t=>t.id));
  const phases=state.manifest.tasks.filter(t=>t.stage==='score'&&selected.has(t.id));
  const submissions=phases.map(t=>({accepted:Boolean(state!.receipts[t.id]),count:state!.receipts[t.id]?.submissionStats?.contentSubmissions??state!.manifest.states[t.id].failure?.contentSubmissions??0}));
  const score_execution={planned_answers:new Set(phases.map(t=>(t.data as TaskData).candidate.input_id)).size,
    rejected_answers:new Set(phases.filter(t=>(t.data as TaskData).score_part==='rejected').map(t=>(t.data as TaskData).candidate.input_id)).size,
    phase_tasks:phases.length,phase_attempts:phases.reduce((n,t)=>n+state!.manifest.states[t.id].attempts,0),
    phase_tasks_with_submission:submissions.filter(s=>s.count>0).length,first_submission_acceptances:submissions.filter(s=>s.accepted&&s.count===1).length,
    content_submissions:submissions.reduce((n,s)=>n+s.count,0),accepted_normal:results.filter(r=>'final_answer_score' in (r.receipt.evaluation as object)).length,
    accepted_exceptions:results.filter(r=>'assessment_status' in (r.receipt.evaluation as object)).length,
    unverified_final:results.filter(r=>(r.receipt.evaluation as ScoreResult).final_answer_score?.status==='unverified').length};
  const summary={workflow:'answer-review',run_id:state.manifest.runId,status:state.manifest.status,active_stages:(state.manifest.config as AnswerReviewConfig).reviewStages??['score','attribution'],stages,tokens:state.usage,concurrency:state.manifest.concurrency,
    completed_instruction_reviews:state.manifest.tasks.filter(t=>t.stage==='instruction-review'&&state.receipts[t.id]).length,completed_scores:results.length,score_execution,completed_attributions:state.manifest.tasks.filter(t=>t.stage==='attribution'&&state.receipts[t.id]).length,
    execution_task_statuses:Object.fromEntries([...new Set(Object.values(state.manifest.states).map(s=>s.status))].map(status=>[status,Object.values(state.manifest.states).filter(s=>s.status===status).length])),paused_stages:state.manifest.pausedStages??[]};
  await writeJson(path.join(run,'stats.json'),summary);
  const lines=['# 独立回答评测','',`状态：${summary.status}`,''];
  if(summary.active_stages.includes('score')){
    lines.push('| 题目 | 模型 | 最终总分 / 区间 | 状态 |','|---|---|---|---|');
    for(const{task,receipt}of results){const c=(task.data as TaskData).candidate,value=receipt.evaluation as ScoreResult;lines.push(`| ${c.case_id} | ${c.version} | ${value.final_answer_score?.score??JSON.stringify(value.final_answer_score?.score_range??null)} | ${value.final_answer_score?.status??(value as any).assessment_status} |`);}
  }else{
    lines.push('| 题目 | 模型 | 问题数 | 中文归因 |','|---|---|---|---|');
    for(const task of state.manifest.tasks.filter(t=>t.stage==='attribution')){const receipt=state.receipts[task.id];if(!receipt)continue;const c=(task.data as TaskData).candidate,value=receipt.evaluation as AttributionResult;
      lines.push(`| ${c.case_id} | ${c.version} | ${value.findings.filter(f=>f.type==='problem').length} | ${value.summary.replaceAll('|','\\|').replaceAll('\n',' ')} |`);}
  }
  lines.push('');await atomicWrite(path.join(run,'report.md'),lines.join('\n'));return summary;
}
export function validateAnswerReview(state:RunState){
  for(const task of state.manifest.tasks){const r=state.receipts[task.id];if(!r)continue;if(r.taskId!==task.id)throw Error('任务收据身份不一致');if(task.stage==='score'&&!isFormalScore(task,r))continue;if(!r.exported||r.exported.id!==((task.data as TaskData).rewriteOf??task.id))throw Error('正式结果引用与任务不一致');
    const row=r.exported.row,value=task.stage==='attribution'?attributionEvaluation(row):task.stage==='instruction-review'?row.instruction_review:row.evaluation;
    if(task.stage==='attribution'&&!validateAttributionOutput(row))throw Error('归因导出元信息契约无效');
    if(task.stage!=='rewrite'&&canonical(value)!==canonical(r.evaluation))throw Error('正式结果正文与已接受收据不一致');}
  return {valid:true,receipts:Object.keys(state.receipts).length};
}


const stages=['score','attribution'] as const;
const reviewStages=[...stages,'instruction-review'] as const;
const candidate=(task:PlannedTask)=>(task.data as TaskData).candidate;
export const answerReviewTaskInput=(task:PlannedTask)=>candidate(task).input_id;
const failed=new Set(['failed','timed_out','blocked','cancelled']);
type SavedReviewTask={id:string;row:Checkpoint['tasks'][string]};
/** Accepted output references, not successful intermediate sessions, define business completion. */
function stageProgress(tasks:SavedReviewTask[],stage:string){
  const selected=tasks.filter(({row})=>row.task.stage===stage);
  const formal=selected.filter(({id,row})=>row.state.status==='succeeded'&&row.receipt?.taskId===id&&
    row.receipt?.exported?.id===id&&row.receipt.exported.file===resultFile(stage));
  if(formal.length>1)throw Error('同一回答存在重复正式结果：'+stage);
  const active=selected.filter(({row})=>row.state.status!=='succeeded');
  const current=formal[0]??active.find(({row})=>row.state.status==='running')??
    active.find(({row})=>failed.has(row.state.status)&&row.state.status!=='blocked')??
    active.find(({row})=>row.state.status==='blocked')??
    active.find(({row})=>Object.values(row.task.dependencies).every(id=>tasks.some(task=>task.id===id&&task.row.receipt)))??active[0]??selected.at(-1);
  const status=formal.length?'succeeded':current?.row.state.status==='succeeded'?(stage==='score'&&current.row.receipt?'pending':'failed'):current?.row.state.status??'pending';
  return {taskId:current?.id??null,status,attempts:selected.reduce((sum,task)=>sum+task.row.state.attempts,0),
    error:current?.row.state.reason??(status==='failed'&&current?.row.state.status==='succeeded'?'缺少正式结果引用':null)};
}
function samples(saved:Checkpoint){
  if(saved.workflow!=='answer-review')throw Error('该run不属于独立Score/Attribution流程');
  const grouped=new Map<string,SavedReviewTask[]>();
  for(const [id,row]of Object.entries(saved.tasks)){
    const group=grouped.get(row.data.input_id)??[];group.push({id,row});grouped.set(row.data.input_id,group);
  }
  return Object.entries(saved.inputs).map(([inputId,c])=>{
    const tasks=grouped.get(inputId)??[],views=Object.fromEntries(stages.map(stage=>[stage,stageProgress(tasks,stage)]));
    const statuses=stages.map(stage=>views[stage].status),status=statuses.every(value=>value==='succeeded')?'succeeded':
      statuses.some(value=>failed.has(value))?'failed':statuses.includes('succeeded')?'partial':statuses.includes('running')?'running':'pending';
    return {inputId,caseId:c.case_id,batchId:c.batch_id,question:c.question,model:c.version,traceId:c.trace_id,status,stages:views,
      instructionReview:stageProgress(tasks,'instruction-review')};
  });
}
function stageCounts(rows:ReturnType<typeof samples>,stage:typeof reviewStages[number]){
  const views=rows.map(row=>stage==='instruction-review'?row.instructionReview:row.stages[stage]).filter(view=>stage!=='instruction-review'||view.taskId);
  return {total:views.length,succeeded:views.filter(view=>view.status==='succeeded').length,
    failed:views.filter(view=>failed.has(view.status)).length,running:views.filter(view=>view.status==='running').length,pending:views.filter(view=>view.status==='pending').length};
}
export async function answerReviewProgress(run:string){return samples(await readJson<Checkpoint>(path.join(run,'state.json')));}
async function reviewRunSummary(run:string,saved:Checkpoint,date?:string){
  const state=codec.decode(saved,()=>{throw Error('概要不得读取结果正文');},new Set()),rows=samples(saved),counts=Object.fromEntries(stages.map(stage=>[stage,stageCounts(rows,stage)]));
  const models:Record<string,{answers:number;completed:number;failed:number;pending:number}>={};
  for(const row of rows){const model=models[row.model]??={answers:0,completed:0,failed:0,pending:0};model.answers++;
    if(stages.every(stage=>row.stages[stage].status==='succeeded'))model.completed++;
    else if(stages.some(stage=>failed.has(row.stages[stage].status)))model.failed++;
    else model.pending++;}
  const artifacts=[];
  for(const name of ['report.md','stats.json','results/score.jsonl','results/attribution.jsonl','results/instruction_review.jsonl'])if(await exists(path.join(run,name)))artifacts.push({name});
  if(date===undefined){
    const dates=new Set(Object.values(saved.inputs).map(input=>input.batch_id));
    if(dates.size===1&&/^\d{4}-\d{2}-\d{2}$/.test([...dates][0]))date=[...dates][0];
  }
  return {runId:state.manifest.runId,date:date??null,status:state.manifest.status,answers:rows.length,total:rows.length,
    questions:new Set(rows.map(row=>canonical([row.batchId,row.caseId]))).size,
    taskTotal:Object.values(counts).reduce((n,stage)=>n+stage.total,0),taskCompleted:Object.values(counts).reduce((n,stage)=>n+stage.succeeded,0),models,
    succeeded:rows.filter(row=>stages.every(stage=>row.stages[stage].status==='succeeded')).length,
    partial:rows.filter(row=>row.status==='partial').length,
    failed:rows.filter(row=>stages.some(stage=>failed.has(row.stages[stage].status))).length,
    pending:rows.filter(row=>row.status==='pending').length,running:rows.filter(row=>row.status==='running').length,
    stages:counts,instructionReview:stageCounts(rows,'instruction-review'),evaluatorVersion:state.manifest.evaluatorVersion,artifacts};
}
/** One compact read per run, with overlapping daily scopes counted once by answer identity. */
export async function answerReviewRunSummaries(locations:readonly {run:string;date?:string;optional?:boolean}[],records:readonly import('./incremental.js').AimeRecord[]=[]){
  const runs=[],coverage=answerReviewCoverage();
  coverage.include(records);
  for(const {run,date,optional}of locations){
    const saved=await readJson<Checkpoint>(path.join(run,'state.json'));
    if(optional&&saved.workflow!=='answer-review')continue;
    coverage.add(saved,date);runs.push(await reviewRunSummary(run,saved,date));
  }
  return {runs,coverage:coverage.finish()};
}
function answerReviewCoverage(){
  const empty=()=>({total:0,completed:0,partial:0,pending:0,failed:0,running:0});
  type Counts=ReturnType<typeof empty>;
  type Status='completed'|'running'|'failed'|'pending';
  const rank:Record<Status,number>={completed:3,running:2,failed:1,pending:0};
  const answers=new Map<string,{model:string;question:string;date:string|null;stages:Record<string,Status>}>();
  const include=(model:string,batch:string,caseId:string,trace:string|null|undefined,day:string|null)=>{
    const key=trace?canonical(['trace',trace]):canonical(['case',model,batch,caseId]),answer=answers.get(key)??{model,question:canonical([batch,caseId]),date:day,stages:{score:'pending',attribution:'pending'} as Record<string,Status>};
    if(answer.model!==model)throw Error('同一trace_id存在不同回答模型：'+trace);
    if(answer.date&&day&&answer.date!==day)throw Error('同一回答存在不同业务日期：'+key);
    answer.date??=day;answers.set(key,answer);return answer;
  };
  return {
    include(records:readonly import('./incremental.js').AimeRecord[]){
      for(const record of records)include(record.model,record.batch_id,record.case_id,record.trace_id,record.date);
    },
    add(saved:Checkpoint,date?:string){
      if(saved.workflow!=='answer-review')throw Error('该run不属于独立Score/Attribution流程');
      for(const row of samples(saved)){
        const input=saved.inputs[row.inputId],day=date??(/^\d{4}-\d{2}-\d{2}$/.test(input.batch_id)?input.batch_id:null);
        const answer=include(input.version,input.batch_id,input.case_id,input.trace_id,day);
        for(const stage of stages){
          const current=row.stages[stage].status;
          const status:Status=current==='succeeded'?'completed':failed.has(current)?'failed':current==='running'?'running':'pending';
          if(!answer.stages[stage]||rank[status]>rank[answer.stages[stage]])answer.stages[stage]=status;
        }
      }
    },
    finish(){
      const totals=empty(),models=new Map<string,Counts>(),dates=new Map<string|null,Counts>();
      const stageCounts=()=>Object.fromEntries(stages.map(stage=>[stage,{stage,total:0,completed:0,pending:0,failed:0,running:0}]));
      const counts=stageCounts(),groups=new Map<string,{date:string|null;model:string;counts:Counts;stages:ReturnType<typeof stageCounts>}>();
      for(const answer of answers.values()){
        const key=canonical([answer.date,answer.model]),group=groups.get(key)??{date:answer.date,model:answer.model,counts:empty(),stages:stageCounts()};groups.set(key,group);
        const statuses=stages.map(stage=>{const status=answer.stages[stage];for(const target of [counts[stage],group.stages[stage]]){target.total++;target[status]++;}return status;});
        const status=statuses.every(value=>value==='completed')?'completed':statuses.includes('failed')?'failed':
          statuses.includes('completed')?'partial':statuses.includes('running')?'running':'pending';
        const model=models.get(answer.model)??empty(),daily=dates.get(answer.date)??empty();models.set(answer.model,model);dates.set(answer.date,daily);
        for(const count of [totals,model,daily,group.counts]){count.total++;count[status]++;}
      }
      return {totals,questions:new Set([...answers.values()].map(answer=>answer.question)).size,models:[...models].map(([model,counts])=>({model,...counts})),dates:[...dates].map(([date,counts])=>({date,...counts})),stages:Object.values(counts),
        groups:[...groups.values()].map(group=>({date:group.date,model:group.model,...group.counts,stages:Object.values(group.stages)}))};
    },
  };
}
export async function answerReviewSamples(run:string,params:URLSearchParams){
  const saved=await readJson<Checkpoint>(path.join(run,'state.json')),query=(params.get('query')??'').toLowerCase(),model=params.get('model'),status=params.get('status');
  const rows=samples(saved).filter(row=>(!model||row.model===model)&&(!query||[row.question,row.caseId,row.traceId??''].some(value=>value.toLowerCase().includes(query)))&&
    (!status||status==='all'||row.status===status));
  const integer=(key:string,fallback:number)=>{const raw=params.get(key);if(raw===null)return fallback;const n=Number(raw);if(!Number.isSafeInteger(n)||n<0)throw new HttpError(400,`Invalid ${key}`);return n;};
  const offset=integer('offset',0),limit=Math.min(100,Math.max(1,integer('limit',25)));
  return {runId:saved.manifest.runId,total:rows.length,offset,limit,items:rows.slice(offset,offset+limit)};
}
export async function answerReviewSample(run:string,inputId:string){
  const compact=await answerReviewRepository.readTasks(run,[]),row=(await answerReviewProgress(run)).find(item=>item.inputId===inputId);
  if(!row)throw new HttpError(404,'回答不存在');
  const selected=compact.manifest.tasks.filter(t=>candidate(t).input_id===inputId),ids=selected.map(t=>t.id),state=await answerReviewRepository.readTasks(run,ids);
  const inputs=await loadRunInputs(state.manifest,undefined,new Set(ids),undefined,value=>value),input=inputs[inputId] as Record<string,unknown>,normalized=normalizeInput(input),c=candidate(selected[0]);
  const source=(input._source??{}) as Record<string,unknown>,original=String(source.original_file??''),slash=original.indexOf('/');
  return {...row,input,answer:normalized.messages[c.final_index]?.content??'',
    results:Object.fromEntries(reviewStages.map(stage=>{const view=stage==='instruction-review'?row.instructionReview:row.stages[stage];return [stage,view.taskId?state.receipts[view.taskId]?.exported?.row??null:null];})),
    tasks:selected.map(task=>{const p=state.manifest.states[task.id];return {id:task.id,stage:task.stage,status:p.status,reason:p.reason??null,attempts:p.attempts,errors:p.failure?.errors??[]};}),
    source:{archive:slash>=0?original.slice(0,slash):null,member:slash>=0?original.slice(slash+1):null,line:source.original_line??null,item:source.original_item??null}};
}
export async function retryAnswerReviewTasks(run:string,raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['taskIds','stages'].includes(key)))throw new HttpError(400,'重试范围无效');
  const value=raw as {taskIds?:string[];stages?:string[]};
  for(const selected of [value.taskIds,value.stages])if(selected!==undefined&&(!Array.isArray(selected)||selected.some(id=>typeof id!=='string'||!id)))throw new HttpError(400,'重试范围无效');
  if(value.stages?.some(stage=>!reviewStages.some(known=>known===stage)))throw new HttpError(400,'AIME仅支持Score、Attribution与独立指令检查');
  const state=await answerReviewRepository.readTasks(run,[]);
  if(value.taskIds?.some(id=>!state.manifest.tasks.some(task=>task.id===id)))throw new HttpError(400,'未知评测任务');
  return {retried:await prepareAnswerReviewRetry(run,undefined,value.stages??reviewStages,value.taskIds?new Set(value.taskIds):undefined)};
}

/** Current answer-review checkpoints have no overview file. Reading metadata never opens result JSONL. */
export async function readAnswerReviewAnalysis(run: string, taskIds: string[] = []) {
  const state = await answerReviewRepository.readTasks(run, taskIds);
  const candidates = state.manifest.inputCatalog as Candidate[];
  const rows=await answerReviewProgress(run);
  const counts=Object.fromEntries(reviewStages.map(stage=>[stage,stageCounts(rows,stage)]));
  return { state, candidates, summary: {
    workflow: "answer-review", status: state.manifest.status, startedAt: state.manifest.startedAt,
    ...(state.manifest.finishedAt === undefined ? {} : { finishedAt: state.manifest.finishedAt }),
    inputCount: candidates.length, caseCount: new Set(candidates.map(candidate => JSON.stringify([candidate.batch_id, candidate.case_id]))).size,
    stages:counts, formalComparisonStats: null,
  } };
}

export async function readAnswerReviewInput(run: string, inputId: string) {
  const { state, candidates } = await readAnswerReviewAnalysis(run);
  const candidate = candidates.find(candidate => candidate.input_id === inputId);
  if (!candidate) throw new Error("输入未登记");
  const config = state.manifest.config as AnswerReviewConfig;
  const version = config.inputs.versions.find(version => version.id === candidate.version);
  if (!version) throw new Error("输入版本未登记");
  const { raw, record } = await locateRecordStream(candidate.source, candidate, version, config.inputs.default_batch_id);
  return { raw, candidate: record, version };
}

export function answerReviewAnswer(raw: RawInput, candidate: Candidate, reference: RunReference, audience?: "user") {
  const text = contentText(raw.messages[candidate.final_index]?.content);
  return { reference, model: candidate.version, modelName: candidate.name, question: candidate.question,
    answer: { reference: { ...reference, messageIndex: candidate.final_index }, chars: text.length,
      complete: text.length <= 16000, ...(text.length <= 16000 ? { text } : { preview: text.slice(0, 400) }) },
    trace: analysisTraceMap(raw, reference, candidate.final_index, audience) };
}

/** Resolve accepted sources with each stage's current evidence model; intermediate Score receipts are not public results. */
export async function readAnswerReviewSources(run:string,taskId:string){
  const {state,candidates}=await readAnswerReviewAnalysis(run,[taskId]);
  const task=state.manifest.tasks.find(task=>task.id===taskId),receipt=state.receipts[taskId];
  if(!task||!receipt?.exported||!reviewStages.some(stage=>stage===task.stage))throw Error('没有该任务的正式结果');
  const candidate=candidates.find(candidate=>candidate.input_id===answerReviewTaskInput(task));
  if(!candidate)throw Error('任务输入未登记');
  const {raw,candidate:current}=await readAnswerReviewInput(run,candidate.input_id);
  const sources:Record<string,string>={};
  const add=(id:string,content:string)=>{
    if(Object.hasOwn(sources,id)&&sources[id]!==content)throw Error('任务证据来源冲突');
    sources[id]=content;
  };
  if(task.stage==='attribution'){
    validateOriginalAttributionEvidence(receipt.evaluation,{[candidate.input_id]:raw},receipt.audit);
    const visit=(value:unknown):void=>{
      if(!value||typeof value!=='object')return;
      if(Array.isArray(value)){value.forEach(visit);return;}
      const row=value as Record<string,unknown>;
      if(typeof row.evidence_id==='string'&&typeof row.quote==='string'){add(row.evidence_id,row.quote);return;}
      Object.values(row).forEach(visit);
    };
    visit(receipt.evaluation);
  }else{
    const material=task.stage==='instruction-review'
      ?bindInstructionReview(current,raw).request.sources.case.value as import('@eval/contracts').ReviewCase
      :answerReviewMaterial(current,raw,candidate.input_id).material;
    for(const [id,text]of Object.entries(material.evidence))add(id,text);
    for(const source of receipt.audit.review?.sources??[])add(source.id,source.content);
    for(const quote of (receipt.evaluation as {evidence?:import('@eval/contracts').ReviewQuote[]}).evidence??[]){
      if(sources[quote.source_id]===undefined||Array.from(sources[quote.source_id]).slice(quote.start,quote.end).join('')!==quote.quote)
        throw Error('正式证据与来源坐标不一致');
    }
  }
  return {sources,receipt,candidate};
}
