import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {runEvaluation,AgentRegistry} from '@eval/host';
import {startWorker} from '@eval/runtime/worker';
import type {AgentBackend} from '@eval/contracts';
import {scoreAgent,type ScoreResult} from '@eval/agents/score';
import {instructionReviewAgent} from '@eval/agents/instruction-review';
import {attributionAgent} from '@eval/agents/attribution';
import {rewriteAgent} from '@eval/agents/rewrite';
import {scoreDirectory} from '@eval/prompts';
import {fixtureConfig,sessionRaw,fakeIdentity,fakeEvaluatorVersion,parsedMaterial,taskResult,draftFor,submitFor} from '../../../../tests/fixtures/comparison.js';
import {services} from '../../../../tests/fixtures/services.js';
import {planAnswerReview,answerReviewWorkflow,answerReviewRepository,reportAnswerReview,validateAnswerReview,prepareAnswerReviewRetry,prepareAnswerReviewAutomaticResume,appendAnswerReviewInputs,type AnswerReviewConfig} from './index.js';
function score(caseId:string,q:string,a:string):ScoreResult{
 const known=new Set(['T1','T2','E2','L1','U2','D1']);
 const evidence=[{evidence_id:'q',source_id:'Q',start:0,end:Array.from(q).length,quote:q},{evidence_id:'a',source_id:'A',start:0,end:Array.from(a).length,quote:a}];
 const judgments=(active:boolean)=>({status:active?'met' as const:'not_applicable' as const,applicability:active?'both' as const:'not_triggered' as const,reason:active?'原题与完整回答支持该项。':'本数学文字回答未触发该项。',evidence_ids:['q','a']});
 const directory=scoreDirectory as {units:Record<string,string>;diagnostics:Record<string,string>;parents:Record<string,string>};
 return {case_id:caseId,final_answer_score:{status:'met',grade:'全部满足',score:10,score_range:null,reason:'计算结果完整正确。',evidence_ids:['q','a'],finding_ids:[]},
  evaluations:Object.entries(directory.units).map(([item_id,item_name])=>({...judgments(known.has(item_id)),item_id,item_name,score:known.has(item_id)?4:null,score_range:null,grade:known.has(item_id)?'全部必要要求满足':'不适用'})),
  diagnostics:Object.entries(directory.parents).map(([diagnostic_id,parent])=>({...judgments(known.has(parent)),diagnostic_id,diagnostic_name:directory.diagnostics[diagnostic_id]})),findings:[],evidence,explicit_probability:null,probability_evidence_ids:[]};
}
test('Score and unified Attribution run independently, omit SYS/DEV, and rewrite only attribution text',async t=>{
 const trace=sessionRaw('one');trace.traces[0].messages.forEach((message,i)=>Object.assign(message,{role:i===0?'user':'assistant',type:'message'}));
 trace.traces[0].messages.unshift({role:'system',type:'message',content:'SECRET_PRIVATE_POLICY'} as any);
 trace.meta.n_messages=trace.traces[0].meta.n_messages=3;
 Object.assign(trace.meta,{batch_id:'b1',opaque:{unicode:'🧪',nullable:null},export_only:'PRIVATE_META_SENTINEL'});
 Object.assign(trace,{_source:{original_file:'batch.7z/answers.jsonl',original_line:8,original_item:2,business_date:'2026-10-23'}});
 const fixture=await fixtureConfig([[trace as any],[],[],[]],true);t.after(()=>rm(fixture.directory,{recursive:true,force:true}));
 const config={...fixture.config,workflow:'answer-review',inputs:{...fixture.config.inputs,versions:fixture.config.inputs.versions.slice(0,1)},} as AnswerReviewConfig;
 const plan=await planAnswerReview(config);assert.equal(plan.tasks.filter(t=>t.stage==='criteria'||t.stage==='comparison').length,0);
 assert.deepEqual(plan.tasks.filter(t=>['score','attribution'].includes(t.stage)).map(t=>t.dependencies),[{},{}]);
 assert(!JSON.stringify(Object.values(plan.inputs)).includes('SECRET_PRIVATE_POLICY'));
 assert(!JSON.stringify(Object.values(plan.inputs)).includes('PRIVATE_META_SENTINEL'));
 const agents=new AgentRegistry([scoreAgent,attributionAgent,rewriteAgent,instructionReviewAgent]);
 const languageRejected=new Set<string>();
 const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return{async run(){
  const id=options.spec.evaluation.id;
  if(id==='rewrite'){
   const material=parsedMaterial(options.spec) as {items:{id:string;text:string}[]};
   const result=await options.execute('submit_evaluation',{rewrites:material.items.map(row=>({id:row.id,text:row.text}))});assert.notEqual(result.isError,true,JSON.stringify(result));return;
  }
  if(id==='attribution'){
   const draft=draftFor(options.spec,taskResult(options.spec));
   if(!languageRejected.has(options.spec.taskId)){
    languageRejected.add(options.spec.taskId);
    const rejected=await submitFor(options,{...draft as object,summary:'The answer is correct and complete.'});
    assert.equal(rejected.isError,true);assert.match(JSON.stringify(rejected),/attribution_language/);return;
   }
   const accepted=await submitFor(options,draft);assert.notEqual(accepted.isError,true,JSON.stringify(accepted));return;
  }
  if(id==='instruction-review'){const result=await submitFor(options,taskResult(options.spec));assert.notEqual(result.isError,true,JSON.stringify(result));return;}
  const materialTool='score_material';
  const inspect=await options.execute(materialTool,{action:'inspect'}),info=inspect.details as {case_id:string};
  const read=async(source_id:string)=>{const r=await options.execute(materialTool,{action:'read',source_id});return (r.details as {content:string}).content;};
  const q=await read('Q'),a=await read('A');
  const quoted=await options.execute(materialTool,{action:'batch',operations:[{action:'quote',source_id:'Q',text:q},{action:'quote',source_id:'A',text:a},{action:'quote',source_id:'A',text:'不存在的原文'}]});
  const rows=(quoted.details as any).results;assert.deepEqual(rows.map((r:any)=>r.ok),[true,true,false]);assert.equal(rows[1].end,Array.from(a).length);
  let value:any=score(info.case_id,q,a);
  if(id==='score'){
   const profile=options.spec.evaluation.profile;
   const refs=(ids:string[])=>ids.map(id=>id==='q'?rows[0].evidence_id:rows[1].evidence_id);
   if(profile==='evidence')value={facts:[],unresolved:[]};
   else if(profile.startsWith('axis-')||profile==='dimensions'){
    const axes=profile==='dimensions'?['T','E','L','A','U','D']:[profile.slice(-1).toUpperCase()];
    value={evaluations:value.evaluations.filter((r:any)=>axes.includes(r.item_id[0])).map(({item_name:_name,grade:_grade,...r}:any)=>({...r,evidence_ids:refs(r.evidence_ids)})),
     diagnostics:value.diagnostics.filter((r:any)=>axes.includes(r.diagnostic_id[0])).map(({diagnostic_name:_name,...r}:any)=>({...r,evidence_ids:refs(r.evidence_ids)})),findings:[],verification_requests:[]};
   }else{const {grade:_grade,...rating}=value.final_answer_score;value={final_answer_score:{...rating,evidence_ids:refs(rating.evidence_ids)},finding_groups:[],explicit_probability:null,probability_evidence_ids:[]};}
  }
  const accepted=await options.execute('submit_evaluation',value);assert.notEqual(accepted.isError,true,JSON.stringify(accepted));
 },async abort(){},async dispose(){}};}};
 const worker=await startWorker(backend,path.join(fixture.directory,'worker'));t.after(()=>worker.close());
 await runEvaluation({...services,agents,taskSource:answerReviewWorkflow,repository:answerReviewRepository,report:reportAnswerReview,runId:'flow',output:config.output,config,plan,
  engine:'pi',identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,modelForStage:stage=>fixture.modelForStage(stage==='score'?'attribution':stage),policy:config.execution,concurrency:3,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]});
 const state=await answerReviewRepository.readRun(path.join(config.output.path,'flow'));assert.equal(Object.keys(state.receipts).length,6,JSON.stringify(state.manifest.states));assert.equal(validateAnswerReview(state).valid,true);
 const s=state.manifest.tasks.find(t=>t.stage==='score'&&(t.data as any).score_part==='final')!,a=plan.tasks.find(t=>t.stage==='attribution')!;
 assert.equal((state.receipts[s.id].evaluation as ScoreResult).final_answer_score.score,10);
 assert.equal(state.receipts[a.id].submissionStats?.contentSubmissions,2,'English rejection is repaired in-session and remains counted');
 assert.equal(state.receipts[s.id].exported!.file,'score.jsonl');assert.equal(state.receipts[a.id].exported!.file,'attribution.jsonl');
 assert(!Object.hasOwn(state.receipts[a.id].exported!.row,'evaluation'));
 assert.equal((state.receipts[a.id].evaluation as any).findings[0].problem,null);
 assert.equal((state.receipts[a.id].evaluation as any).findings[0].evidence[0].quote,'2+2=4');
 const exported=state.receipts[a.id].exported!.row;
 assert(Object.hasOwn(exported,'rewritten'));
 assert(!Object.hasOwn(state.receipts[a.id].evaluation as object,'rewritten'));
 assert.equal(exported.trace_id,'trace-one');assert.equal(exported.source_archive,'batch.7z');assert.equal(exported.source_member,'answers.jsonl');assert.equal(exported.source_line,8);assert.equal(exported.source_item,2);
 for(const receipt of Object.values(state.receipts).filter(r=>r.exported))assert.deepEqual(receipt.exported!.row.meta,trace.meta);
 const before=structuredClone(state.receipts),resumed=await answerReviewWorkflow.reconcile!(path.join(config.output.path,'flow'),state,config);assert.deepEqual(state.receipts,before);
 // Re-export metadata on resume without changing a prior accepted judgment, including rewritten rows.
 for(const receipt of Object.values(state.receipts).filter(r=>r.exported))delete receipt.exported!.row.meta;
 await answerReviewRepository.createResultWriter(path.join(config.output.path,'flow'),resumed.inputs)(state);
 for(const [id,receipt] of Object.entries(state.receipts).filter(([,r])=>r.exported)){assert.deepEqual(receipt.exported!.row.meta,trace.meta);assert.deepEqual(receipt.evaluation,before[id].evaluation);}
 const restored=await answerReviewRepository.readRun(path.join(config.output.path,'flow'));
 assert.deepEqual(restored.receipts[a.id].evaluation,before[a.id].evaluation);
 assert.deepEqual(restored.receipts[a.id].exported!.row.rewritten,exported.rewritten);
 // Exercise actual Host dispatch after appending to a saved day, not just checkpoint decoding.
 const version=config.inputs.versions[0],file=version.sources[0].path;
 const next={...sessionRaw('two'),batch_id:'b1'};
 await appendFile(file,JSON.stringify(next)+'\n');
 const delta:AnswerReviewConfig={...config,reviewStages:['attribution'],rewrite:{...config.rewrite,attribution:false},
  inputs:{...config.inputs,records:[{model:version.id,batch_id:'b1',case_id:'two',trace_id:'trace-two',input_file:file,input_index:1}]}};
 const run=path.join(config.output.path,'flow');
 assert.equal(await appendAnswerReviewInputs(run,delta),1);
 const addedAttribution=(await answerReviewRepository.readTasks(run,[])).manifest.tasks.find(task=>task.stage==='attribution'&&(task.data as any).candidate.trace_id==='trace-two')!;
 assert.deepEqual([...await prepareAnswerReviewAutomaticResume(run,new Set(['trace-one','trace-two']))],[addedAttribution.id]);
 await runEvaluation({...services,agents,taskSource:answerReviewWorkflow,repository:answerReviewRepository,report:reportAnswerReview,
  runId:'flow',output:delta.output,config:delta,plan:await planAnswerReview(delta),engine:'pi',identity:fakeIdentity,
  evaluatorVersion:fakeEvaluatorVersion,modelForStage:fixture.modelForStage,policy:delta.execution,concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]});
 const appended=await answerReviewRepository.readRun(run);
 assert.equal(Object.keys(appended.receipts).length,8,JSON.stringify(appended.manifest.states));
 const added=appended.manifest.tasks.find(t=>(t.data as any).candidate.trace_id==='trace-two')!;
 assert.equal(appended.manifest.states[added.id].status,'succeeded');
 assert.equal(appended.receipts[added.id].exported!.row.trace_id,'trace-two');
 for(const [id,receipt] of Object.entries(before))assert.deepEqual(appended.receipts[id].exported,receipt.exported);
 assert.equal(await appendAnswerReviewInputs(run,delta),0);
});

