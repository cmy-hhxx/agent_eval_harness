import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rm, readFile, rename } from 'node:fs/promises';
import { emptyUsage, type RunState, type SubmissionReceipt, type AgentBackend } from '@eval/contracts';
import { writeJson, readJson, listRunArtifacts } from '@eval/data';
import { buildPlan, createResultWriter, writeRunState, readRunState, prepareFrozenClusteringJob, clusteringJobRepository, clusteringJobWorkflow, reportClusteringJob, type TaskData, type ClusteringJobConfig } from "@eval/workflows/comparison";
import { loadRunInputs } from "@eval/workflows/inputs";
import { runEvaluation } from '@eval/host';
import { startWorker } from '@eval/runtime/worker';
import { DashboardBatches } from '../../../apps/host/src/dashboard-batches.js';
import { DashboardAnalysis } from '../../../apps/host/src/dashboard-analysis.js';
import { DashboardErrors } from "../../../apps/host/src/dashboard-errors.js";
import { startDashboard } from '../../../apps/host/src/dashboard.js';
import { ROOT, services } from '../../fixtures/services.js';
import { fixtureConfig, raw, criteriaResultForTask, attributionResult, fakeIdentity, fakeEvaluatorVersion, emptyAudit, draftFor, submitFor, taskResult } from '../../fixtures/comparison.js';
import { waitForTestState } from '../../fixtures/wait.js';

async function fixture() {
  const f=await fixtureConfig([[raw('one'),raw('two')],[],[],[]]);
  const config=f.config; config.comparisons=[];config.rewrite.clustering=false;config.clustering.minSupport=1;
  config.inputs.workbench={task:{id:'task',name:'专项',source:'aime',category:'task'},batch_ids:['pkg1','pkg2'],records:[0,1].map(index=>({
    model:'a_fast',batch_id:'b1',case_id:index?'two':'one',input_file:config.inputs.versions[0]!.sources[0]!.path,input_index:index,
    package_id:'pkg'+(index+1),package_name:'p'+index+'.7z',original_file:'p.7z/member.jsonl',original_line:10+index,
  }))};
  const batches=new DashboardBatches(path.join(f.directory,'registry/workbench-runs'),'http://unused');
  for(const [index,id] of ['older','newer'].entries()) {
    const plan=await buildPlan(config),run=path.join(config.output.path,id),receipts:Record<string,SubmissionReceipt>={};
    for(const task of plan.tasks) {
      if(!['criteria','attribution'].includes(task.stage))continue;
      const candidate=(task.data as TaskData).candidates.A;
      if(task.stage==='attribution' && candidate.case_id==='two')continue;
      const evaluation=task.stage==='criteria'?criteriaResultForTask(task,plan.inputs):attributionResult(false,'2+2=5',true,candidate.input_id);
      if(task.stage==='attribution')
      receipts[task.id]={taskId:task.id,attemptId:randomUUID(),submissionId:randomUUID(),evaluation,evaluatorVersion:fakeEvaluatorVersion,
        judge:'fixture',acceptedAt:index+1,status:'succeeded',audit:emptyAudit(),usage:emptyUsage()};
    }
    const state:RunState={manifest:{format:'evaluation-run',runId:id,status:'interrupted',config,engine:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
      debug:false,tasks:plan.tasks,inputCatalog:plan.catalog,inputs:{},states:Object.fromEntries(plan.tasks.map(task=>[task.id,{status:receipts[task.id]?'succeeded':'pending',attempts:0}])),
      preflight:plan.summary,startedAt:index+1},receipts,usage:emptyUsage(),recordedAttempts:0};
    await createResultWriter(run,plan.inputs)(state);await writeRunState(run,state);
    await batches.save({runId:id,createdAt:index+1,outputDir:config.output.path,scope:{task:config.inputs.workbench.task,batch_ids:['pkg1','pkg2']},models:['a_fast'],engine:'pi',settings:{},status:'finished'});
    await writeJson(batches.config(id),{inputs:config.inputs});
  }
  const file=path.join(f.directory,'config.json');
  await writeJson(file,{...config,evaluatorVersion:fakeEvaluatorVersion,models:{judge:{channel:'evaluation-gateway',model:'fixture',thinking:'off'}},
    bindings:Object.fromEntries(['criteria','attribution','comparison','rewrite','clustering'].map(stage=>[stage,{profile:'judge'}]))});
  return {...f,batches,file};
}

