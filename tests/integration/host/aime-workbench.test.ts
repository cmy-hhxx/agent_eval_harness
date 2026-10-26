import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,readdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {ensureClusterPlaceholder,writeJson,runLock} from '@eval/data';
import {fixtureConfig} from '../../fixtures/comparison.js';
import {ROOT} from '../../fixtures/services.js';
import {loadAimeWorkbench} from '../../../apps/host/src/aime-workbench.js';

test('AIME daily run creates date-local cluster placeholders without replacing existing clustering output',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'aime-cluster-')),run=path.join(directory,'2026-10-24');t.after(()=>rm(directory,{recursive:true,force:true}));
  await ensureClusterPlaceholder(run);
  assert.deepEqual((await readdir(path.join(run,'cluster'))).sort(),['cluster_tree.jsonl','state.json']);
  assert.equal(await readFile(path.join(run,'cluster','cluster_tree.jsonl'),'utf8'),'');
  assert.deepEqual(JSON.parse(await readFile(path.join(run,'cluster','state.json'),'utf8')),{});
  await writeFile(path.join(run,'cluster','cluster_tree.jsonl'),'{"level":0}\n');
  await ensureClusterPlaceholder(run);
  assert.equal(await readFile(path.join(run,'cluster','cluster_tree.jsonl'),'utf8'),'{"level":0}\n');
});

test('AIME Workbench persists independent settings and refuses an existing CLI owner without taking its lock',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const overlay=path.join(f.directory,'models.json');await writeJson(overlay,{models:{judge:{model:'fixture',thinking:'low'}}});
  const file=path.join(f.directory,'aime.json'),stateDirectory=path.join(f.directory,'aime-state');
  await writeJson(file,{archiveDirectory:path.join(f.directory,'archives'),inputDirectory:path.join(f.directory,'2_daily_eval_input'),
    outputDirectory:path.join(f.directory,'eval_output/0_daily_eval'),dataStateDirectory:path.join(f.directory,'data-state'),stateDirectory,
    hostConfigs:[path.join(ROOT,'configs/host.json'),path.join(ROOT,'configs/answer-review.json'),overlay],
    settingsFile:path.join(f.directory,'config.ini'),logDirectory:path.join(f.directory,'log'),logLockDirectory:path.join(f.directory,'log-lock'),concurrency:64});
  const aime=await loadAimeWorkbench(file),initial=await aime.snapshot();
  assert.equal(initial.workflow,'answer-review');assert.equal(initial.concurrency,64);assert.deepEqual(Object.keys(initial.settings.bindings),['score','attribution','instruction-review']);
  assert.equal(Object.hasOwn(initial.settings,'rewrite'),false);assert.deepEqual((await aime.runs()).runs,[]);
  await aime.setSettings({debug:true,execution:{repairAttempts:2,maxTaskAttempts:8,retryDelaySeconds:3},bindings:{score:{thinking:'high'}}});
  await aime.setConcurrency(16);
  const restored=await loadAimeWorkbench(file),snapshot=await restored.snapshot();
  assert.equal(snapshot.settings.debug,true);assert.equal(snapshot.settings.execution.repairAttempts,2);
  assert.equal(snapshot.settings.bindings.score.thinking,'high');assert.equal(snapshot.concurrency,16);
  assert.equal(snapshot.settings.execution.maxTaskAttempts,8,'a concurrency-only patch retains the existing task cap');
  const cleared=await aime.setSettings({execution:{maxTaskAttempts:null}});
  assert.equal(cleared.settings.execution.maxTaskAttempts,initial.settings.execution.maxTaskAttempts);
  assert.equal(cleared.settings.execution.repairAttempts,2);assert.equal(cleared.settings.execution.retryDelaySeconds,3);
  assert.equal(cleared.settings.bindings.score.thinking,'high');assert.equal(cleared.settings.debug,true);assert.equal(cleared.concurrency,16);
  const persisted=JSON.parse(await readFile(path.join(stateDirectory,'workbench-settings.json'),'utf8'));
  assert.equal(Object.hasOwn(persisted.execution,'maxTaskAttempts'),false,'null is a wire clear operation, never a saved budget');
  const reloaded=await loadAimeWorkbench(file);assert.equal((await reloaded.snapshot()).settings.execution.maxTaskAttempts,initial.settings.execution.maxTaskAttempts);
  await assert.rejects(aime.setSettings({execution:{timeoutSeconds:null}}),/timeoutSeconds/);
  await assert.rejects(aime.setSettings({bindings:{comparison:{thinking:'high'}}}),/Score、Attribution/);
  const release=await runLock(stateDirectory);
  assert.equal((await aime.runs()).retryAllowed,false,'an independent owner blocks preparation in the UI as well as the API');
  await assert.rejects(aime.run(new AbortController().signal),/另一个进程.*aime-auto/);
  await release();
  const ini=path.join(f.directory,'config.ini');await writeFile(ini,await readFile(ini,'utf8')+'\nmodels = fixture\n');
  await writeJson(overlay,{models:{judge:{model:'removed-model',thinking:'low'}}});
  assert.equal((await aime.snapshot()).settings.bindings.score.model,'removed-model','a stale model remains visible for repair');
  await assert.rejects(aime.run(new AbortController().signal),/not declared/);
  await aime.setSettings({bindings:{score:{model:'fixture'},attribution:{model:'fixture'},'instruction-review':{model:'fixture'}}});
  assert.equal((await aime.snapshot()).settings.bindings.score.model,'fixture');
  assert.equal((await aime.snapshot()).settings.bindings['instruction-review'].model,'fixture');
});

