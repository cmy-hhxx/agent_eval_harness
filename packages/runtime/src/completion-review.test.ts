import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DEFAULT_POLICY,emptyUsage,type AgentBinding,type AgentProfile,type AttemptSpec,type AttemptStatus,
  type FailureContext,type RunRepository,type RunState,type Submission} from '@eval/contracts';
import {AgentRegistry} from '../../host/src/agents.js';
import {RunStore} from '../../host/src/store.js';
import {body,json,listen,request} from './http.js';
import {startWorker} from './server.js';
import {waitForTestState} from '../../../tests/fixtures/wait.js';

for (const mode of ['confirm','unconfirmed','replace'] as const) test('same-session completion review '+mode,async()=>{
  const confirm=mode==='confirm';
  const id='11111111-1111-4111-8111-111111111111',source={messages:[{content:'实际交付与来源'}]};
  const binding:AgentBinding={agent:'review',profile:'default',request:{input:{},sources:{answer:{id,value:source}}}};
  const profile:AgentProfile={id:'default',requestSchema:{type:'object'},submissionSchema:{type:'object'},
    fileSubmission:false,toolNames:['read_trace'],toolDescriptions:{read_trace:'Read source.',submit_evaluation:'Submit.'},
    systemPrompt:'Review.',instructions:'Review.',submissionNudge:'Finish review.',renderPrompt:()=> 'Review.',
    completionReview:'Check summary against registered problems and actual sources. Explain before confirming.'};
  const agents=new AgentRegistry([{id:'review',profiles:{default:profile}}]);
  const task={id:'task',stage:'review',inputIds:{answer:id},dependencies:{},data:{}};
  const engine={engine:'pi' as const,version:'test',commit:'test',buildId:'test'};
  const state:RunState={manifest:{format:'evaluation-run',runId:'test',debug:false,status:'running',engine,evaluatorVersion:'test',
    config:{},tasks:[task],inputs:{[id]:{id,name:'answer'}},states:{task:{status:'pending',attempts:0}},preflight:{},startedAt:Date.now()},
    receipts:{},usage:emptyUsage(),recordedAttempts:0};
  const repository:RunRepository={async readRun(){return state;},async readTasks(){return state;},async writeRun(){},createResultWriter(){return async()=>{};}};
  const store=new RunStore('/unused-fixture',state,{[id]:source},{agents,repository,taskSource:{id:'review',bind:()=>binding}});
  const host=await listen(async(req,res,url)=>{
    if(url.pathname.endsWith('/checkpoint')){await store.checkpoint(task.id,await body(req) as unknown as FailureContext);return json(res,{saved:true});}
    if(url.pathname==='/api/submissions')return json(res,await store.accept(await body(req) as unknown as Submission));
    if(url.pathname.startsWith('/api/submissions/'))return json(res,await store.findSubmission(url.pathname.split('/').at(-1)!));
    if(confirm)await new Promise(resolve=>setTimeout(resolve,1100));
    return json(res,source);
  });
  const directory=await mkdtemp(path.join(tmpdir(),'completion-review-'));
  let runs=0;
  const worker=await startWorker({identity:engine,async createSession(options){return {async run(){
    if(runs++)return;
    const candidate={summary:'已核查实际交付及来源，未发现成立缺陷。',Problem:[]};
    const pending=await options.execute('submit_evaluation',candidate);
    assert.equal(pending.terminate,undefined);
    assert.equal((pending.details as {review_pending:boolean}).review_pending,true);
    assert.equal((pending.details as {next_tool:string}).next_tool,'confirm_evaluation');
    assert.equal(await store.receipt('task'),undefined);
    if(mode==='replace'){
      const replacement=await options.execute('submit_evaluation',{summary:'修正后的实际结论',Problem:[]});
      assert.equal(replacement.isError,true);
      await assert.rejects(()=>options.execute('confirm_evaluation',{reason:'Cannot use the old candidate after an exhausted replacement.'}));
      return;
    }
    if(confirm){
      const result=await options.execute('confirm_evaluation',{reason:'已将摘要与本次交付逐项核对，无已成立而未登记的问题。'});
      assert.equal(result.terminate,true);
    }
  },async abort(){},async dispose(){}};}},directory);
  const prepared=agents.prepare(binding),spec:AttemptSpec={runId:'test',taskId:'task',attemptId:'attempt',inputRevision:1,engine,
    evaluation:prepared.evaluation,policy:{...DEFAULT_POLICY,repairAttempts:0,maxToolCalls:1,idleTimeoutSeconds:1},prompt:'Review.',evidenceBank:[],
    inputs:[{id,name:'answer'}],hostUrl:host.url,deadline:Date.now()+10000,
    model:{provider:'test',baseUrl:'http://127.0.0.1',api:'openai-completions',apiKeyEnv:'TEST_KEY',model:'test',thinking:'off',contextWindow:10000,maxOutputTokens:1000}};
  try{
    await store.activate(spec);await request(worker.url+'/api/attempts','POST',spec);
    const status=await waitForTestState(()=>request<AttemptStatus>(worker.url+'/api/attempts/attempt'),value=>value.state!=='running','completion review did not finish');
    assert.equal(status.state,confirm?'succeeded':'failed',status.error);
    const receipt=await store.receipt('task');
    if(confirm){assert.equal(receipt?.submissionStats?.contentSubmissions,1);assert(receipt?.completionReview?.reason);}
    else {assert.equal(receipt,undefined);assert.equal(status.failure?.errors.some(e=>e.code==='completion_review_required'),true);}
  }finally{await worker.close();await host.close();await rm(directory,{recursive:true,force:true});}
});
