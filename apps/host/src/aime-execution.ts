import path from 'node:path';
import {spawn} from 'node:child_process';
import {ensureClusterPlaceholder,exists,readJson,writeJson,runLock,createFileLogger,hasLiveRunOwner} from '@eval/data';
import type {ModelRequestControl} from '@eval/host';
import {runAimeIncremental,runAimeWatch,answerReviewRepository,answerReviewProgress,prepareAnswerReviewRetry,prepareAnswerReviewAutomaticResume,appendAnswerReviewInputs,planAnswerReview,
  type AimeIncrementalState,type AimeJob,type AimeRecord,type AimeCleaningReport,type AimeEvaluationResult} from '@eval/workflows/answer-review';
import {loadConfig,type HostConfig,type AnswerReviewHostConfig} from './config.js';
import {configurationSecrets,readSettings} from './settings.js';
import {ROOT} from './paths.js';

export interface AimeConfiguration {
  archiveDirectory:string;inputDirectory:string;dataStateDirectory:string;stateDirectory:string;outputDirectory:string;
  hostConfigs:string[];settingsFile:string;logDirectory:string;logLockDirectory:string;
  python:string;pythonPath?:string;sevenZip:string;stableSeconds:number;stableTimeoutSeconds:number;concurrency:number;pollSeconds:number;
}
export function aimeConfiguration(value:Record<string,unknown>,directory:string):AimeConfiguration{
  const located=(key:string)=>{const item=value[key];if(typeof item!=='string'||!item.trim())throw Error('Missing '+key);return path.resolve(directory,item);};
  const c={archiveDirectory:located('archiveDirectory'),inputDirectory:located('inputDirectory'),dataStateDirectory:located('dataStateDirectory'),
    stateDirectory:located('stateDirectory'),outputDirectory:located('outputDirectory'),settingsFile:located('settingsFile'),
    logDirectory:located('logDirectory'),logLockDirectory:located('logLockDirectory'),hostConfigs:[] as string[],
    python:typeof value.python==='string'?value.python:'python3',pythonPath:value.pythonPath?located('pythonPath'):undefined,
    sevenZip:typeof value.sevenZip==='string'?value.sevenZip:'7z',stableSeconds:value.stableSeconds??3,
    stableTimeoutSeconds:value.stableTimeoutSeconds??30,concurrency:value.concurrency??200,pollSeconds:value.pollSeconds??60} as AimeConfiguration;
  if(!Array.isArray(value.hostConfigs)||!value.hostConfigs.length||value.hostConfigs.some(v=>typeof v!=='string'))throw Error('hostConfigs must list the existing AIME Host configuration files');
  c.hostConfigs=value.hostConfigs.map(v=>path.resolve(directory,String(v)));
  if(!Number.isFinite(c.stableSeconds)||c.stableSeconds<=0||c.stableTimeoutSeconds<=c.stableSeconds)throw Error('Invalid stability interval');
  if(!Number.isSafeInteger(c.concurrency)||c.concurrency<1)throw Error('Invalid concurrency');
  if(!Number.isSafeInteger(c.pollSeconds)||c.pollSeconds<1)throw Error('Invalid pollSeconds');
  if(c.outputDirectory!==path.join(path.dirname(c.inputDirectory),'eval_output','0_daily_eval'))throw Error('正式结果必须位于同一AIME来源的eval_output/0_daily_eval');
  return c;
}
export async function loadAimeConfiguration(file:string){return aimeConfiguration(await readJson<Record<string,unknown>>(file),path.dirname(path.resolve(file)));}
async function command(executable:string,args:string[],env:NodeJS.ProcessEnv,signal:AbortSignal,pauseSignal?:AbortSignal){
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:ROOT,env,signal,stdio:['ignore','pipe','pipe']});
    let output='',ready=false,sent=false;
    const pause=()=>{if(ready&&!sent&&pauseSignal?.aborted&&child.exitCode===null){sent=true;child.kill('SIGUSR1');}};
    pauseSignal?.addEventListener('abort',pause,{once:true});
    child.stdout!.on('data',chunk=>{output=(output+String(chunk)).slice(-128);if(output.includes('AIME_INGEST_READY')){ready=true;pause();}});
    let stderr='';child.stderr!.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});
    const cleanup=()=>pauseSignal?.removeEventListener('abort',pause);
    child.once('error',error=>{cleanup();reject(error);});child.once('close',(code,stopped)=>{cleanup();code===0?resolve():reject(Error(`${executable} exited ${code??stopped}: ${stderr}`));});
  });
}
export function aimeScopedHost(base:HostConfig,job:AimeJob,concurrency:number,taskConcurrency?:number):AnswerReviewHostConfig{
  const source=structuredClone(base),models=new Set(job.records.map(r=>r.model));
  const inputs={timing_unit:source.evaluation.inputs.timing_unit,
    versions:source.evaluation.inputs.versions.filter(v=>models.has(v.id)).map(v=>({...v,
      sources:[...new Set(job.records.filter(r=>r.model===v.id).map(r=>r.input_file))].map(file=>({kind:'file' as const,path:file}))})),
    records:job.records.map(r=>({model:r.model,batch_id:r.batch_id,case_id:r.case_id,trace_id:r.trace_id,input_file:r.input_file,input_index:r.input_index}))};
  if(inputs.versions.length!==models.size)throw Error('AIME模型组未在当前配置登记');
  return {...source,workflow:'answer-review',evaluation:{workflow:'answer-review',inputs,
    output:{kind:'directory',path:path.dirname(job.output)},rewrite:{attribution:false},
    execution:{...source.evaluation.execution,concurrency,...(taskConcurrency?{taskConcurrency}:{})}}};
}
export interface AimeRunOptions {
  signal:AbortSignal;pauseSignal?:AbortSignal;modelRequests?:ModelRequestControl;watch?:boolean;manualRetry?:boolean;
  host?:()=>Promise<HostConfig>;debug?:()=>boolean;concurrency?:()=>number;
}
/** The CLI and Workbench share this owner, ingestion journal, day runs and accepted receipts. */
export async function runAimeEvaluation(c:AimeConfiguration,options:AimeRunOptions){
  options.signal.throwIfAborted();
  if(await hasLiveRunOwner(c.stateDirectory))throw Error('AIME正由另一个进程运行，请先停止原aime-auto或CLI进程，再从工作台启动');
  const logger=createFileLogger({directory:c.logDirectory,lockDirectory:c.logLockDirectory});
  let release:()=>Promise<void>;
  try{release=await runLock(c.stateDirectory);}
  catch(error){if(await hasLiveRunOwner(c.stateDirectory))throw Error('AIME正由另一个进程运行，请先停止原aime-auto或CLI进程，再从工作台启动');throw error;}
  let firstCycle=true;
  try{
    const settings=await readSettings(c.settingsFile);
    const bypass=[settings.environment.no_proxy||settings.environment.NO_PROXY||process.env.no_proxy||process.env.NO_PROXY,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
    settings.environment.no_proxy=bypass;settings.environment.NO_PROXY=bypass;
    logger.addSecrets(...configurationSecrets());
    const getHost=options.host??(()=>loadConfig(c.hostConfigs,settings));
    const concurrency=()=>options.concurrency?.()??c.concurrency;
    const stateFile=path.join(c.stateDirectory,'state.json'),helper=path.join(ROOT,'data_service/aime_ingest_once.py');
    const env={...process.env,...(c.pythonPath?{PYTHONPATH:[c.pythonPath,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}:{})};
    const invoke=async(operation:'scan'|'process'|'catalog',output:string,namesFile?:string)=>{
      const args=[helper,operation,'--archive-dir',c.archiveDirectory,'--input-dir',c.inputDirectory,'--data-state',c.dataStateDirectory,
        '--validator',path.join(ROOT,'dist/apps/host/src/aime-validate-inputs.js'),'--node',process.execPath,'--seven-zip',c.sevenZip,
        '--stable-seconds',String(c.stableSeconds),'--timeout-seconds',String(c.stableTimeoutSeconds),'--output',output,
        ...(namesFile?['--names-file',namesFile]:[])];
      await command(c.python,args,env,options.signal,operation==='process'?options.pauseSignal:undefined);
    };
    const cycle=async()=>{
      let historicalExclusions:{reason:string;[key:string]:unknown}[]=[];
      const summary=await runAimeIncremental({output:c.outputDirectory,concurrency:Math.max(1,concurrency()),signal:options.signal,pauseSignal:options.pauseSignal,refreshCompleted:firstCycle},{
        load:async()=>await exists(stateFile)?readJson<AimeIncrementalState>(stateFile):undefined,
        save:state=>writeJson(stateFile,state),
        async scan(){const file=path.join(c.stateDirectory,'scan.json');await invoke('scan',file);return readJson(file);},
        async clean(scan){const directory=path.join(c.stateDirectory,'ingestions',scan.id),namesFile=path.join(directory,'archives.json'),file=path.join(directory,'report.json');
          await writeJson(namesFile,scan.names);await invoke('process',file,namesFile);return {file,report:await readJson<AimeCleaningReport>(file)};},
        ...(firstCycle?{async existingRecords(){const file=path.join(c.stateDirectory,'catalog.json');await invoke('catalog',file);
          const catalog=await readJson<{records:AimeRecord[];exclusions:typeof historicalExclusions}>(file);historicalExclusions=catalog.exclusions;return catalog.records;}}:{}),
        async evaluate(job,capacity,signal){
          try{
          const modelConcurrency=Math.max(1,options.modelRequests?.concurrency()??c.concurrency),taskConcurrency=Math.max(1,capacity*2);
          const host=aimeScopedHost(await getHost(),job,modelConcurrency,taskConcurrency),config={...host.evaluation,workflow:'answer-review' as const,reviewStages:['score','attribution'] as ('score'|'attribution')[]},
            file=path.join(job.output,'state.json'),traceIds=new Set(job.records.map(r=>r.trace_id));
          if(await exists(file))await appendAnswerReviewInputs(job.output,config);
          else{const plan=await planAnswerReview(config);if(plan.catalog.length!==job.records.length||plan.tasks.length!==2*job.records.length||(plan.summary.issues as unknown[]).length)throw Error('AIME全量范围校验失败');}
          await ensureClusterPlaceholder(job.output);
          let eligible=traceIds,resumeTaskIds:Set<string>|undefined;
          if(await exists(file)){
            if(options.manualRetry)await prepareAnswerReviewRetry(job.output,traceIds);
            resumeTaskIds=await prepareAnswerReviewAutomaticResume(job.output,traceIds);
          }
          const before=await exists(file)?await answerReviewRepository.readTasks(job.output,[]):undefined;
          if(resumeTaskIds)eligible=new Set(before!.manifest.tasks.filter(task=>resumeTaskIds.has(task.id)).map(task=>(task.data as {candidate:{trace_id:string}}).candidate.trace_id));
          const selected=(state:typeof before)=>state?.manifest.tasks.filter(t=>['score','attribution','instruction-review'].includes(t.stage)&&traceIds.has((t.data as {candidate:{trace_id:string}}).candidate.trace_id))??[];
          const pendingBefore=selected(before).filter(task=>before!.manifest.states[task.id].status!=='succeeded');
          let launched=0,code=0;
          if(eligible.size&&!options.pauseSignal?.aborted){
            host.evaluation.inputs.records=host.evaluation.inputs.records!.filter(r=>eligible.has(r.trace_id!));
            launched=before?pendingBefore.filter(task=>eligible.has((task.data as {candidate:{trace_id:string}}).candidate.trace_id)).length:job.records.length*2;
            if(launched){const {runAnswerReviewCommand}=await import('./answer-review-command.js');
              const requests=options.modelRequests;
              code=await runAnswerReviewCommand(host,{command:'run',runId:job.id,signal,pauseSignal:options.pauseSignal,
                modelRequests:requests,debug:options.debug?.(),resumeTaskIds:resumeTaskIds&&[...resumeTaskIds]});}
          }
          if(!await exists(file))return {launched:0,succeeded:0,failures:[],exit_code:options.signal.aborted?130:2,output:job.output};
          const state=await answerReviewRepository.readTasks(job.output,[]),tasks=selected(state),failures=tasks.filter(task=>state.manifest.states[task.id].status!=='succeeded').map(task=>{
            const p=state.manifest.states[task.id];return {task_id:task.id,stage:task.stage,status:p.status,reason:p.reason??p.failure?.errors??null};});
          const progress=await answerReviewProgress(job.output);
          const succeeded=job.records.filter(record=>progress.some(row=>row.traceId===record.trace_id&&row.status==='succeeded')).length;
          const started=tasks.filter(task=>state.manifest.states[task.id].attempts>(before?.manifest.states[task.id]?.attempts??0));
          return {launched:started.length,succeeded,failures,exit_code:failures.length?2:code,output:job.output,
            stages:Object.fromEntries(['score','attribution'].map(stage=>[stage,{launched:started.filter(task=>task.stage===stage).length,
              succeeded:progress.filter(row=>traceIds.has(row.traceId??'')&&row.stages[stage].status==='succeeded').length}]))} satisfies AimeEvaluationResult;
          }catch(error){throw error;}
        },
      });
      if(historicalExclusions.length){summary.quarantined+=historicalExclusions.length;summary.quarantine.push(...historicalExclusions);summary.exit_code=options.signal.aborted?130:2;}
      firstCycle=false;
      await writeJson(path.join(c.stateDirectory,'last-report.json'),summary);
      await logger.event('aime_incremental_finished',{component:'aime-ingest',added:summary.added_records,backfilled:summary.backfilled_records,score:summary.score_succeeded,attribution:summary.attribution_succeeded,exit_code:summary.exit_code});
      return summary;
    };
    if(options.watch){await runAimeWatch({pollMs:c.pollSeconds*1000,signal:options.signal,pauseSignal:options.pauseSignal},{run:cycle,
      status:status=>writeJson(path.join(c.stateDirectory,'watch.json'),{...status,pid:process.pid,concurrency:concurrency()}),
      error:error=>logger.error(error,{component:'aime-ingest',event:'aime_cycle_failed'})});return options.signal.aborted?130:0;}
    return (await cycle()).exit_code;
  }finally{await release();}
}