test('AIME daily coverage includes unplanned answers and historical formal runs while ignoring other workflows',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const file=path.join(f.directory,'aime.json'),stateDirectory=path.join(f.directory,'aime-state'),outputDirectory=path.join(f.directory,'eval_output/0_daily_eval');
  await writeJson(file,{archiveDirectory:path.join(f.directory,'archives'),inputDirectory:path.join(f.directory,'2_daily_eval_input'),outputDirectory,
    dataStateDirectory:path.join(f.directory,'data-state'),stateDirectory,hostConfigs:[path.join(ROOT,'configs/host.json'),path.join(ROOT,'configs/answer-review.json')],
    settingsFile:path.join(f.directory,'config.ini'),logDirectory:path.join(f.directory,'log'),logLockDirectory:path.join(f.directory,'log-lock'),concurrency:64});
  const record={model:'aime_fast',batch_id:'business',case_id:'one',trace_id:'true-trace',date:'2026-10-24',input_file:'aime_fast.jsonl',input_index:0,original_file:'input.7z/a.jsonl',original_line:1,original_item:0};
  const job={id:'1024',date:record.date,records:[record],done:false,output:path.join(outputDirectory,'1024'),result:undefined as {launched:number;succeeded:number}|undefined};
  await writeJson(path.join(stateDirectory,'state.json'),{scans:[],jobs:[job,structuredClone(job)]});
  await writeJson(path.join(outputDirectory,'unrelated/state.json'),{workflow:'wrong-workflow'});
  await writeJson(path.join(outputDirectory,'.archive/old/1023/state.json'),{workflow:'old-contract'});
  const aime=await loadAimeWorkbench(file),snapshot=await aime.snapshot();
  assert.deepEqual(snapshot.answerCounts,{total:1,completed:0,partial:0,pending:1,failed:0,running:0});
  assert.equal(snapshot.stages.score.pending,1);assert.equal(snapshot.stages.attribution.pending,1);
  assert.equal((await aime.runs()).runs.length,0,'registration can precede creation of the evaluation checkpoint');
  assert.equal((await aime.analytics()).totals.total,1);
  const historical={workflow:'answer-review',manifest:{runId:'saved-history',status:'finished',evaluatorVersion:'fixture'},
    inputs:{answer:{input_id:'answer',version:'aime_expert',batch_id:'2026-10-19',case_id:'historical-question',trace_id:'historical-trace',question:'earlier question'}},
    tasks:Object.fromEntries(['score','attribution'].map(stage=>{const id='historical-'+stage;return [id,{task:{stage,inputIds:{case:'answer'},dependencies:{}},data:{input_id:'answer'},
      state:{status:'succeeded',attempts:1},receipt:{taskId:id,exported:{id,file:stage+'.jsonl'}}}];})),usage:{},recordedAttempts:0};
  await writeJson(path.join(outputDirectory,'saved-history/state.json'),historical);
  const complete=await aime.snapshot(),history=(await aime.runs()).runs;
  assert.deepEqual(complete.answerCounts,{total:2,completed:1,partial:0,pending:1,failed:0,running:0},'historical checkpoints outside the current watch ledger remain in whole-source coverage');
  assert.equal(history.length,1);assert.equal(history[0].runId,'saved-history');
  assert.equal(history[0].date,'2026-10-19','the business date comes from input identities rather than the directory name');
  const analytics=await aime.analytics();
  assert.equal(analytics.dates.find(row=>row.date==='2026-10-19')?.completed,1);
  assert.equal(analytics.dates.find(row=>row.date==='2026-10-24')?.pending,1);
  await writeJson(path.join(stateDirectory,'state.json'),{scans:[],jobs:[job,{...job,id:'unrelated',records:[]}]});
  await assert.rejects(aime.analytics(),/不属于独立Score/,'a registered wrong workflow is an error, not an ignored extra directory');
  job.done=true;await writeJson(path.join(stateDirectory,'state.json'),{scans:[],jobs:[job]});
  await assert.rejects(aime.analytics(),/已执行运行的状态文件缺失/);
  job.done=false;job.result={launched:1,succeeded:0};
  await writeJson(path.join(stateDirectory,'state.json'),{scans:[],jobs:[job]});
  await assert.rejects(aime.analytics(),/已执行运行的状态文件缺失/,'an executed run with only failures cannot silently lose its progress and budgets');
  job.result=undefined;await writeJson(path.join(stateDirectory,'state.json'),{scans:[],jobs:[job]});
  await writeFile(path.join(outputDirectory,'saved-history/state.json'),'{');
  await assert.rejects(aime.analytics(),SyntaxError,'a malformed historical checkpoint cannot disappear from the reported totals');
});
