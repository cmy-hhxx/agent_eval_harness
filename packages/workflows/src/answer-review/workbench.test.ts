import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {emptyUsage,type RunState} from '@eval/contracts';
import {runLock,writeJson} from '@eval/data';
import {fixtureConfig,sessionRaw,emptyAudit,fakeIdentity,fakeEvaluatorVersion} from '../../../../tests/fixtures/comparison.js';
import {planAnswerReview,answerReviewRepository,appendAnswerReviewInputs,answerReviewSamples,answerReviewSample,answerReviewRunSummary,retryAnswerReviewTasks,prepareAnswerReviewAutomaticResume,answerReviewWorkflow,type AnswerReviewConfig} from './index.js';

test('existing accepted Attribution keeps its row while Score is added, paginated and selectively retried',async t=>{
  const f=await fixtureConfig([[{...sessionRaw('one'),batch_id:'b1'} as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const config:AnswerReviewConfig={...f.config,workflow:'answer-review',reviewStages:['attribution'],comparisons:[],inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}};
  const plan=await planAnswerReview(config),task=plan.tasks[0],run=path.join(f.directory,'runs','day'),c=(task.data as any).candidate;
  const state:RunState={manifest:{runId:'day',format:'evaluation-run',debug:false,status:'interrupted',engine:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,config,
    tasks:plan.tasks,states:{[task.id]:{status:'succeeded',attempts:1}},inputCatalog:plan.catalog,inputs:{},preflight:plan.summary,startedAt:1},
    receipts:{[task.id]:{taskId:task.id,attemptId:'attempt',submissionId:'submission',evaluatorVersion:fakeEvaluatorVersion,judge:'fixture',status:'succeeded',acceptedAt:1,
      evaluation:{summary:'回答准确。',findings:[],evidence:[]},audit:emptyAudit(),usage:emptyUsage()}},usage:emptyUsage(),recordedAttempts:1};
  await answerReviewRepository.createResultWriter(run,plan.inputs)(state);await answerReviewRepository.writeRun(run,state);
  const historical=await answerReviewRunSummary(run);assert.equal(historical.stages.attribution.succeeded,1);assert.equal(historical.stages.score.total,1);assert.equal(historical.stages.score.pending,1);
  assert.equal(historical.questions,1);assert.equal(historical.answers,1);assert.equal(historical.taskTotal,2);assert.equal(historical.taskCompleted,1);
  assert.deepEqual(historical.models[c.version],{answers:1,completed:0,failed:0,pending:1});assert.equal(historical.total,1);assert.equal(historical.succeeded,0);
  const historicalDetail=await answerReviewSample(run,c.input_id);assert.equal(historicalDetail.results.attribution?.task_id,task.id);assert.equal(historicalDetail.results.score,null);
  const input={model:c.version,batch_id:c.batch_id,case_id:c.case_id,trace_id:c.trace_id,input_file:c.source,input_index:c.line-1};
  const both:AnswerReviewConfig={...config,reviewStages:['score','attribution'],inputs:{...config.inputs,records:[input]}};
  assert.equal(await appendAnswerReviewInputs(run,both),0);assert.equal(await appendAnswerReviewInputs(run,both),0);
  const current=await answerReviewRepository.readRun(run),score=current.manifest.tasks.find(t=>t.stage==='score')!;
  assert.equal(current.manifest.tasks.length,2);assert.deepEqual(current.receipts[task.id],state.receipts[task.id]);
  current.manifest.states[score.id]={status:'failed',attempts:2,reason:'score failed'};await answerReviewRepository.writeRun(run,current);
  const page=await answerReviewSamples(run,new URLSearchParams({model:c.version,status:'failed',limit:'1'}));
  assert.equal(page.total,1);assert.equal(page.items[0].stages.score.status,'failed');
  assert.equal((await answerReviewSamples(run,new URLSearchParams({offset:'1'}))).items.length,0);
  const detail=await answerReviewSample(run,c.input_id);assert.equal(detail.answer,'2+2=4');assert.equal(detail.results.score,null);assert.equal(detail.results.attribution?.task_id,task.id);
  const summary=await answerReviewRunSummary(run);assert.equal(summary.failed,1);assert.equal(summary.stages.attribution.succeeded,1);
  assert.deepEqual(summary.models[c.version],{answers:1,completed:0,failed:1,pending:0});assert.equal(summary.taskTotal,2);assert.equal(summary.taskCompleted,1);
  const unlock=await runLock(run);await assert.rejects(retryAnswerReviewTasks(run,{stages:['score']}),/owned/);await unlock();
  const retry=await retryAnswerReviewTasks(run,{taskIds:[score.id],stages:['score']});assert.deepEqual(retry.retried,[score.id]);
  const after=await answerReviewRepository.readRun(run);assert.deepEqual(after.receipts[task.id],state.receipts[task.id]);assert.equal(after.manifest.states[score.id].attempts,2);
  await assert.rejects(retryAnswerReviewTasks(run,{stages:'score'}),/重试范围/);
  const wrong=path.join(f.directory,'wrong');await writeJson(path.join(wrong,'state.json'),{workflow:'comparison'});
  await assert.rejects(answerReviewRunSummary(wrong),/不属于独立Score/);
});

test('automatic Score backfill retains the exact task scope and does not reopen a terminal Attribution on the same answer',async t=>{
  const f=await fixtureConfig([[{...sessionRaw('scope'),batch_id:'b1'} as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const version=f.config.inputs.versions[0],config:AnswerReviewConfig={...f.config,workflow:'answer-review',reviewStages:['score','attribution'],
    inputs:{...f.config.inputs,versions:[version],records:[{model:version.id,batch_id:'b1',case_id:'scope',trace_id:'trace-scope',input_file:version.sources[0].path,input_index:0}]}};
  const plan=await planAnswerReview(config),run=path.join(f.directory,'exact'),attribution=plan.tasks.find(task=>task.stage==='attribution')!,score=plan.tasks.find(task=>task.stage==='score')!;
  const failure={contentSubmissions:1,fileErrors:0,repeatedErrors:0,stopped:false,attemptId:'prior',errors:[{category:'structure' as const,code:'invalid_structure',path:'/',message:'invalid structure'}]};
  const state:RunState={manifest:{runId:'exact',format:'evaluation-run',debug:false,status:'interrupted',engine:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,config,
    tasks:plan.tasks,states:{[attribution.id]:{status:'failed',attempts:1,failure},[score.id]:{status:'pending',attempts:0}},inputCatalog:plan.catalog,inputs:{},pausedStages:[],preflight:plan.summary,startedAt:1},
    receipts:{},usage:emptyUsage(),recordedAttempts:1};
  await answerReviewRepository.writeRun(run,state);
  const eligible=await prepareAnswerReviewAutomaticResume(run,new Set(['trace-scope']));assert.deepEqual([...eligible],[score.id]);
  const current=await answerReviewRepository.readRun(run);
  await answerReviewWorkflow.reconcile!(run,current,{...config,reviewTaskIds:[...eligible]});
  assert.deepEqual(current.manifest.executionScope,[score.id]);assert.deepEqual(current.manifest.states[attribution.id],state.manifest.states[attribution.id]);
  assert.equal(current.recordedAttempts,1);assert.equal(current.manifest.states[attribution.id].failure?.contentSubmissions,1);
});
