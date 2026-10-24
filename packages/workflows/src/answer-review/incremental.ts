import {randomUUID} from 'node:crypto';
import path from 'node:path';

export interface AimeRecord {
  model:string;batch_id:string;case_id:string;trace_id:string;date:string;input_file:string;input_index:number;
  original_file:string;original_line:number;original_item:number;
}
export interface AimeCleaningReport {
  reports:{archive:string;recovered:boolean;signature:{name:string;size:number;mtime_ns:string};read:number;accepted:number;excluded:number;records:AimeRecord[];
    exclusions:{reason:string;[key:string]:unknown}[];file_errors:unknown[];error:string|null}[];
  deferred:{archive:string;reason:string}[];
}
export interface AimeScan {id:string;names:string[];cleaned:boolean;report_file?:string}
export interface AimeEvaluationResult {launched:number;succeeded:number;failures:unknown[];exit_code:number;output:string}
export interface AimeJob {id:string;date:string;records:AimeRecord[];output:string;done:boolean;result?:AimeEvaluationResult}
export interface AimeIncrementalState {scans:AimeScan[];jobs:AimeJob[]}
export interface AimeIncrementalDependencies {
  load():Promise<AimeIncrementalState|undefined>;
  save(state:AimeIncrementalState):Promise<void>;
  scan():Promise<{scanned_archives:number;new_archives:number;updated_archives:number;retry_archives:number;names:string[];archives:{name:string;size:number;mtime_ns:string}[]}>;
  clean(scan:AimeScan):Promise<{report:AimeCleaningReport;file:string}>;
  evaluate(job:AimeJob,concurrency:number,signal:AbortSignal):Promise<AimeEvaluationResult>;
}

/** One frozen directory scan, bounded ingestion, then a finite queue of Attribution jobs. */
export async function runAimeIncremental(options:{output:string;concurrency:number;signal:AbortSignal},deps:AimeIncrementalDependencies){
  const state=await deps.load()??{scans:[],jobs:[]};
  let writes=Promise.resolve();
  const save=()=>{const snapshot=structuredClone(state);return writes=writes.then(()=>deps.save(snapshot));};
  const discovery=await deps.scan();
  const cleaning:AimeCleaningReport[]=[];
  const resumedIds=new Set(state.jobs.filter(j=>!j.done).map(j=>j.id)),reportFiles:string[]=[];
  const clean=async(scan:AimeScan)=>{
    options.signal.throwIfAborted();
    const {report,file}=await deps.clean(scan);cleaning.push(report);reportFiles.push(file);
    const grouped=new Map<string,AimeRecord[]>(),identities=new Set(state.jobs.flatMap(j=>j.records.map(r=>r.trace_id)));
    for(const record of report.reports.flatMap(r=>r.records)){
      if(!record.trace_id||identities.has(record.trace_id))throw Error('清洗返回重复或缺失的trace_id：'+record.trace_id);
      identities.add(record.trace_id);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(record.date))throw Error('清洗返回无效业务日期');
      const rows=grouped.get(record.date)??[];rows.push(record);grouped.set(record.date,rows);
    }
    for(const [date,records] of grouped){
      const job=state.jobs.find(j=>j.date===date);
      if(job){job.records.push(...records);job.done=false;}
      else{const id=date.slice(5).replace('-','');state.jobs.push({id,date,records,output:path.join(options.output,id),done:false});}
    }
    scan.cleaned=true;scan.report_file=file;
    // Selection and the durable run IDs are committed together, before any model is started.
    await save();
  };
  // Recover interrupted publications first, then process any newer revision in this invocation's frozen scan.
  for(const scan of state.scans.filter(s=>!s.cleaned))await clean(scan);
  const resolved=new Map(cleaning.flatMap(c=>c.reports.map(r=>[r.archive,r] as const)));
  const deferredThisScan=new Set(cleaning.flatMap(c=>c.deferred.filter(d=>d.reason!=='archive_replaced_before_publication').map(d=>d.archive)));
  const names=discovery.archives.filter(a=>{const old=resolved.get(a.name);return !deferredThisScan.has(a.name)&&(!old||old.recovered&&(old.signature.size!==a.size||old.signature.mtime_ns!==a.mtime_ns));}).map(a=>a.name);
  if(names.length){const scan={id:randomUUID(),names,cleaned:false};state.scans.push(scan);await save();await clean(scan);}
  const pending=state.jobs.filter(j=>!j.done),results:AimeEvaluationResult[]=[];
  const width=Math.min(options.concurrency,pending.length);
  let cursor=0;
  await Promise.all(Array.from({length:width},(_,worker)=> (async()=>{
    const capacity=Math.floor(options.concurrency/width)+Number(worker<options.concurrency%width);
    while(cursor<pending.length&&!options.signal.aborted){
      const job=pending[cursor++];let result:AimeEvaluationResult;
      try{result=await deps.evaluate(job,Math.min(capacity,job.records.length),options.signal);}
      catch(error){result={launched:0,succeeded:job.result?.succeeded??0,exit_code:options.signal.aborted?130:2,output:job.output,failures:[{error:String(error)}]};}
      job.result=result;job.done=result.exit_code===0&&result.succeeded===job.records.length&&result.failures.length===0;
      results.push(result);await save();
    }
  })()));
  await writes;
  const reports=cleaning.flatMap(c=>c.reports),exclusions=reports.flatMap(r=>r.exclusions),duplicates=exclusions.filter(r=>['duplicate_case','duplicate_trace'].includes(r.reason));
  const quarantine=exclusions.filter(r=>!duplicates.includes(r)),deferred=cleaning.flatMap(c=>c.deferred).filter(d=>!reports.some(r=>r.archive===d.archive&&!r.recovered));
  const archiveFailures=reports.filter(r=>r.error||r.file_errors.length).map(r=>({archive:r.archive,error:r.error,file_errors:r.file_errors}));
  const failures=results.flatMap(r=>r.failures);
  const output={...discovery,processed_archives:reports.length,read_records:reports.reduce((n,r)=>n+r.read,0),
    added_records:reports.reduce((n,r)=>n+r.records.length,0),duplicates:duplicates.length,quarantined:quarantine.length,
    quarantine,deferred,archive_failures:archiveFailures,cleaning_reports:reportFiles,
    input_files:[...new Set(reports.flatMap(r=>r.records.map(row=>row.input_file)))],
    attribution_started:results.reduce((n,r)=>n+r.launched,0),attribution_succeeded:results.reduce((n,r)=>n+r.succeeded,0),
    evaluation_failures:failures,outputs:results.map(r=>r.output),
    no_new_data:!reports.some(r=>r.records.length),resumed_jobs:pending.filter(j=>resumedIds.has(j.id)).length,
    exit_code:options.signal.aborted?130:quarantine.length||deferred.length||archiveFailures.length||failures.length||results.some(r=>r.exit_code!==0)?2:0};
  return output;
}
