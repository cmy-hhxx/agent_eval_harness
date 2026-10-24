import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {emptyUsage,type RunState} from '@eval/contracts';
import type {AutomationState} from '@eval/automations';
import {writeJson} from '@eval/data';
import {planAnswerReview,answerReviewRepository,type AnswerReviewConfig} from '@eval/workflows/answer-review';
import {fixtureConfig,sessionRaw,fakeIdentity,fakeEvaluatorVersion} from '../../fixtures/comparison.js';
import {dailyPackageReport} from '../../../apps/host/src/daily-coverage.js';

test('package coverage joins exact identities, follows rewrites and requires a current Mongo receipt',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const archiveDirectory=path.join(f.directory,'archives'),date='2026-10-24',record={date,model:'a_fast',batch_id:date,case_id:'case-1'},
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
  record.model='a_expert';page=await dailyPackageReport(options,'package',new URLSearchParams());assert.deepEqual(page.items[0].coverage.runIds,[]);assert.deepEqual(page.items[0].coverage.stages,{});
  record.model='a_fast';report.section='exclusions';
  const excluded=await dailyPackageReport(options,'package',new URLSearchParams({section:'exclusions'}));assert.deepEqual(excluded,report);
  await assert.rejects(dailyPackageReport({...options,sourceUrl:'http://data.test/data/aime'},'package',new URLSearchParams()),/不属于此日常来源/);
});

test('AIME report keeps historical Attribution coverage and marks its missing Score as pending',async t=>{
  const row={...sessionRaw('one'),batch_id:'2026-10-24'},f=await fixtureConfig([[row as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const config:AnswerReviewConfig={...f.config,workflow:'answer-review',reviewStages:['attribution'],comparisons:[],inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}},plan=await planAnswerReview(config);
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
});
