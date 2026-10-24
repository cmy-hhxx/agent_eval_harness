import path from 'node:path';
import {HttpError,safeId} from '@eval/contracts';
import {exists,readJson,writeJson,hasLiveRunOwner,localFiles} from '@eval/data';
import {answerReviewRunSummaries,answerReviewSamples,answerReviewSample,retryAnswerReviewTasks,type AimeIncrementalState} from '@eval/workflows/answer-review';
import {combineEvaluationAnalytics} from './daily-evaluation-analytics.js';
import {loadConfig,createModelResolver,dashboardSettings,type HostConfig} from './config.js';
import {readSettings} from './settings.js';
import {loadAimeConfiguration,runAimeEvaluation,type AimeRunOptions} from './aime-execution.js';

interface AimeSettingsPatch {engine?:'pi'|'prime';debug?:boolean;bindings?:Record<string,unknown>;execution?:Record<string,unknown>}

export async function loadAimeWorkbench(file:string,options:{id?:string;name?:string}={}){
  const configuration=await loadAimeConfiguration(file),id=options.id??'aime',name=options.name??'AIME日常',settingsFile=path.join(configuration.stateDirectory,'workbench-settings.json');
  let overlay:AimeSettingsPatch=await exists(settingsFile)?await readJson(settingsFile):{},running=false;
  const host=async(patch=overlay):Promise<HostConfig>=>{
    const {engine:_engine,debug:_debug,...settings}=patch;
    const current=await loadConfig(configuration.hostConfigs,await readSettings(configuration.settingsFile),settings);
    current.workflow='answer-review';current.evaluation.rewrite={attribution:false,comparison:false,clustering:false};current.evaluation.clustering.enabled=false;
    return current;
  };
  const initial=await host();
  configuration.concurrency=Number(overlay.execution?.concurrency??configuration.concurrency);
  const settings={evaluatorVersion:initial.evaluatorVersion,concurrency:configuration.concurrency};
  const runPath=async(runId:string)=>{const run=path.join(configuration.outputDirectory,safeId(runId));if(!await exists(path.join(run,'state.json')))throw new HttpError(404,'AIME运行不存在');return run;};
  const runs=async()=>{
    const state=await exists(path.join(configuration.stateDirectory,'state.json'))?await readJson<AimeIncrementalState>(path.join(configuration.stateDirectory,'state.json')):undefined;
    const dates=new Map<string,string>();
    for(const job of state?.jobs??[]){
      if(dates.has(job.id)&&dates.get(job.id)!==job.date)throw new HttpError(409,'AIME运行关联多个业务日期');
      dates.set(job.id,job.date);
    }
    const rows:{run:string;date?:string;optional?:boolean}[]=[];
    for(const [runId,date]of dates){
      const run=path.join(configuration.outputDirectory,safeId(runId));
      if(await exists(path.join(run,'state.json')))rows.push({run,date});
      else if(state!.jobs.some(job=>job.id===runId&&(job.done||(job.result?.launched??0)>0||(job.result?.succeeded??0)>0)))throw new HttpError(409,'AIME已执行运行的状态文件缺失：'+runId);
    }
    const entries=await exists(configuration.outputDirectory)?await localFiles.list(configuration.outputDirectory,{withFileTypes:true}):[];
    for(const entry of entries)if(entry.isDirectory()&&!dates.has(entry.name)&&await exists(path.join(configuration.outputDirectory,entry.name,'state.json')))
      rows.push({run:path.join(configuration.outputDirectory,entry.name),optional:true});
    const view=await answerReviewRunSummaries(rows,state?.jobs.flatMap(job=>job.records)??[]);
    return {...view,runs:view.runs.sort((a,b)=>(b.date??b.runId).localeCompare(a.date??a.runId))};
  };
  const snapshot=async()=>{
    const current=await host(),view=await runs(),stateFile=path.join(configuration.stateDirectory,'state.json');
    const state=await exists(stateFile)?await readJson<AimeIncrementalState>(stateFile):undefined;
    const reportFile=path.join(configuration.stateDirectory,'last-report.json'),report=await exists(reportFile)?await readJson<Record<string,unknown>>(reportFile):undefined;
    const watchFile=path.join(configuration.stateDirectory,'watch.json'),watch=await exists(watchFile)?await readJson<Record<string,unknown>>(watchFile):undefined;
    const ownerAlive=await hasLiveRunOwner(configuration.stateDirectory),externalOwner=ownerAlive&&!running;
    const deferred=new Set(((report?.deferred??[]) as {archive:string}[]).map(item=>item.archive)),failures=new Set(((report?.archive_failures??[]) as {archive:string}[]).map(item=>item.archive));
    const packages=[...new Map(state?.scans.flatMap(scan=>scan.names.map(archive=>[archive,{name:archive,status:failures.has(archive)?'failed':deferred.has(archive)?'waiting':scan.cleaned?'cleaned':'pending',report:scan.report_file??null}] as const))??[]).values()];
    const stages=Object.fromEntries(view.coverage.stages.map(({stage,...counts})=>[stage,{...counts,succeeded:counts.completed}]));
    const models=Object.fromEntries(view.coverage.models.map(counts=>[counts.model,{answers:counts.total,completed:counts.completed,failed:counts.failed,
      pending:counts.pending+counts.partial+counts.running,partial:counts.partial,running:counts.running}]));
    const totals=view.coverage.totals;
    return {id,name,workflow:'answer-review' as const,archiveDirectory:configuration.archiveDirectory,inputDirectory:configuration.inputDirectory,outputDirectory:configuration.outputDirectory,
      answerCounts:view.coverage.totals,
      questions:view.coverage.questions,answers:totals.total,completedAnswers:totals.completed,models,
      partialAnswers:totals.partial,pendingAnswers:totals.pending+totals.partial+totals.running,failedAnswers:totals.failed,
      taskTotal:view.coverage.stages.reduce((n,stage)=>n+stage.total,0),taskCompleted:view.coverage.stages.reduce((n,stage)=>n+stage.completed,0),
      concurrency:configuration.concurrency,evaluatorVersion:current.evaluatorVersion,ownerAlive,externalOwner,watch:watch??null,
      error:externalOwner?'AIME正由另一个进程运行，请先停止原aime-auto或CLI进程':watch?.lastError??null,
      settings:{engine:overlay.engine??configuration.engine,debug:overlay.debug??false,execution:{...current.evaluation.execution,concurrency:configuration.concurrency},
        bindings:Object.fromEntries(['score','attribution'].map(stage=>{const binding=current.models.bindings[stage],profile=current.models.models[binding?.profile];
          return [stage,{channel:binding?.channel??profile?.provider??'',model:binding?.model??profile?.model??'',thinking:binding?.thinking??profile?.thinking??'medium'}];}))},
      packages,stages,runs:view.runs,report:report??null};
  };
  const setSettings=async(value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'AIME设置必须是对象');
    const raw=value as Record<string,unknown>;
    if(Object.keys(raw).some(key=>!['engine','debug','execution','bindings'].includes(key)))throw new HttpError(400,'AIME设置包含未知字段');
    if(raw.engine!==undefined&&!['pi','prime'].includes(String(raw.engine)))throw new HttpError(400,'未知Worker引擎');
    if(raw.debug!==undefined&&typeof raw.debug!=='boolean')throw new HttpError(400,'debug必须是布尔值');
    if(raw.bindings&&Object.keys(raw.bindings as object).some(stage=>!['score','attribution'].includes(stage)))throw new HttpError(400,'AIME只配置Score与Attribution');
    const {engine,debug,...modelSettings}=raw,{engine:previousEngine,debug:previousDebug,...previous}=overlay;
    const patch={...dashboardSettings(modelSettings,previous),engine:engine??previousEngine,debug:debug??previousDebug} as AimeSettingsPatch;
    const validated=await host(patch),resolver=createModelResolver(validated.models);
    resolver('score');resolver('attribution');
    await writeJson(settingsFile,patch);overlay=patch;
    configuration.concurrency=Number(overlay.execution?.concurrency??configuration.concurrency);settings.concurrency=configuration.concurrency;
    settings.evaluatorVersion=validated.evaluatorVersion;
    return snapshot();
  };
  return {id,name,configuration,settings,snapshot,runs,setSettings,
    async analytics(){
      return combineEvaluationAnalytics('answers',[(await runs()).coverage]);
    },
    setConcurrency:(concurrency:number)=>setSettings({execution:{concurrency}}),
    async run(signal:AbortSignal,controls:Pick<AimeRunOptions,'modelRequests'|'pauseSignal'>={}){
      if(running)throw new HttpError(409,'AIME正在运行');running=true;
      const selected=structuredClone(overlay),selectedEngine=selected.engine??configuration.engine,selectedDebug=selected.debug??false;
      try{
        const current=await host(selected),resolver=createModelResolver(current.models);resolver('score');resolver('attribution');
        return await runAimeEvaluation(configuration,{signal,...controls,watch:true,host:async()=>structuredClone(current),engine:()=>selectedEngine,
          debug:()=>selectedDebug,concurrency:()=>controls.modelRequests?.concurrency()??configuration.concurrency});
      }
      finally{running=false;}
    },
    samples:async(runId:string,params:URLSearchParams)=>answerReviewSamples(await runPath(runId),params),
    sample:async(runId:string,inputId:string)=>answerReviewSample(await runPath(runId),inputId),
    async retry(runId:string,value:{taskIds?:string[];stages?:string[]}){
      const run=await runPath(runId);if(running||await hasLiveRunOwner(configuration.stateDirectory))throw new HttpError(409,'请先停止AIME再重试');
      return retryAnswerReviewTasks(run,value);
    },
  };
}
export type AimeWorkbench=Awaited<ReturnType<typeof loadAimeWorkbench>>;