test('analysis freezes selected accepted receipts, shows unfinished/overlap, reserves once, resumes and archives references',async t=>{
  const f=await fixture();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  // Host model credentials are resolved by the same loader as production, never copied to the job registry.
  const {loadConfig,createModelResolver}=await import('../../../apps/host/src/config.js');
  const host=await loadConfig([f.file]),model=createModelResolver(host.models)('clustering');
  const previous=process.env[model.apiKeyEnv];process.env[model.apiKeyEnv]='fixture';t.after(()=>{if(previous===undefined)delete process.env[model.apiKeyEnv];else process.env[model.apiKeyEnv]=previous;});
  let launches=0, exit:((code:number|null,signal:NodeJS.Signals|null)=>void)|undefined;
  const catalog=async()=>[{id:model.model,channel:model.provider,name:'fixture'}] as any;
  const analysis=new DashboardAnalysis(f.batches,[f.file],catalog,async args=>{launches++;assert(args.includes('--clustering-selection'));return {pid:2147483647,onExit(callback){exit=callback;}};});
  const selected={task_id:'task',batch_ids:[],run_ids:['older','newer']};
  const scope=await analysis.scope(selected);
  assert.deepEqual(scope.counts,{available:1,included:0,reserved:0,unfinished:2,superseded:1});
  assert.equal(scope.rows.find(row=>row.status==='available')!.run_id,'newer');
  assert.equal((await analysis.scope({...selected,batch_ids:['pkg2']})).counts.available,0);
  await assert.rejects(analysis.scope({...selected,run_ids:['../outside']}),/无效/);
  await assert.rejects(analysis.scope({...selected,task_id:'other'}),/不属于/);
  const first=await analysis.preview(selected),second=await analysis.preview(selected);
  const results=await Promise.allSettled([analysis.launch(first.job_id,{}),analysis.launch(second.job_id,{})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(launches,1);
  assert.equal((await analysis.scope(selected)).counts.reserved,1);
  // A restart retains claims even when the child died before state.json was created.
  const restarted=new DashboardAnalysis(f.batches,[f.file],catalog);
  assert.equal((await restarted.scope(selected)).counts.reserved,1);
  const winner = results[0].status==='fulfilled' ? first : second, loser = winner===first ? second : first;
  await assert.rejects(analysis.launch(loser.job_id,{}),/已纳入/);
  const job=(await analysis.get(winner.job_id))!,selection=await readJson<ClusteringJobConfig['clusteringJob']>(analysis.selectionFile(job.id));
  assert.equal(selection.sources.length,1);assert.equal(selection.sources[0].case_id,'one');
  const cli=await promisify(execFile)(process.execPath,[path.join(ROOT,'dist/apps/host/src/cli.js'),'cluster','--config',f.file,
    '--clustering-selection',analysis.selectionFile(job.id)]);
  assert.equal(JSON.parse(cli.stdout).attribution_answers,1);
  await assert.rejects(prepareFrozenClusteringJob({...selection,sources:[{...selection.sources[0],submission_id:'changed'}]},f.config),/原归因引用已缺失或改变/);

  const before=await readFile(path.join(f.config.output.path,'newer/state.json'),'utf8');
  const output={kind:'directory' as const,path:job.output_dir};
  const prepared=await prepareFrozenClusteringJob(selection,{...f.config,output});
  let fail=true;const calls:string[]=[];
  const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return {async run(){calls.push(options.spec.taskId);if(fail){fail=false;throw new Error('fixture interrupted');}
    const response=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));assert.equal(response.isError,undefined,JSON.stringify(response));},async abort(){},async dispose(){}};}};
  const worker=await startWorker(backend,path.join(f.directory,'worker'));t.after(()=>worker.close());
  const runOptions={...services,taskSource:clusteringJobWorkflow,repository:clusteringJobRepository,report:reportClusteringJob,runId:job.id,output,
    engine:'pi' as const,identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,config:prepared.config,plan:prepared.plan,
    policy:f.config.execution,modelForStage:f.modelForStage,concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]};
  await runEvaluation(runOptions);exit!(2,null);
  await waitForTestState(()=>analysis.get(job.id),current=>!!current && !current.pid && !!current.error,
    'analysis interruption is persisted before resuming');
  assert.equal((await analysis.list())[0].status,'interrupted');assert.equal((await analysis.scope(selected)).counts.reserved,1);
  const errors = await new DashboardErrors(path.join(f.directory,'log')).read(path.join(output.path,job.id),new URLSearchParams());
  assert(errors.tasks.some(task=>task.locations.some(location=>location.case_id==='one')));
  assert(!JSON.stringify(errors).includes('draft'));
  const sourceResults=path.join(f.config.output.path,'newer/results/attribution.jsonl');
  await rename(sourceResults,sourceResults+'.held');
  try {
    const unavailable=await new DashboardErrors(path.join(f.directory,'log')).read(path.join(output.path,job.id),new URLSearchParams());
    assert(unavailable.tasks.some(task=>'location_error' in task && task.location_error));
  } finally {await rename(sourceResults+'.held',sourceResults);}

  await analysis.launch(job.id,{});
  await runEvaluation({...runOptions,plan:{tasks:[],inputs:{},summary:{}}});exit!(0,null);
  await waitForTestState(()=>analysis.get(job.id),current=>!!current && !current.pid && !!current.completed_at,
    'analysis completion is persisted before reading its status');
  assert.equal((await analysis.list())[0].status,'completed');assert.equal((await analysis.scope(selected)).counts.included,1);
  await assert.rejects(analysis.preview(selected),/没有新的/);
  assert.equal(await readFile(path.join(f.config.output.path,'newer/state.json'),'utf8'),before);
  assert((await listRunArtifacts(path.join(output.path,job.id))).some(file=>file.name==='report.md'));
  // Production routes link existing files; archiving does not move or duplicate results.
  const server=await startDashboard({configPaths:[f.file],port:0,batchDirectory:f.batches.directory,modelCatalog:catalog});t.after(()=>server.close());
  const response=await fetch(server.url+'/api/dashboard/batch-runs/newer/archive',{method:'POST',headers:{origin:server.url}});
  assert.equal(response.status,200,await response.text());assert((await f.batches.get('newer'))!.archivedAt);
  const artifacts=await fetch(server.url+'/api/dashboard/batch-runs/newer/artifacts').then(res=>res.json());
  assert(artifacts.files.some((file:{name:string})=>file.name==='results/attribution.jsonl'));
  assert(artifacts.files.every((file:{name:string})=>!file.name.includes('state')));
  const download = await fetch(server.url+'/api/dashboard/batch-runs/newer/artifacts?file=results%2Fattribution.jsonl');
  assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')!,/attachment/);
  assert.equal(await download.text(),await readFile(path.join(f.config.output.path,'newer/results/attribution.jsonl'),'utf8'));
  assert.equal((await fetch(server.url+'/api/dashboard/batch-runs/newer/artifacts?file=state.json')).status,404);
  const paged=await fetch(server.url+'/api/dashboard/analysis/scope',{method:'POST',headers:{origin:server.url,'content-type':'application/json'},body:JSON.stringify({...selected,status:'unfinished',page:1})}).then(res=>res.json());
  assert.equal(paged.total,2);assert.equal(paged.rows.length,2);assert.equal(paged.counts.included,1);
  const sourceRun=path.join(f.config.output.path,'newer'),updated=await readRunState(sourceRun),inputs=await loadRunInputs(updated.manifest);
  const pending=updated.manifest.tasks.find(task=>task.stage==='attribution' && (task.data as TaskData).candidates.A.case_id==='two')!;
  const candidate=(pending.data as TaskData).candidates.A;
  const evaluation=attributionResult(false,'2+2=5',true,candidate.input_id);

  updated.receipts[pending.id]={...updated.receipts[selection.sources[0].task_id],taskId:pending.id,submissionId:randomUUID(),acceptedAt:3,evaluation};
  updated.manifest.states[pending.id].status='succeeded';
  await createResultWriter(sourceRun,inputs)(updated);await writeRunState(sourceRun,updated);
  assert.equal((await analysis.scope(selected)).counts.available,1);
  assert.equal((await prepareFrozenClusteringJob(selection,f.config)).plan.summary.attribution_answers,1);

});
