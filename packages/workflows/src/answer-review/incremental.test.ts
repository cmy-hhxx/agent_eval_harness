import test from 'node:test';
import assert from 'node:assert/strict';
import {runAimeIncremental,type AimeIncrementalDependencies,type AimeIncrementalState,type AimeRecord,type AimeCleaningReport} from './incremental.js';
const record=(id:string,date='2026-10-23'):AimeRecord=>({model:'aime_fast',batch_id:date,case_id:id,trace_id:id,date,input_file:`/source/aime_fast/${date}.jsonl`,input_index:0,original_file:'batch.7z/data.jsonl',original_line:1,original_item:1});
const signature=(mtime_ns='1')=>({name:'batch.7z',size:100,mtime_ns});
const report=(records:AimeRecord[],mtime_ns='1'):AimeCleaningReport=>({reports:[{archive:'batch.7z',recovered:false,signature:signature(mtime_ns),read:records.length,accepted:records.length,excluded:0,records,exclusions:[],file_errors:[],error:null}],deferred:[]});
const options=()=>({output:'/source/eval_output/0_daily_eval',concurrency:2,signal:new AbortController().signal});
function fixture(){let state:AimeIncrementalState|undefined;let discover=true;const accepted=new Set<string>();
 const calls:string[]=[],deps:AimeIncrementalDependencies={load:async()=>state&&structuredClone(state),save:async value=>{state=structuredClone(value);},
  scan:async()=>({scanned_archives:1,new_archives:Number(discover),updated_archives:0,retry_archives:0,names:discover?['batch.7z']:[],archives:discover?[signature()]:[]}),
  clean:async()=>{discover=false;return {report:report([record('one')]),file:'/state/report.json'};},
  evaluate:async job=>{calls.push(job.id);const launched=job.records.filter(r=>!accepted.has(r.trace_id)).length;job.records.forEach(r=>accepted.add(r.trace_id));return {launched,succeeded:job.records.length,failures:[],exit_code:0,output:job.output};}};
 return {deps,calls,getState:()=>state!,setState:(s:AimeIncrementalState)=>{state=s;},setDiscovery:(v:boolean)=>{discover=v;}};
}
test('one scan commits exact new input scope, waits for evaluation, and exits without polling',async()=>{
 const f=fixture();let finish!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r),held=new Promise<void>(r=>finish=r);
 f.deps.evaluate=async(job,concurrency)=>{assert.equal(f.getState().jobs[0].id,job.id);assert.equal(concurrency,1);started();await held;return {launched:1,succeeded:1,failures:[],exit_code:0,output:job.output};};
 let settled=false;const promise=runAimeIncremental(options(),f.deps).then(r=>{settled=true;return r;});await began;assert.equal(settled,false);finish();
 const result=await promise;assert.equal(result.added_records,1);assert.equal(result.attribution_started,1);assert.equal(result.exit_code,0);
 f.deps.evaluate=async()=>{throw Error('empty evaluation must not start')};const repeated=await runAimeIncremental(options(),f.deps);assert.equal(repeated.no_new_data,true);assert.equal(repeated.attribution_started,0);
});
test('publication survives a process interruption before evaluation and failed jobs keep their durable run ID',async()=>{
 const f=fixture();let attempts=0;f.deps.evaluate=async job=>{f.calls.push(job.id);attempts++;return {launched:1,succeeded:attempts===1?0:1,failures:attempts===1?['timeout']:[],exit_code:attempts===1?2:0,output:job.output};};
 const first=await runAimeIncremental(options(),f.deps);assert.equal(first.exit_code,2);const second=await runAimeIncremental(options(),f.deps);
 assert.equal(second.exit_code,0);assert.equal(second.resumed_jobs,1);assert.equal(f.calls[0],f.calls[1]);assert.equal(f.getState().scans.length,1);
});
test('a same-name newer archive is processed after recovering the older frozen publication',async()=>{
 const f=fixture();f.setState({scans:[{id:'old-scan',names:['batch.7z'],cleaned:false}],jobs:[]});
 f.deps.scan=async()=>({scanned_archives:1,new_archives:0,updated_archives:1,retry_archives:0,names:['batch.7z'],archives:[signature('2')]});
 f.deps.clean=async scan=>{const value=report([record(scan.id==='old-scan'?'old':'new')],scan.id==='old-scan'?'1':'2');value.reports[0].recovered=scan.id==='old-scan';return {report:value,file:'/state/'+scan.id};};
 const result=await runAimeIncremental(options(),f.deps);assert.equal(result.added_records,2);assert.equal(result.updated_archives,1);assert.equal(f.getState().jobs.length,1);assert.equal(result.attribution_started,2);
});
test('one fixed output per day grows when an older date receives more data',async()=>{
 const f=fixture();f.deps.clean=async()=>({report:report([record('old19','2026-10-19'),record('old20','2026-10-20')]),file:'/state/first.json'});
 await runAimeIncremental(options(),f.deps);assert.deepEqual(f.getState().jobs.map(j=>j.output),['/source/eval_output/0_daily_eval/1019','/source/eval_output/0_daily_eval/1020']);
 f.deps.scan=async()=>({scanned_archives:1,new_archives:0,updated_archives:1,retry_archives:0,names:['batch.7z'],archives:[signature('2')]});
 f.deps.clean=async()=>({report:report([{...record('new19','2026-10-19'),input_index:1}],'2'),file:'/state/second.json'});
 const update=await runAimeIncremental(options(),f.deps);
 assert.equal(update.attribution_started,1);assert.equal(f.getState().jobs.length,2);assert.equal(f.getState().jobs[0].records.length,2);assert.equal(f.getState().jobs[0].id,'1019');
});
test('duplicates, quarantine and unstable archives are reported without an empty model job',async()=>{
 const f=fixture(),r=report([]);r.reports[0].read=3;r.reports[0].exclusions=[{reason:'duplicate_trace'},{reason:'multiple_traces_not_supported'},{reason:'aime_mode_conflict'}];r.reports[0].excluded=3;r.deferred=[{archive:'growing.7z',reason:'archive_not_stable'}];
 f.deps.clean=async()=>({report:r,file:'/state/quarantine.json'});const result=await runAimeIncremental(options(),f.deps);
 assert.equal(result.duplicates,1);assert.equal(result.quarantined,2);assert.equal(result.exit_code,2);assert.equal(result.attribution_started,0);assert.equal(f.calls.length,0);
});
test('historical normalized inputs are backfilled without new archives and missing stages are checked on startup',async()=>{
 const f=fixture();f.setDiscovery(false);f.deps.existingRecords=async()=>[record('historical')];
 const first=await runAimeIncremental({...options(),refreshCompleted:true},f.deps);
 assert.equal(first.backfilled_records,1);assert.equal(first.added_records,0);assert.equal(f.calls.length,1);
 const second=await runAimeIncremental(options(),f.deps);assert.equal(second.backfilled_records,0);assert.equal(f.calls.length,1);
 await runAimeIncremental({...options(),refreshCompleted:true},f.deps);assert.equal(f.calls.length,2,'one startup reconciliation can add a missing stage to a completed day');
});
test('pause after scanning prevents new cleaning and evaluation without cancelling accepted work',async()=>{
 const f=fixture(),pause=new AbortController(),scan=f.deps.scan;
 f.deps.scan=async()=>{const result=await scan();pause.abort();return result;};
 f.deps.clean=async()=>{throw Error('paused cleaning must not start');};
 const result=await runAimeIncremental({...options(),pauseSignal:pause.signal},f.deps);
 assert.equal(result.processed_archives,0);assert.equal(f.calls.length,0);
});
