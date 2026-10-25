import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {emptyUsage,type RunState} from '@eval/contracts';
import type {AutomationState} from '@eval/automations';
import {readJson,writeJson} from '@eval/data';
import {planAnswerReview,answerReviewRepository,type AnswerReviewConfig} from '@eval/workflows/answer-review';
import {fixtureConfig,sessionRaw,fakeIdentity,fakeEvaluatorVersion} from '../../fixtures/comparison.js';
import {dailyPackageReport} from '../../../apps/host/src/daily-coverage.js';

test('package coverage joins exact identities, follows rewrites and requires a current Mongo receipt',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const archiveDirectory=path.join(f.directory,'archives'),date='2026-10-24',record={date,model:'a_fast',batch_id:date,case_id:'case-1',trace_id:'real-trace'},
    report={archive_path:path.join(archiveDirectory,'batch.7z'),section:'records',items:[record],total:1,page:1,page_size:50};
  t.mock.method(globalThis,'fetch',async(input:unknown)=>Response.json(new URL(String(input)).pathname==='/data/workbench/catalog'?{tasks:[{dataset:'/data/wencai',archive_dir:archiveDirectory}]}:report));
  const receipt={acceptedAt:1,exported:{file:'comparison.jsonl'}};
  const checkpoint={runId:'daily',inputs:{input:{version:'a_fast',batch_id:date,case_id:'case-1',trace_id:'real-trace'}},config:{rewrite:{comparison:true}},
    tasks:{criteria:{stage:'criteria',status:'succeeded',inputIds:{A:'input'},dependencies:{},data:{},receipt},
      attribution:{stage:'attribution',status:'succeeded',inputIds:{A:'input'},dependencies:{},data:{},receipt},
      comparison:{stage:'comparison',status:'succeeded',inputIds:{A:'input'},dependencies:{criteria:'criteria',attribution:'attribution'},data:{comparisonId:'pair'},receipt},
      rewrite:{stage:'rewrite',status:'pending',inputIds:{},dependencies:{source:'comparison'},data:{rewriteOf:{stage:'comparison',taskId:'comparison',resultId:'pair'}},receipt:undefined as typeof receipt|undefined}}};
  const state={jobs:{[date]:{date,runIds:['daily'],inputsUpdatedAt:10,summary:{readyComparisons:1},mongo:{status:'completed',synced:{inputsUpdatedAt:10,comparisons:1}}}}} as unknown as AutomationState;
  const options={sourceUrl:'http://data.test/data/wencai',source:'wencai' as const,output:path.join(f.directory,'output'),automationState:state};
  await writeJson(path.join(options.output,'daily/state.json'),checkpoint);
  let page=await dailyPackageReport(options,'package',new URLSearchParams());
  assert.equal(page.items[0].coverage.stages.rewrite.pending,1);assert.equal(page.items[0].coverage.mongoStatus,'pending');
  checkpoint.tasks.rewrite.status='succeeded';checkpoint.tasks.rewrite.receipt=receipt;await writeJson(path.join(options.output,'daily/state.json'),checkpoint);
  page=await dailyPackageReport(options,'package',new URLSearchParams());assert.equal(page.items[0].coverage.stages.rewrite.completed,1);assert.equal(page.items[0].coverage.mongoStatus,'completed');
  state.jobs[date].inputsUpdatedAt=11;page=await dailyPackageReport(options,'package',new URLSearchParams());assert.equal(page.items[0].coverage.mongoStatus,'pending');
  record.trace_id='another-trace';page=await dailyPackageReport(options,'package',new URLSearchParams());assert.deepEqual(page.items[0].coverage.runIds,[]);
  record.trace_id='real-trace';
  record.model='a_expert';page=await dailyPackageReport(options,'package',new URLSearchParams());assert.deepEqual(page.items[0].coverage.runIds,[]);assert.deepEqual(page.items[0].coverage.stages,{});
  record.model='a_fast';report.section='exclusions';
  const excluded=await dailyPackageReport(options,'package',new URLSearchParams({section:'exclusions'}));assert.deepEqual(excluded,report);
  await assert.rejects(dailyPackageReport({...options,sourceUrl:'http://data.test/data/aime'},'package',new URLSearchParams()),/不属于此日常来源/);
});

