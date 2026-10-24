import path from 'node:path';
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {exists,readJson,writeJson,runLock,createFileLogger} from '@eval/data';
import {runAimeIncremental,runAimeWatch,answerReviewRepository,prepareAnswerReviewRetry,prepareAnswerReviewAutomaticResume,appendAnswerReviewAttribution,planAnswerReview,
  type AimeIncrementalState,type AimeJob,type AimeCleaningReport,type AimeEvaluationResult} from '@eval/workflows/answer-review';
import {loadConfig,type HostConfig} from './config.js';
import {configurationSecrets,readSettings} from './settings.js';
import {ROOT} from './paths.js';

interface Configuration {
  archiveDirectory:string;inputDirectory:string;dataStateDirectory:string;stateDirectory:string;outputDirectory:string;
  hostConfigs:string[];settingsFile:string;logDirectory:string;logLockDirectory:string;
  python:string;pythonPath?:string;sevenZip:string;engine:'pi'|'prime';stableSeconds:number;stableTimeoutSeconds:number;concurrency?:number;pollSeconds:number;
}
function configuration(value:Record<string,unknown>,directory:string):Configuration{
  const located=(key:string)=>{const item=value[key];if(typeof item!=='string'||!item.trim())throw Error('Missing '+key);return path.resolve(directory,item);};
  const c={archiveDirectory:located('archiveDirectory'),inputDirectory:located('inputDirectory'),dataStateDirectory:located('dataStateDirectory'),
    stateDirectory:located('stateDirectory'),outputDirectory:located('outputDirectory'),settingsFile:located('settingsFile'),
    logDirectory:located('logDirectory'),logLockDirectory:located('logLockDirectory'),hostConfigs:[] as string[],
    python:typeof value.python==='string'?value.python:'python3',pythonPath:value.pythonPath?located('pythonPath'):undefined,
    sevenZip:typeof value.sevenZip==='string'?value.sevenZip:'7z',engine:value.engine??'pi',stableSeconds:value.stableSeconds??3,
    stableTimeoutSeconds:value.stableTimeoutSeconds??30,concurrency:value.concurrency,pollSeconds:value.pollSeconds??60} as Configuration;
  if(!Array.isArray(value.hostConfigs)||!value.hostConfigs.length||value.hostConfigs.some(v=>typeof v!=='string'))throw Error('hostConfigs must list the existing AIME Host configuration files');
  c.hostConfigs=value.hostConfigs.map(v=>path.resolve(directory,String(v)));
  if(!['pi','prime'].includes(c.engine)||!Number.isFinite(c.stableSeconds)||c.stableSeconds<=0||c.stableTimeoutSeconds<=c.stableSeconds)throw Error('Invalid engine or stability interval');
  if(c.concurrency!==undefined&&(!Number.isSafeInteger(c.concurrency)||c.concurrency<1))throw Error('Invalid concurrency');
  if(!Number.isSafeInteger(c.pollSeconds)||c.pollSeconds<1)throw Error('Invalid pollSeconds');
  if(c.outputDirectory!==path.join(path.dirname(c.inputDirectory),'eval_output','0_daily_eval'))throw Error('正式结果必须位于同一AIME来源的eval_output/0_daily_eval');
  return c;
}

async function command(executable:string,args:string[],env:NodeJS.ProcessEnv,signal:AbortSignal){
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:ROOT,env,signal,stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr!.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-8192);});
    child.once('error',reject);child.once('close',(code,stopped)=>code===0?resolve():reject(Error(`${executable} exited ${code??stopped}: ${stderr}`)));
  });
}

function scopedHost(base:HostConfig,job:AimeJob,concurrency:number):HostConfig{
  const host=structuredClone(base),models=new Set(job.records.map(r=>r.model));host.workflow='answer-review';
  host.evaluation.inputs={timing_unit:base.evaluation.inputs.timing_unit,
    versions:base.evaluation.inputs.versions.filter(v=>models.has(v.id)).map(v=>({...v,
      sources:[...new Set(job.records.filter(r=>r.model===v.id).map(r=>r.input_file))].map(file=>({kind:'file' as const,path:file}))})),
    records:job.records.map(r=>({model:r.model,batch_id:r.batch_id,case_id:r.case_id,trace_id:r.trace_id,input_file:r.input_file,input_index:r.input_index}))};
  if(host.evaluation.inputs.versions.length!==models.size)throw Error('AIME模型组未在当前配置登记');
  host.evaluation.output={kind:'directory',path:path.dirname(job.output)};host.evaluation.comparisons=[];
  host.evaluation.rewrite={attribution:false,comparison:false,clustering:false};host.evaluation.clustering.enabled=false;
  host.evaluation.standardAnswerReview=false;delete host.evaluation.prediction;delete host.evaluation.reviewQuestions;
  host.evaluation.execution.concurrency=concurrency;return host;
}