test('continuous resume preserves costs and identities and leaves terminal content failures reported',async t=>{
 const rows=['retry','spent','stopped','fresh','invalid','language'].map(id=>({...sessionRaw(id),batch_id:'b1'}));
 const f=await fixtureConfig([rows as any,[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const config={...f.config,workflow:'answer-review',reviewStages:['attribution'],inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}} as AnswerReviewConfig;
 config.execution.repairAttempts=3;
 const plan=await planAnswerReview(config),run=path.join(config.output.path,'automatic');
 const states=Object.fromEntries(plan.tasks.map(task=>{const id=(task.data as any).candidate.case_id;return [task.id,{status:id==='fresh'?'pending':'failed',attempts:id==='fresh'?0:2,
  ...(id==='fresh'?{}:{failure:{contentSubmissions:id==='spent'?4:1,fileErrors:0,repeatedErrors:0,stopped:id==='stopped',attemptId:'prior',
   errors:[{category:['invalid','language'].includes(id)?'structure':'transport',code:id==='language'?'attribution_language':'test',path:'/',message:'test failure'}]}})}];}));
 const state:any={manifest:{runId:'automatic',config,tasks:plan.tasks,states,inputCatalog:plan.catalog,inputs:{},pausedStages:[{stage:'attribution'}]},receipts:{},usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3},recordedAttempts:8};
 await answerReviewRepository.writeRun(run,state);
 const eligible=await prepareAnswerReviewAutomaticResume(run,new Set(rows.map(r=>r.traces[0].meta.trace_id)));
 assert.deepEqual(plan.tasks.filter(task=>eligible.has(task.id)).map(task=>(task.data as any).candidate.trace_id).sort(),['trace-fresh','trace-language','trace-retry']);
 const after=await answerReviewRepository.readRun(run);
 assert.deepEqual(after.manifest.states,states);assert.deepEqual(after.manifest.tasks.map(t=>t.id),plan.tasks.map(t=>t.id));
 assert.deepEqual(after.usage,state.usage);assert.equal(after.recordedAttempts,8);assert.equal(after.manifest.executionScope?.length,3);
});

test('exact incremental coordinates select only new attribution and reject trace identity drift',async t=>{
 const one={...sessionRaw('one'),batch_id:'b1'},invalid={...sessionRaw('invalid'),batch_id:'b1'};invalid.traces.push(invalid.traces[0]);
 const f=await fixtureConfig([[one as any,invalid as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const version=f.config.inputs.versions[0];const config={...f.config,workflow:'answer-review',reviewStages:['attribution'],
   inputs:{...f.config.inputs,versions:[version],records:[{model:version.id,batch_id:'b1',case_id:'one',trace_id:'trace-one',input_file:version.sources[0].path,input_index:0}]}} as AnswerReviewConfig;
 const plan=await planAnswerReview(config);assert.deepEqual(plan.tasks.map(t=>t.stage),['attribution']);assert.equal(plan.summary.valid_inputs,1);assert.deepEqual(plan.summary.issues,[]);
 config.inputs.records![0].trace_id='changed';const drift=await planAnswerReview(config);assert.equal(drift.tasks.length,0);assert.equal((drift.summary.issues as unknown[]).length,1);
});

test('manual failure retry preserves task identity and spent budgets until current limits allow another attempt',async t=>{
 const f=await fixtureConfig([[{...sessionRaw('retry'),batch_id:'b1'} as any],[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const config={...f.config,workflow:'answer-review',reviewStages:['attribution'],inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}} as AnswerReviewConfig;
 config.execution.maxTaskAttempts=2;config.execution.repairAttempts=3;
 const plan=await planAnswerReview(config),task=plan.tasks[0],run=path.join(f.config.output.path,'retry');
 const state:any={manifest:{runId:'retry',config,tasks:plan.tasks,states:{[task.id]:{status:'failed',attempts:2,failure:{contentSubmissions:4}}},inputCatalog:plan.catalog,inputs:{},pausedStages:[{stage:'attribution'}]},receipts:{},usage:{input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3},recordedAttempts:2};
 await answerReviewRepository.writeRun(run,state);const changes=await prepareAnswerReviewRetry(run),after=await answerReviewRepository.readRun(run);
 assert.deepEqual(changes,[task.id]);assert.deepEqual(after.usage,state.usage);assert.equal(after.recordedAttempts,2);
 assert.deepEqual(after.manifest.states[task.id],{status:'pending',attempts:2,failure:{contentSubmissions:4}});assert.equal(after.manifest.tasks[0].inputIds.case,task.inputIds.case);
 assert.deepEqual([...await prepareAnswerReviewAutomaticResume(run,new Set(['trace-retry']))],[]);
 const raised=await answerReviewRepository.readRun(run);(raised.manifest.config as AnswerReviewConfig).execution.maxTaskAttempts=3;(raised.manifest.config as AnswerReviewConfig).execution.repairAttempts=4;
 await answerReviewRepository.writeRun(run,raised);assert.deepEqual([...await prepareAnswerReviewAutomaticResume(run,new Set(['trace-retry']))],[task.id]);
 const stopped=await answerReviewRepository.readRun(run);stopped.manifest.states[task.id].status='failed';stopped.manifest.states[task.id].failure!.stopped=true;
 await answerReviewRepository.writeRun(run,stopped);await prepareAnswerReviewRetry(run);
 assert.deepEqual([...await prepareAnswerReviewAutomaticResume(run,new Set(['trace-retry']))],[]);
 assert.equal((await answerReviewRepository.readRun(run)).manifest.states[task.id].failure!.stopped,true);
});


test('failed instruction review resumes independently and keeps accepted main attribution immutable',async t=>{
 const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const config={...f.config,workflow:'answer-review',reviewStages:['attribution'],rewrite:{...f.config.rewrite,attribution:false},inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}} as AnswerReviewConfig;
 const plan=await planAnswerReview(config),sessions:string[]=[];let failReview=true;
 const backend:AgentBackend={identity:fakeIdentity,async createSession(options){sessions.push(options.spec.taskId);return {async run(){
  if(options.spec.evaluation.id==='instruction-review'&&failReview)throw Error('controlled instruction review interruption');
  const result=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));assert.notEqual(result.isError,true,JSON.stringify(result));
 },async abort(){},async dispose(){}};}};
 const worker=await startWorker(backend,path.join(f.directory,'worker'));t.after(()=>worker.close());
 const run=path.join(config.output.path,'review-recovery');
 const execute=()=>runEvaluation({...services,taskSource:answerReviewWorkflow,repository:answerReviewRepository,report:reportAnswerReview,
  runId:'review-recovery',output:config.output,config,plan,engine:'pi',identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
  modelForStage:f.modelForStage,policy:config.execution,concurrency:16,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]});
 await execute();const first=await answerReviewRepository.readRun(run),parent=plan.tasks[0];
 assert.equal(first.manifest.states[parent.id].status,'succeeded');
 const accepted=structuredClone(first.receipts[parent.id]);
 const review=first.manifest.tasks.find(task=>task.stage==='instruction-review')!;
 assert.equal(first.manifest.states[review.id].status,'failed');assert(!first.receipts[review.id]);
 failReview=false;const retried=await prepareAnswerReviewRetry(run);assert.deepEqual(retried,[review.id]);
 await execute();const resumed=await answerReviewRepository.readRun(run);
 assert.deepEqual(resumed.receipts[parent.id],accepted);
 assert.equal(sessions.filter(id=>id===parent.id).length,1);
 const checks=resumed.manifest.tasks.filter(task=>task.stage==='instruction-review');assert.equal(checks.length,1);
 assert.equal(checks[0].dependencies.source,parent.id);assert(resumed.receipts[checks[0].id]);
 assert.equal(validateAnswerReview(resumed).valid,true);
});


test('main attribution and independent reviews share one concurrency limit of sixteen',async t=>{
 const rows=Array.from({length:18},(_,index)=>({...sessionRaw('case'+index),batch_id:'b1'}));
 const f=await fixtureConfig([rows as any,[],[],[]]);t.after(()=>rm(f.directory,{recursive:true,force:true}));
 const config={...f.config,workflow:'answer-review',reviewStages:['attribution'],rewrite:{...f.config.rewrite,attribution:false},inputs:{...f.config.inputs,versions:f.config.inputs.versions.slice(0,1)}} as AnswerReviewConfig;
 const plan=await planAnswerReview(config);let active=0,peak=0,started=0,checks=0,release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return {async run(){
  active++;peak=Math.max(peak,active);
  try{
   if(options.spec.evaluation.id==='attribution'){started++;if(started===16)release();await gate;}else checks++;
   await new Promise(resolve=>setTimeout(resolve,15));
   const result=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));assert.notEqual(result.isError,true,JSON.stringify(result));
  }finally{active--;}
 },async abort(){release();},async dispose(){}};}};
 const workers=await Promise.all(Array.from({length:16},(_,index)=>startWorker(backend,path.join(f.directory,'worker-'+index))));t.after(()=>Promise.all(workers.map(worker=>worker.close())));
 await runEvaluation({...services,taskSource:answerReviewWorkflow,repository:answerReviewRepository,report:reportAnswerReview,
  runId:'concurrency',output:config.output,config,plan,engine:'pi',identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
  modelForStage:f.modelForStage,policy:config.execution,concurrency:16,retries:0,retryDelaySeconds:0,workerUrls:workers.map(worker=>worker.url)});
 assert.equal(peak,16);assert.equal(started,18);assert.equal(checks,18);
 const state=await answerReviewRepository.readRun(path.join(config.output.path,'concurrency'));
 assert.equal(Object.keys(state.receipts).length,36);assert.equal(active,0);
});