test('AIME report keeps historical Attribution coverage and marks its missing Score as pending',async t=>{
  const row={...sessionRaw('one'),batch_id:'2026-10-24'},f=await fixtureConfig([[row as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const config:AnswerReviewConfig={...f.config,workflow:'answer-review',reviewStages:['attribution'],inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}},plan=await planAnswerReview(config);
  const task=plan.tasks[0],candidate=(task.data as any).candidate,output=path.join(f.directory,'output'),run=path.join(output,'1024');
  const state:RunState={manifest:{runId:'1024',format:'evaluation-run',status:'interrupted',debug:false,engine:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,config,
    tasks:plan.tasks,states:{[task.id]:{status:'failed',attempts:2}},inputs:{},inputCatalog:plan.catalog,startedAt:1,preflight:plan.summary},receipts:{},usage:emptyUsage(),recordedAttempts:2};
  await answerReviewRepository.writeRun(run,state);
  const archiveDirectory=path.join(f.directory,'archives'),record={date:'2026-10-24',model:candidate.version,batch_id:candidate.batch_id,case_id:candidate.case_id,trace_id:candidate.trace_id};
  t.mock.method(globalThis,'fetch',async(input:unknown)=>Response.json(new URL(String(input)).pathname==='/data/workbench/catalog'?{tasks:[{dataset:'/data/aime',archive_dir:archiveDirectory}]}:
    {archive_path:path.join(archiveDirectory,'batch.7z'),section:'records',items:[record]}));
  const page=await dailyPackageReport({sourceUrl:'http://data.test/data/aime',source:'aime',output},'package',new URLSearchParams());
  assert.deepEqual(page.items[0].coverage.runIds,['1024']);assert.equal(page.items[0].coverage.stages.attribution.failed,1);assert.equal(page.items[0].coverage.stages.score.pending,1);
  assert.equal(Object.hasOwn(page.items[0].coverage,'mongoStatus'),false);
  const saved=await readJson<any>(path.join(run,'state.json'));
  saved.tasks.final={task:{stage:'score',inputIds:{case:candidate.input_id},dependencies:{attribution:task.id}},data:{input_id:candidate.input_id},state:{status:'pending',attempts:0}};
  await writeJson(path.join(run,'state.json'),saved);
  const inProgress=await dailyPackageReport({sourceUrl:'http://data.test/data/aime',source:'aime',output},'package',new URLSearchParams());
  assert.deepEqual(inProgress.items[0].coverage.stages.score,{total:1,completed:0,failed:0,pending:1,running:0});
  saved.tasks.final.state={status:'succeeded',attempts:1};saved.tasks.final.receipt={taskId:'final',exported:{id:'final',file:'score.jsonl'}};
  await writeJson(path.join(run,'state.json'),saved);
  const completed=await dailyPackageReport({sourceUrl:'http://data.test/data/aime',source:'aime',output},'package',new URLSearchParams());
  assert.deepEqual(completed.items[0].coverage.stages.score,{total:1,completed:1,failed:0,pending:0,running:0},'report reads only compact references, without opening formal result bodies');
  const repeated=structuredClone(saved);repeated.manifest.runId='again';repeated.tasks.final.state.status='failed';delete repeated.tasks.final.receipt;
  await writeJson(path.join(output,'again/state.json'),repeated);
  const stateDirectory=path.join(f.directory,'queue');await writeJson(path.join(stateDirectory,'state.json'),{jobs:[{id:'1024',date:record.date},{id:'1024',date:record.date},{id:'again',date:record.date}],scans:[]});
  const deduplicated=await dailyPackageReport({sourceUrl:'http://data.test/data/aime',source:'aime',output,aime:{configuration:{stateDirectory}} as any},'package',new URLSearchParams());
  assert.deepEqual(deduplicated.items[0].coverage.runIds,['1024','again']);
  assert.deepEqual(deduplicated.items[0].coverage.stages.score,{total:1,completed:1,failed:0,pending:0,running:0});
});

test('one report page joins a large day run within its page latency budget',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'daily-coverage-page-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const date='2026-10-24',output=path.join(directory,'output'),archiveDirectory=path.join(directory,'archives'),
    inputs:Record<string,unknown>={},tasks:Record<string,unknown>={},receipt={acceptedAt:1,exported:{file:'attribution.jsonl'}};
  for(let index=0;index<20000;index++){
    const id='input-'+index;inputs[id]={version:'a_fast',batch_id:date,case_id:'case-'+index};
    tasks['criteria-'+index]={stage:'criteria',status:'succeeded',inputIds:{A:id},dependencies:{},data:{},receipt};
    tasks['attribution-'+index]={stage:'attribution',status:'succeeded',inputIds:{A:id},dependencies:{criteria:'criteria-'+index},data:{},...(index===1?{}:{receipt})};
    tasks['rewrite-'+index]={stage:'rewrite',status:'pending',inputIds:{},dependencies:{source:'attribution-'+index},data:{rewriteOf:{stage:'attribution',taskId:'attribution-'+index}}};
  }
  await writeJson(path.join(output,'daily/state.json'),{runId:'daily',inputs,tasks,config:{rewrite:{comparison:true}}});
  const records=Array.from({length:50},(_,index)=>({date,model:'a_fast',batch_id:date,case_id:'case-'+index,
    original_file:'batch.7z/member.jsonl',original_line:index+1}));
  t.mock.method(globalThis,'fetch',async(input:unknown)=>Response.json(new URL(String(input)).pathname==='/data/workbench/catalog'
    ?{tasks:[{dataset:'/data/wencai',archive_dir:archiveDirectory}]}
    :{archive_path:path.join(archiveDirectory,'batch.7z'),section:'records',items:records,total:20000,page:1,page_size:50}));
  const started=performance.now(),page=await dailyPackageReport({source:'wencai',sourceUrl:'http://data.test/data/wencai',output,
    automationState:{jobs:{[date]:{date,runIds:['daily'],summary:{readyComparisons:0}}}} as unknown as AutomationState},'package',new URLSearchParams());
  const elapsed=performance.now()-started;t.diagnostic(`50 report rows joined 60000 day tasks in ${Math.round(elapsed)}ms`);
  assert.equal(page.items.length,50);assert.deepEqual(page.items[0].coverage.runIds,['daily']);
  assert.equal(page.items[0].coverage.stages.attribution.completed,1);assert.equal(page.items[1].coverage.stages.attribution.failed,1);
  assert.equal(page.items[0].coverage.stages.rewrite.pending,1);assert.equal(page.items[49].original_line,50);
  assert(elapsed<1500,'a report page must not repeatedly scan every task for each visible row');
});
