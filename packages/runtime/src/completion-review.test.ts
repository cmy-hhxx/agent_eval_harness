import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DEFAULT_POLICY,emptyUsage,type AgentBinding,type AgentProfile,type AttemptSpec,type AttemptStatus,
  type EvidenceBankUpdate,type FailureContext,type RunRepository,type RunState,type Submission} from '@eval/contracts';
import {AgentRegistry} from '../../host/src/agents.js';
import {RunStore} from '../../host/src/store.js';
import {body,json,listen,request} from './http.js';
import {startWorker} from './server.js';
import {waitForTestState} from '../../../tests/fixtures/wait.js';

for (const mode of ['revised','unsubmitted','invalid','budget'] as const) test('independent completion review '+mode,async()=>{
  const confirm=mode==='revised'||mode==='budget';
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
    if(url.pathname==='/api/evidence-bank')return json(res,await store.registerEvidenceBank(await body(req) as unknown as EvidenceBankUpdate));
    if(url.pathname==='/api/submissions')return json(res,await store.accept(await body(req) as unknown as Submission));
    if(url.pathname.startsWith('/api/submissions/'))return json(res,await store.findSubmission(url.pathname.split('/').at(-1)!));
    if(mode==='revised')await new Promise(resolve=>setTimeout(resolve,1100));
    return json(res,source);
  });
  const directory=await mkdtemp(path.join(tmpdir(),'completion-review-'));
  let sessions=0,runs=0;
  const candidate={summary:'初次归因。',Problem:[]};
  const revised={summary:'独立复核完成。',Problem:[]};
  const worker=await startWorker({identity:engine,async createSession(options){
    const session=++sessions;
    return {async run(prompt){
      runs++;
      if(session===1){
        assert.equal(options.spec.evaluation.systemPrompt,'Review.');
        if(mode==='budget')for(let i=0;i<4;i++)assert(!(await options.execute('read_trace',{candidate:'answer',message_index:0,path:'/content'})).isError);
        const pending=await options.execute('submit_evaluation',candidate);
        assert.equal(pending.terminate,true);assert.equal(await store.receipt('task'),undefined);
        return;
      }
      assert.equal(session,2);assert.equal(options.spec.evaluation.systemPrompt,profile.completionReview);
      assert.deepEqual(JSON.parse(prompt),{initial_result:candidate});
      assert.equal(options.spec.recovery,undefined);
      if(mode==='unsubmitted')return;
      if(mode==='budget')assert.equal((await options.execute('read_trace',{candidate:'answer',message_index:0,path:'/content'})).isError,true);
      if(mode==='invalid'){
        await options.execute('confirm_evaluation',{decision:'未完成',reason:'材料处理主体未采集。'});return;
      }
      assert.equal((await options.execute('submit_evaluation',revised)).terminate,true);
    },async abort(){},async dispose(){}};
  }},directory);
  const prepared=agents.prepare(binding),spec:AttemptSpec={runId:'test',taskId:'task',attemptId:'attempt',inputRevision:1,engine,
    evaluation:prepared.evaluation,policy:{...DEFAULT_POLICY,repairAttempts:mode==='budget'?1:0,maxToolCalls:1,idleTimeoutSeconds:1},prompt:'Review.',evidenceBank:[],
    inputs:[{id,name:'answer'}],hostUrl:host.url,deadline:Date.now()+10000,
    model:{provider:'test',baseUrl:'http://127.0.0.1',api:'openai-completions',apiKeyEnv:'TEST_KEY',model:'test',thinking:'off',contextWindow:10000,maxOutputTokens:1000}};
  try{
    await store.activate(spec);await request(worker.url+'/api/attempts','POST',spec);
    const status=await waitForTestState(()=>request<AttemptStatus>(worker.url+'/api/attempts/attempt'),value=>value.state!=='running','completion review did not finish');
    assert.equal(status.state,confirm?'succeeded':'failed',status.error);
    const receipt=await store.receipt('task');
    assert.equal(sessions,2);assert.equal(runs,2);
    if(confirm){assert.equal(receipt?.submissionStats?.contentSubmissions,1);assert(receipt?.completionReview?.reason);assert.deepEqual(receipt?.evaluation,revised);}
    else {assert.equal(receipt,undefined);assert.equal(status.failure?.errors.some(e=>e.code==='completion_review_incomplete'),true);}
  }finally{await worker.close();await host.close();await rm(directory,{recursive:true,force:true});}
});
