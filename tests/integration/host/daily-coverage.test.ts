import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {AutomationState} from '@eval/automations';
import {writeJson} from '@eval/data';
import {fixtureConfig} from '../../fixtures/comparison.js';
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