async function main(){
  const {values}=parseArgs({options:{config:{type:'string'},watch:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log('npm run aime:ingest-and-attribute -- --config /absolute/path/config.json [--watch]\n默认单次扫描评测后退出；--watch持续处理新包，每轮完成后按pollSeconds再次扫描。Ctrl+C停止并保留进度。');return;}
  if(!values.config)throw Error('--config is required');
  const c=configuration(await readJson<Record<string,unknown>>(values.config),path.dirname(path.resolve(values.config)));
  process.env.EVAL_CONFIG_FILE=c.settingsFile;process.env.EVAL_LOG_DIR=c.logDirectory;process.env.EVAL_LOG_LOCK_DIR=c.logLockDirectory;
  const logger=createFileLogger({directory:c.logDirectory,lockDirectory:c.logLockDirectory});
  const controller=new AbortController(),stop=()=>controller.abort(Error('AIME run interrupted'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let release:(()=>Promise<void>)|undefined;
  try{
    release=await runLock(c.stateDirectory);
    const settings=await readSettings(c.settingsFile);
    const bypass=[settings.environment.no_proxy||settings.environment.NO_PROXY||process.env.no_proxy||process.env.NO_PROXY,
      '127.0.0.1','localhost','::1'].filter(Boolean).join(',');
    settings.environment.no_proxy=bypass;settings.environment.NO_PROXY=bypass;
    const base=await loadConfig(c.hostConfigs,settings);logger.addSecrets(...configurationSecrets());
    const stateFile=path.join(c.stateDirectory,'state.json');
    const helper=path.join(ROOT,'server_dashboard_ths/aime_ingest_once.py');
    const env={...process.env,...(c.pythonPath?{PYTHONPATH:[c.pythonPath,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)}:{})};
    const invoke=async(operation:'scan'|'process',output:string,namesFile?:string)=>{
      const args=[helper,operation,'--archive-dir',c.archiveDirectory,'--input-dir',c.inputDirectory,'--data-state',c.dataStateDirectory,
        '--validator',path.join(ROOT,'dist/apps/host/src/aime-validate-inputs.js'),'--node',process.execPath,'--seven-zip',c.sevenZip,
        '--stable-seconds',String(c.stableSeconds),'--timeout-seconds',String(c.stableTimeoutSeconds),'--output',output,
        ...(namesFile?['--names-file',namesFile]:[])];
      await command(c.python,args,env,controller.signal);
    };
    const cycle=async()=>{
    const summary=await runAimeIncremental({output:c.outputDirectory,concurrency:c.concurrency??base.evaluation.execution.concurrency,signal:controller.signal},{
      load:async()=>await exists(stateFile)?readJson<AimeIncrementalState>(stateFile):undefined,
      save:state=>writeJson(stateFile,state),
      async scan(){const file=path.join(c.stateDirectory,'scan.json');await invoke('scan',file);const snapshot=await readJson<any>(file);
        await logger.event('aime_scan',{component:'aime-ingest',scanned:snapshot.scanned_archives,new:snapshot.new_archives,updated:snapshot.updated_archives});
        console.log(`发现 ${snapshot.scanned_archives} 个包：新增 ${snapshot.new_archives}，更新 ${snapshot.updated_archives}，待重试 ${snapshot.retry_archives}`);return snapshot;},
      async clean(scan){const directory=path.join(c.stateDirectory,'ingestions',scan.id),namesFile=path.join(directory,'archives.json'),file=path.join(directory,'report.json');
        await writeJson(namesFile,scan.names);await invoke('process',file,namesFile);const report=await readJson<AimeCleaningReport>(file);
        await logger.event('aime_cleaned',{component:'aime-ingest',scan_id:scan.id,archives:scan.names,accepted:report.reports.reduce((n,r)=>n+r.accepted,0),excluded:report.reports.reduce((n,r)=>n+r.excluded,0)});
        return {file,report};},
      async evaluate(job,concurrency,signal){
        const host=scopedHost(base,job,concurrency),file=path.join(job.output,'state.json');let launched=job.records.length;
        const traceIds=new Set(job.records.map(r=>r.trace_id));
        if(await exists(file)){
          await appendAnswerReviewAttribution(job.output,{...host.evaluation,workflow:'answer-review',reviewStages:['attribution']});
          const state=await answerReviewRepository.readRun(job.output);launched=state.manifest.tasks.filter(t=>t.stage==='attribution'&&traceIds.has((t.data as any).candidate.trace_id)&&!state.receipts[t.id]).length;
          if(launched&&values.watch){
            const eligible=await prepareAnswerReviewAutomaticResume(job.output,traceIds);
            host.evaluation.inputs.records=host.evaluation.inputs.records!.filter(r=>eligible.has(r.trace_id!));launched=eligible.size;
          }else if(launched){const renewed=await prepareAnswerReviewRetry(job.output,traceIds);if(renewed.length)await logger.event('aime_manual_retry',{component:'aime-ingest',run_id:job.id,renewed});}
        }else{
          const plan=await planAnswerReview({...host.evaluation,workflow:'answer-review',reviewStages:['attribution']});
          if(plan.tasks.length!==job.records.length||plan.tasks.some(t=>t.stage!=='attribution')||(plan.summary.issues as unknown[]).length)throw Error('新增回答范围校验未通过，拒绝启动部分或额外评测');
        }
        let code=0;
        if(launched){console.log(`开始 ${job.date}：${launched} 条 Attribution，并发上限 ${concurrency}`);
          const {runAnswerReviewCommand}=await import('./answer-review-command.js');
          try{code=await runAnswerReviewCommand(host,{command:'run',runId:job.id,engine:c.engine,stage:'attribution',signal});}
          catch(error){await logger.error(error,{component:'aime-ingest',event:'attribution_start_failed',run_id:job.id});throw error;}}
        const state=await answerReviewRepository.readRun(job.output),selected=state.manifest.tasks.filter(t=>t.stage==='attribution'&&traceIds.has((t.data as any).candidate.trace_id)),failures=selected.filter(t=>!state.receipts[t.id]).map(t=>{
          const p=state.manifest.states[t.id],candidate=(t.data as any).candidate;
          return {task_id:t.id,trace_id:candidate.trace_id,case_id:candidate.case_id,model:candidate.version,status:p.status,reason:p.reason??p.failure?.errors??null};});
        return {launched,succeeded:selected.filter(t=>state.receipts[t.id]).length,failures,exit_code:code,output:path.join(job.output,'results/attribution.jsonl')} satisfies AimeEvaluationResult;
      },
    });
    await writeJson(path.join(c.stateDirectory,'last-report.json'),summary);
    await logger.event('aime_incremental_finished',{component:'aime-ingest',added:summary.added_records,launched:summary.attribution_started,succeeded:summary.attribution_succeeded,quarantined:summary.quarantined,exit_code:summary.exit_code});
    if(summary.no_new_data)console.log('无新增数据'+(summary.resumed_jobs?`；续跑 ${summary.resumed_jobs} 个未完成批次`:''));
    console.log(JSON.stringify(values.watch?{added:summary.added_records,launched:summary.attribution_started,succeeded:summary.attribution_succeeded,
      failed:summary.evaluation_failures.length,quarantined:summary.quarantined,outputs:summary.outputs,report:path.join(c.stateDirectory,'last-report.json')}:summary,null,2));
    return summary;
    };
    if(values.watch){
      await logger.event('aime_watch_started',{component:'aime-ingest',concurrency:c.concurrency??base.evaluation.execution.concurrency,poll_seconds:c.pollSeconds});
      await runAimeWatch({pollMs:c.pollSeconds*1000,signal:controller.signal},{run:cycle,
        status:status=>writeJson(path.join(c.stateDirectory,'watch.json'),{...status,pid:process.pid,concurrency:c.concurrency??base.evaluation.execution.concurrency}),
        error:error=>logger.error(error,{component:'aime-ingest',event:'aime_cycle_failed'}),
      });
      await logger.event('aime_watch_stopped',{component:'aime-ingest'});process.exitCode=controller.signal.aborted?130:0;
    }else process.exitCode=(await cycle()).exit_code;
  }catch(error){await logger.error(error,{component:'aime-ingest',event:'aime_incremental_failed'});console.error(String(error));process.exitCode=controller.signal.aborted?130:2;}
  finally{await release?.();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
await main();
