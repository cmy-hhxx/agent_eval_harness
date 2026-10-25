import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, emptyUsage, HttpError, ValidationError, type AgentBinding, type AgentProfile, type AttemptSpec,
  type RunRepository, type RunState, type Submission } from '@eval/contracts';
import { AgentRegistry } from './agents.js';
import { RunStore } from './store.js';
const id = '11111111-1111-4111-8111-111111111111';
const reviewRequired = (error: unknown) => error instanceof HttpError && error.issues?.some(issue => issue.code === 'completion_review_required') === true;
async function fixture(focused=false, required=false) {
  const source = { messages: [{content:'本次实际交付与来源'}] };
  const binding: AgentBinding = {agent:'reads',profile:'default',request:{input:{},sources:{answer:{id,value:source}}}};
  let validations = 0, bindings = 0, rejectBusiness = false;
  const profile: AgentProfile = {
    id:'default',requestSchema:{type:'object'},submissionSchema:{type:'object',additionalProperties:false,
      required:['summary','Problem'],properties:{summary:{type:'string'},Problem:{type:'array'}}},
    systemPrompt:'Review.',instructions:'Review.',submissionNudge:'Submit.',fileSubmission:false,
    toolNames:[],toolDescriptions:{submit_evaluation:'Submit.'},renderPrompt:()=> 'Review.',
    completionReview:'Review summary against registered problems and sources; explain before confirming.',
    ...(focused?{completionReviewContext:()=>({problems:[{attribution_reason:'参数生成时形成缺陷。'}],choices:[{component:'Expert 推理轮'}],...(required?{read_requests:[{candidate:'answer',message_index:0,kind:'text',path:'/content',start:0,end:4}]}:{})})}:{}),
    validate() {validations++;if(rejectBusiness)throw new ValidationError([{category:'evidence',code:'missing_evidence',path:'/',message:'Evidence incomplete.'}]);},
  };
  const agents = new AgentRegistry([{id:'reads',profiles:{default:profile}}]);
  const task = {id:'read-task',stage:'reads',inputIds:{answer:id},dependencies:{},data:{}};
  const engine = { engine: "pi" as const, version: "test", commit: "test", buildId: "test" };
  const state: RunState = { manifest: { format: "evaluation-run", runId: "read-test", debug: false, status: "running",
    engine, evaluatorVersion: "fixture", config: {}, tasks: [task], inputs: { [id]: { id, name: "answer" } },
    states: { [task.id]: { status: "pending", attempts: 0 } }, preflight: {}, startedAt: Date.now() },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const repository: RunRepository = { async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() {}, createResultWriter() { return async () => {}; } };
  const store = new RunStore("/unused-fixture", state, { [id]: { traces: [source] } },
    { agents, repository, taskSource: { id: "reads", bind: () => { bindings++; return binding; } } });
  const prepared = agents.prepare(binding);
  const spec: AttemptSpec = { runId: "read-test", taskId: task.id, attemptId: "attempt", inputRevision: 1, engine,
    evaluation: prepared.evaluation, policy: { ...DEFAULT_POLICY, maxToolCalls: 0 }, prompt: "Read sources.",
    evidenceBank: [], inputs: [{ id, name: "answer" }], hostUrl: "http://127.0.0.1", deadline: Date.now() + 60000,
    model: { provider: "fixture", baseUrl: "http://127.0.0.1", api: "openai-completions", apiKeyEnv: "FIXTURE_KEY",
      model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } };
  await store.activate(spec);
  const submission: Submission = { taskId: task.id, attemptId: spec.attemptId, submissionId: "first", evaluation: {summary:"已核查最终交付及对应来源，未发现成立缺陷。",Problem:[]},
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [],
      calculations: [], artifacts: [], tableChecks: [], evidenceBank: [] } };

  return {store,state,spec,submission,validations:()=>validations,bindings:()=>bindings,rejectBusiness:()=>{rejectBusiness=true;}};
}

test('initial candidate is provisional and one independent revision becomes final',async()=>{
 const f=await fixture(true);
 await assert.rejects(f.store.accept(f.submission),reviewRequired);
 assert.equal(await f.store.receipt(f.spec.taskId),undefined);
 assert.deepEqual(f.state.manifest.states[f.spec.taskId].failure?.draft,f.submission.evaluation);
 await assert.rejects(f.store.accept({...f.submission,submissionId:'same-session'}),
   (e:unknown)=>e instanceof HttpError&&e.issues?.some(i=>i.code==='completion_review_stale')===true);
 const revised={summary:'核对原始返回后修正组件。',Problem:[{component:'finquery 取数服务'}]};
 const receipt=await f.store.accept({...f.submission,submissionId:'reviewed',evaluation:revised,
   completionReview:{candidateId:'first',reason:'独立复核'}});
 assert.deepEqual(receipt.evaluation,revised);assert.equal(f.validations(),2);assert.equal(f.bindings(),1);
});

test('an independently reviewed empty Problem is acceptable without a component quota',async()=>{
 const f=await fixture();await assert.rejects(f.store.accept(f.submission),reviewRequired);
 const receipt=await f.store.accept({...f.submission,submissionId:'reviewed',completionReview:{candidateId:'first',reason:'独立复核'}});
 assert.deepEqual((receipt.evaluation as {Problem:unknown[]}).Problem,[]);
});

test('a failed independent revision cannot be repaired or revive the initial candidate',async()=>{
 const f=await fixture();await assert.rejects(f.store.accept(f.submission),reviewRequired);
 await assert.rejects(f.store.accept({...f.submission,submissionId:'invalid',evaluation:{summary:7,Problem:[]},
   completionReview:{candidateId:'first',reason:'独立复核'}}));
 await assert.rejects(f.store.accept({...f.submission,submissionId:'again',
   completionReview:{candidateId:'first',reason:'再试'}}),/current candidate/);
 assert.equal(await f.store.receipt(f.spec.taskId),undefined);
});

test('independent revision reruns business validation',async()=>{
 const f=await fixture();await assert.rejects(f.store.accept(f.submission),reviewRequired);f.rejectBusiness();
 await assert.rejects(f.store.accept({...f.submission,submissionId:'reviewed',
   completionReview:{candidateId:'first',reason:'独立复核'}}),/Evidence incomplete/);
});

test('independent review cannot accept originals that were not delivered',async()=>{
 const f=await fixture(true,true);await assert.rejects(f.store.accept(f.submission),reviewRequired);
 await assert.rejects(f.store.accept({...f.submission,submissionId:'reviewed',completionReview:{candidateId:'first',reason:'独立复核'}}),
 (e:unknown)=>e instanceof HttpError&&e.issues?.some(i=>i.code==='investigation_read_required')===true);
 assert.equal(await f.store.receipt(f.spec.taskId),undefined);
});
