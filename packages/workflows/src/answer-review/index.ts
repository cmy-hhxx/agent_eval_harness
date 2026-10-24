import path from "node:path";
import {Ajv2020} from 'ajv/dist/2020.js';
import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {canonical,type AgentBinding,type PlannedTask,type RunState,type RunManifest,type WorkflowDefinition,type JsonObject,type SubmissionReceipt,type TaskPlan} from "@eval/contracts";
import {createRunRepository,writeJson,atomicWrite,runLock,type RunCodec} from "@eval/data";
import {buildPlan,loadRunInputs,normalizeInput,pendingTaskProgress,type EvalConfig,type Candidate,type RawInput} from "@eval/workflows/comparison";
import {directAttributionProfile,type DirectAttribution} from "@eval/agents/attribution";
import attributionOutputSchema from '../../../../schemas/workflow/answer-review-attribution.schema.json' with {type:'json'};
import type {ScoreResult} from "@eval/agents/score";
import {answerReviewMaterial} from "./material.js";
export {answerReviewMaterial} from "./material.js";
export * from './incremental.js';
export * from './watch.js';
export interface AnswerReviewConfig extends EvalConfig {workflow:'answer-review';reviewStages?:('score'|'attribution')[]}
interface TaskData {candidate:Candidate;rewriteOf?:string}
const sourceMeta=Symbol('source meta: export only');
function loadReviewInputs(manifest:RunManifest,records?:Map<string,Candidate>){return loadRunInputs(manifest,undefined,undefined,records,source=>{
  const record=source as Record<string,unknown>;
  return {raw:normalizeInput(source),origin:record._source,metadata:Object.hasOwn(record,'meta')?{meta:record.meta}:{}};
});}
export function attributionTextSlots(value:DirectAttribution){return [{id:'summary',text:value.summary,label:'归因总结'},...value.findings.flatMap((f,i)=>[
  {id:`findings.${i}.text`,text:f.text,label:'实际表现'}, {id:`findings.${i}.reason`,text:f.reason,label:'证据与影响'},
  ...(f.type==='problem'?[{id:`findings.${i}.label`,text:f.label!,label:'问题名称'},{id:`findings.${i}.definition`,text:f.definition!,label:'问题定义'}]:[]),
])];}
export async function planAnswerReview(config:AnswerReviewConfig){
  const indexed=await buildPlan({...config,comparisons:[],clustering:{...config.clustering,enabled:false}},undefined,{materializeInputs:false});
  const catalog=indexed.catalog as Candidate[],stages=config.reviewStages??['score','attribution'],tasks:PlannedTask[]=[];
  for(const candidate of catalog)for(const stage of stages){const task:PlannedTask={id:randomUUID(),stage,inputIds:{case:candidate.input_id},dependencies:{},data:{candidate} satisfies TaskData};tasks.push(task);
    if(stage==='attribution'&&config.rewrite.attribution)tasks.push({id:randomUUID(),stage:'rewrite',inputIds:{},dependencies:{source:task.id},data:{candidate,rewriteOf:task.id} satisfies TaskData});}
  const manifest={config,tasks,inputCatalog:catalog} as RunManifest,inputs=prepareInputs(await loadReviewInputs(manifest),catalog);
  const summary={workflow:'answer-review',cases:catalog.length,valid_inputs:catalog.length,score_tasks:tasks.filter(t=>t.stage==='score').length,attribution_tasks:tasks.filter(t=>t.stage==='attribution').length,rewrite_tasks:tasks.filter(t=>t.stage==='rewrite').length,criteria_tasks:0,comparison_tasks:0,issues:indexed.summary.issues??[]};
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
    const value=answerReviewMaterial(candidate,source.raw,candidate.input_id);
    const original=typeof source.origin?.original_file==='string'?source.origin.original_file:undefined,slash=original?.indexOf('/')??-1;
    const metadata={...source.metadata,trace_id:candidate.trace_id,answer_model:candidate.llm,input_file:candidate.source,input_line:candidate.line,
      source_archive:slash>=0?original!.slice(0,slash):null,source_member:slash>=0?original!.slice(slash+1):null,
      source_line:source.origin?.original_line??null,source_item:source.origin?.original_item??null,
      business_date:source.origin?.business_date??(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(candidate.batch_id)?candidate.batch_id:null)};
    return Object.defineProperty({...value.material,view:value.shown,origins:value.origins},sourceMeta,{value:metadata});
  }});
  return result;
}
export function bindAnswerReview(task:PlannedTask,inputs:Record<string,unknown>,dependencies:Record<string,SubmissionReceipt|undefined>):AgentBinding{
  const data=task.data as TaskData;
  if(task.stage==='rewrite')return {agent:'rewrite',profile:'default',request:{input:{kind:'attribution',case:{batch_id:data.candidate.batch_id,case_id:data.candidate.case_id},items:attributionTextSlots(dependencies.source!.evaluation as DirectAttribution)},sources:{}}};
  const source=inputs[data.candidate.input_id] as import("@eval/contracts").ReviewCase & {view:JsonObject};
  return {agent:task.stage,profile:task.stage==='attribution'?'direct':'default',request:{input:source.view,sources:{case:{id:data.candidate.input_id,value:source}}}};
}
export const answerReviewWorkflow:WorkflowDefinition={
  id:'answer-review',plan:config=>planAnswerReview(config as AnswerReviewConfig),bind:bindAnswerReview,
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
      if(!task){task={id:randomUUID(),stage,inputIds:{case:candidate.input_id},dependencies:{},data:{candidate} satisfies TaskData};add(task);tasks.set(key,task);}
      if(stage==='attribution'&&config.rewrite.attribution&&!rewrites.has(task.id)){
        add({id:randomUUID(),stage:'rewrite',inputIds:{},dependencies:{source:task.id},data:{candidate,rewriteOf:task.id} satisfies TaskData});
        rewrites.add(task.id);
      }
    }
    const selectedIds=new Set(selected.map(candidate=>candidate.input_id));
    manifest.executionScope=manifest.tasks.filter(task=>selectedIds.has((task.data as TaskData).candidate.input_id)&&
      (stages.includes(task.stage as 'score'|'attribution')||task.stage==='rewrite'&&stages.includes('attribution')&&config.rewrite.attribution)).map(task=>task.id);
    manifest.preflight={...manifest.preflight,...Object.fromEntries(['score','attribution','rewrite'].map(stage=>[stage+'_tasks',manifest.tasks.filter(task=>task.stage===stage).length]))};
    return {tasks:manifest.tasks,inputs:prepareInputs(raw,catalog),catalog,summary:manifest.preflight};
  },
};
const resultFile=(stage:string)=>stage==='score'?'score.jsonl':'attribution.jsonl';
export const answerReviewAttributionSchema=attributionOutputSchema;
const validateAttributionOutput=new Ajv2020({allErrors:true,strict:false}).addSchema(directAttributionProfile.resultSchema!,'attribution/direct-result.schema.json').compile(attributionOutputSchema);
const resultEncoder=(task:PlannedTask,state:RunState,inputs:Record<string,unknown>)=>{
  const receipt=state.receipts[task.id],data=task.data as TaskData;
  const metadata=(inputs[data.candidate.input_id] as {[sourceMeta]:Record<string,unknown>}|undefined)?.[sourceMeta];
  if(!metadata)throw Error('缺少源输入，不能静默遗漏meta：'+data.candidate.input_id);
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
interface Checkpoint {workflow:'answer-review';manifest:Omit<RunManifest,'tasks'|'states'|'inputs'|'inputCatalog'>;inputs:Record<string,Candidate>;tasks:Record<string,{task:Omit<PlannedTask,'id'|'data'>;data:{input_id:string;rewriteOf?:string};state:RunManifest['states'][string];receipt?:any}>;usage:RunState['usage'];recordedAttempts:number}
const codec:RunCodec<Checkpoint>={
  encode(state){const {tasks,states,inputs:_inputs,inputCatalog,...manifest}=state.manifest;return {workflow:'answer-review',manifest,inputs:Object.fromEntries((inputCatalog as Candidate[]).map(c=>[c.input_id,c])),usage:state.usage,recordedAttempts:state.recordedAttempts,
    tasks:Object.fromEntries(tasks.map(task=>{const {id,data,...definition}=task,info=data as TaskData,receipt=state.receipts[id];let saved:any;
      if(receipt){const {evaluation,submitted:_submitted,exported,...rest}=receipt;const {review:_review,...audit}=rest.audit;saved={...rest,audit:exported?audit:rest.audit,...(exported?{exported:{id:exported.id,file:exported.file}}:{evaluation})};}
      return [id,{task:definition,data:{input_id:info.candidate.input_id,...(info.rewriteOf?{rewriteOf:info.rewriteOf}:{})},state:states[id],...(saved?{receipt:saved}:{})}];}))};},
  references(checkpoint,ids){return Object.entries(checkpoint.tasks).flatMap(([id,row])=>!ids||ids.has(id)?row.receipt?.exported?[row.receipt.exported]:[]:[]);},
  resultId:row=>String(row.task_id),
  decode(checkpoint,read,ids){if(checkpoint.workflow!=='answer-review')throw Error('该run不属于独立Score/Attribution流程');
    const tasks:PlannedTask[]=[],receipts:RunState['receipts']={},states:RunManifest['states']={};
    for(const[id,row]of Object.entries(checkpoint.tasks)){tasks.push({id,...row.task,data:{candidate:checkpoint.inputs[row.data.input_id],...(row.data.rewriteOf?{rewriteOf:row.data.rewriteOf}:{})}});states[id]=row.state;
      if(row.receipt&&(!ids||ids.has(id))){const saved=row.receipt,exported=saved.exported?{...saved.exported,row:read(saved.exported)}:undefined;
        receipts[id]={...saved,evaluation:saved.evaluation??(row.task.stage==='rewrite'?{rewrites:(exported?.row.rewritten as any)?.rewrites}:row.task.stage==='attribution'?{summary:exported?.row.summary,findings:exported?.row.findings,evidence:exported?.row.evidence}:exported?.row.evaluation),audit:{...saved.audit,...(exported?.row.verification?{review:exported.row.verification}:{})},...(exported?{exported}:{})};}}
    return {manifest:{...checkpoint.manifest,tasks,states,inputs:Object.fromEntries(Object.keys(checkpoint.inputs).map(id=>[id,{id,name:id}])),inputCatalog:Object.values(checkpoint.inputs)},receipts,usage:checkpoint.usage,recordedAttempts:checkpoint.recordedAttempts};
  },
};
export const answerReviewRepository=createRunRepository(codec,resultEncoder);
/** Add newly published answers to the existing day; never replace accepted tasks or result identities. */
export async function appendAnswerReviewAttribution(run:string,config:AnswerReviewConfig){
  const release=await runLock(run);
  try{
    const state=await answerReviewRepository.readRun(run),plan=await planAnswerReview(config);
    if((plan.summary.issues as unknown[]).length||plan.catalog.length!==config.inputs.records?.length)throw Error('日期追加范围校验失败');
    const key=(c:Candidate)=>canonical([c.version,c.batch_id,c.case_id]);
    const catalog=state.manifest.inputCatalog as Candidate[],known=new Map(catalog.map(c=>[key(c),c]));let added=0;
    for(const candidate of plan.catalog){const prior=known.get(key(candidate));
      if(prior){if(prior.trace_id!==candidate.trace_id)throw Error('同一回答身份的trace_id发生变化');continue;}
      const task=plan.tasks.find(t=>t.stage==='attribution'&&t.inputIds.case===candidate.input_id)!;
      catalog.push(candidate);known.set(key(candidate),candidate);state.manifest.tasks.push(task);state.manifest.states[task.id]={status:'pending',attempts:0};added++;
    }
    const saved=state.manifest.config as AnswerReviewConfig;
    const versions=new Map([...saved.inputs.versions,...config.inputs.versions].map(v=>[v.id,v]));
    state.manifest.config={...saved,execution:config.execution,rewrite:config.rewrite,reviewStages:['attribution'],inputs:{...saved.inputs,
      records:config.inputs.records,
      versions:[...versions.values()].map(v=>({...v,sources:[...new Set(catalog.filter(c=>c.version===v.id).map(c=>c.source))].map(file=>({kind:'file' as const,path:file}))}))}};
    state.manifest.preflight={...state.manifest.preflight,valid_inputs:catalog.length,cases:new Set(catalog.map(c=>canonical([c.batch_id,c.case_id]))).size,
      attribution_tasks:state.manifest.tasks.filter(t=>t.stage==='attribution').length};
    await answerReviewRepository.writeRun(run,state);return added;
  }finally{await release();}
}
/** A manual invocation grants fresh task UUIDs only to unsuccessful attempts; accepted rows stay immutable. */
export async function prepareAnswerReviewRetry(run:string,traceIds?:ReadonlySet<string>){
  const release=await runLock(run);
  try{const state=await answerReviewRepository.readRun(run),renewed:{from:string;to:string}[]=[];
    for(const task of state.manifest.tasks){const progress=state.manifest.states[task.id];
      if(task.stage!=='attribution'||traceIds&&!traceIds.has((task.data as TaskData).candidate.trace_id??'')||state.receipts[task.id]||!['failed','timed_out','cancelled','blocked','running'].includes(progress.status))continue;
      const from=task.id,to=randomUUID();task.id=to;delete state.manifest.states[from];state.manifest.states[to]={status:'pending',attempts:0};renewed.push({from,to});
    }
    state.manifest.executionScope=state.manifest.tasks.filter(t=>t.stage==='attribution').map(t=>t.id);
    state.manifest.pausedStages=(state.manifest.pausedStages??[]).filter(p=>p.stage!=='attribution');
    await answerReviewRepository.writeRun(run,state);return renewed;
  }finally{await release();}
}
/** Continuous recovery retains task identities and spent budgets; terminal content failures stay reported. */
export async function prepareAnswerReviewAutomaticResume(run:string,traceIds:ReadonlySet<string>){
  const release=await runLock(run);
  try{
    const state=await answerReviewRepository.readRun(run),policy=(state.manifest.config as AnswerReviewConfig).execution;
    const eligible=state.manifest.tasks.filter(task=>{
      const c=(task.data as TaskData).candidate,p=state.manifest.states[task.id],failure=p.failure;
      if(task.stage!=='attribution'||!traceIds.has(c.trace_id??'')||state.receipts[task.id]||failure?.stopped)return false;
      if((failure?.contentSubmissions??0)>=1+(policy.stageRepairAttempts?.attribution??policy.repairAttempts)||
        policy.maxTaskAttempts!==undefined&&p.attempts>=policy.maxTaskAttempts)return false;
      return ['pending','running','cancelled','timed_out'].includes(p.status)||p.attempts===0||
        Boolean(failure?.errors.some(e=>['transport','interruption'].includes(e.category)||e.code==='attribution_language'));
    });
    if(eligible.length){
      state.manifest.executionScope=eligible.map(t=>t.id);
      state.manifest.pausedStages=(state.manifest.pausedStages??[]).filter(p=>p.stage!=='attribution');
      await answerReviewRepository.writeRun(run,state);
    }
    return new Set(eligible.map(t=>(t.data as TaskData).candidate.trace_id!));
  }finally{await release();}
}
export async function reportAnswerReview(run:string,state?:RunState){
  state ??= await answerReviewRepository.readRun(run);
  const stages:Record<string,Record<string,number>>={};for(const task of state.manifest.tasks){const status=state.manifest.states[task.id]?.status??'pending';const row=stages[task.stage]??={};row[status]=(row[status]??0)+1;}
  const results=state.manifest.tasks.filter(t=>t.stage==='score').flatMap(t=>state.receipts[t.id]?[{task:t,receipt:state.receipts[t.id]}]:[]);
  const summary={workflow:'answer-review',run_id:state.manifest.runId,status:state.manifest.status,active_stages:(state.manifest.config as AnswerReviewConfig).reviewStages??['score','attribution'],stages,tokens:state.usage,concurrency:state.manifest.concurrency,
    completed_scores:results.length,completed_attributions:state.manifest.tasks.filter(t=>t.stage==='attribution'&&state.receipts[t.id]).length,
    execution_task_statuses:Object.fromEntries([...new Set(Object.values(state.manifest.states).map(s=>s.status))].map(status=>[status,Object.values(state.manifest.states).filter(s=>s.status===status).length])),paused_stages:state.manifest.pausedStages??[]};
  await writeJson(path.join(run,'stats.json'),summary);
  const lines=['# 独立回答评测','',`状态：${summary.status}`,''];
  if(summary.active_stages.includes('score')){
    lines.push('| 题目 | 模型 | 最终总分 / 区间 | 状态 |','|---|---|---|---|');
    for(const{task,receipt}of results){const c=(task.data as TaskData).candidate,value=receipt.evaluation as ScoreResult;lines.push(`| ${c.case_id} | ${c.version} | ${value.final_answer_score?.score??JSON.stringify(value.final_answer_score?.score_range??null)} | ${value.final_answer_score?.status??(value as any).assessment_status} |`);}
  }else{
    lines.push('| 题目 | 模型 | 问题数 | 中文归因 |','|---|---|---|---|');
    for(const task of state.manifest.tasks.filter(t=>t.stage==='attribution')){const receipt=state.receipts[task.id];if(!receipt)continue;const c=(task.data as TaskData).candidate,value=receipt.evaluation as DirectAttribution;
      lines.push(`| ${c.case_id} | ${c.version} | ${value.findings.filter(f=>f.type==='problem').length} | ${value.summary.replaceAll('|','\\|').replaceAll('\n',' ')} |`);}
  }
  lines.push('');await atomicWrite(path.join(run,'report.md'),lines.join('\n'));return summary;
}
export function validateAnswerReview(state:RunState){
  for(const task of state.manifest.tasks){const r=state.receipts[task.id];if(!r)continue;if(r.taskId!==task.id||!r.exported||r.exported.id!==((task.data as TaskData).rewriteOf??task.id))throw Error('正式结果引用与任务不一致');
    const row=r.exported.row,value=task.stage==='attribution'?{summary:row.summary,findings:row.findings,evidence:row.evidence}:row.evaluation;
    if(task.stage==='attribution'&&!validateAttributionOutput(row))throw Error('归因导出元信息契约无效');
    if(task.stage!=='rewrite'&&canonical(value)!==canonical(r.evaluation))throw Error('正式结果正文与已接受收据不一致');}
  return {valid:true,receipts:Object.keys(state.receipts).length};
}
