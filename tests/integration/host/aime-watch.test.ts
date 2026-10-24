import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {exists,readJson,writeJson} from '@eval/data';
import {fixtureConfig} from '../../fixtures/comparison.js';
import {ROOT} from '../../fixtures/services.js';
import {loadAimeConfiguration,runAimeEvaluation} from '../../../apps/host/src/aime-execution.js';

test('AIME watch scans again without model work, prevents duplicate owners, and stops cleanly while idle',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const state=path.join(f.directory,'state'),archives=path.join(f.directory,'archives'),input=path.join(f.directory,'input');
  await Promise.all([mkdir(archives),mkdir(input)]);
  const pythonPath=path.join(f.directory,'python');await mkdir(pythonPath);
  await writeFile(path.join(pythonPath,'py7zr.py'),
    'class SevenZipFile:\n    def __init__(self, *args, **kwargs):\n        raise AssertionError("An empty scan must not extract an archive")\n');
  const file=path.join(f.directory,'aime.json');
  await writeJson(file,{archiveDirectory:archives,inputDirectory:input,outputDirectory:path.join(f.directory,'eval_output/0_daily_eval'),
    dataStateDirectory:path.join(f.directory,'data-state'),stateDirectory:state,hostConfigs:[path.join(ROOT,'configs/host.json')],
    settingsFile:path.join(f.directory,'config.ini'),logDirectory:path.join(f.directory,'log'),logLockDirectory:path.join(f.directory,'log-lock'),
    pythonPath,concurrency:64,pollSeconds:1});
  const args=[path.join(ROOT,'dist/apps/host/src/aime-ingest-and-attribute.js'),'--config',file,'--watch'];
  const child=spawn(process.execPath,args,{cwd:ROOT,stdio:['ignore','pipe','pipe']});
  const ended=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  let status:any;
  for(let i=0;i<200;i++){
    if(child.exitCode!==null)assert.fail(output);
    if(await exists(path.join(state,'watch.json')))status=await readJson(path.join(state,'watch.json'));
    if(status?.cycles>=2&&status?.status==='waiting')break;
    await delay(50);
  }
  assert.equal(status?.status,'waiting',output);assert(status.cycles>=2,output);assert.equal(status.concurrency,64);
  const report=await readJson<any>(path.join(state,'last-report.json'));assert.equal(report.no_new_data,true);assert.equal(report.attribution_started,0);
  const duplicate=spawn(process.execPath,args,{cwd:ROOT,stdio:'ignore'});assert.deepEqual(await once(duplicate,'exit'),[2,null]);
  child.kill('SIGINT');assert.deepEqual(await ended,[130,null]);
  assert.equal((await readJson<any>(path.join(state,'watch.json'))).status,'stopped');assert.equal(await exists(path.join(state,'.run-lock')),false);
  assert.equal(await exists(path.join(f.directory,'eval_output/0_daily_eval')),false,'no empty evaluation output');
});

test('AIME pause sends a package-boundary signal and waits for the current cleaner to finish', {timeout:10_000}, async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const state=path.join(f.directory,'state'),started=path.join(f.directory,'first-started'),finished=path.join(f.directory,'first-finished'),python=path.join(f.directory,'fake-python.mjs');
  await writeFile(python,`#!${process.execPath}
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const operation=process.argv[3],output=process.argv[process.argv.indexOf('--output')+1];
await mkdir(path.dirname(output),{recursive:true});
let result;
if(operation==='scan')result={scanned_archives:2,new_archives:2,updated_archives:0,retry_archives:0,names:['first.7z','second.7z'],archives:['first.7z','second.7z'].map(name=>({name,size:1,mtime_ns:'1'}))};
else if(operation==='process'){
 let paused=false,release;const wait=new Promise(resolve=>release=resolve),keepAlive=setInterval(()=>{},1000);
 process.on('SIGUSR1',()=>{paused=true;release();});
 process.stdout.write('AIME_INGEST_READY\\n');
 await writeFile(${JSON.stringify(started)},'started');
 await wait;clearInterval(keepAlive);await new Promise(resolve=>setTimeout(resolve,30));
 await writeFile(${JSON.stringify(finished)},'finished');
 result={reports:[{archive:'first.7z',recovered:false,signature:{name:'first.7z',size:1,mtime_ns:'1'},read:0,accepted:0,excluded:0,records:[],exclusions:[],file_errors:[],error:null}],deferred:paused?[{archive:'second.7z',reason:'paused'}]:[]};
}else result={records:[],exclusions:[]};
await writeFile(output,JSON.stringify(result));
`,{mode:0o755});
  const file=path.join(f.directory,'aime.json');
  await writeJson(file,{archiveDirectory:path.join(f.directory,'archives'),inputDirectory:path.join(f.directory,'input'),outputDirectory:path.join(f.directory,'eval_output/0_daily_eval'),
    dataStateDirectory:path.join(f.directory,'data-state'),stateDirectory:state,hostConfigs:[path.join(ROOT,'configs/host.json')],settingsFile:path.join(f.directory,'config.ini'),
    logDirectory:path.join(f.directory,'log'),logLockDirectory:path.join(f.directory,'log-lock'),python,concurrency:64,pollSeconds:60});
  const stop=new AbortController(),pause=new AbortController();t.after(()=>stop.abort());
  const running=runAimeEvaluation(await loadAimeConfiguration(file),{signal:stop.signal,pauseSignal:pause.signal,watch:true});
  for(let count=0;count<200&&!await exists(started);count++)await delay(10);
  assert.equal(await exists(started),true);pause.abort();
  assert.equal(await running,0);assert.equal(await exists(finished),true,'pause lets the current package finish');
  const report=await readJson<any>(path.join(state,'last-report.json'));assert.equal(report.processed_archives,1);
  assert.deepEqual(report.deferred,[{archive:'second.7z',reason:'paused'}]);assert.equal(await exists(path.join(state,'.run-lock')),false);
});
