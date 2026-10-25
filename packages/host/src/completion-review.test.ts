import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, emptyUsage, HttpError, ValidationError, type AgentBinding, type AgentProfile, type AttemptSpec,
  type RunRepository, type RunState, type Submission } from '@eval/contracts';
import { AgentRegistry } from './agents.js';
import { RunStore } from './store.js';
const id = '11111111-1111-4111-8111-111111111111';
const reviewRequired = (error: unknown) => error instanceof HttpError && error.issues?.some(issue => issue.code === 'completion_review_required') === true;
async function fixture() {
  const source = { messages: [{content:'本次实际交付与来源'}] };
  const binding: AgentBinding = {agent:'reads',profile:'default',request:{input:{},sources:{answer:{id,value:source}}}};
  let validations = 0, bindings = 0, rejectBusiness = false;
  const profile: AgentProfile = {
    id:'default',requestSchema:{type:'object'},submissionSchema:{type:'object',additionalProperties:false,
      required:['summary','Problem'],properties:{summary:{type:'string'},Problem:{type:'array'}}},
    systemPrompt:'Review.',instructions:'Review.',submissionNudge:'Submit.',fileSubmission:false,
    toolNames:[],toolDescriptions:{submit_evaluation:'Submit.'},renderPrompt:()=> 'Review.',
    completionReview:'Review summary against registered problems and sources; explain before confirming.',
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

test('Exxon summary with missing Problem records is provisional, never a successful receipt', async()=>{
  const f=await fixture();
  const exxon={summary:'存在一处期间错配：把2026-07-24关于截至2026年6月季度的14.72%下修，写成Q3共识过去30天下修14.7%；另有一处未被检索结果支持的50日均线支撑位表述。',Problem:[]};
  await assert.rejects(f.store.accept({...f.submission,evaluation:exxon}),reviewRequired);
  assert.equal(await f.store.receipt(f.spec.taskId),undefined);
  assert.equal(f.state.manifest.states[f.spec.taskId].status,'running');
  assert.deepEqual(f.state.manifest.states[f.spec.taskId].failure?.draft,exxon);
  // The same reviewer must register the actual defects, then explicitly review this latest candidate.
  const corrected={...exxon,Problem:[{text:'EPS期间错配',reason:'来源为截至6月季度，交付将其当作Q3预期。'},
    {text:'MA50支撑无据',reason:'相关来源没有支持该均线数值。'}]};
  await assert.rejects(f.store.accept({...f.submission,submissionId:'corrected',evaluation:corrected}),reviewRequired);
  const receipt=await f.store.accept({...f.submission,submissionId:'confirmed',evaluation:corrected,
    completionReview:{candidateId:'corrected',reason:'摘要两项缺陷均已登记，并分别保留对应来源及限定。'}});
  assert.deepEqual(receipt.evaluation,corrected);
  assert.equal(f.validations(),3);
  assert.equal(f.bindings(),1, 'one attempt reuses material while each submission is fully validated');
});

test('an actually reviewed empty Problem remains acceptable without a minimum problem count',async()=>{
  const f=await fixture();
  await assert.rejects(f.store.accept(f.submission),reviewRequired);
  const receipt=await f.store.accept({...f.submission,submissionId:'confirmed',
    completionReview:{candidateId:'first',reason:'已核查实际交付及来源，结论保持原文范围，未形成缺陷。'}});
  assert.equal(receipt.status,'succeeded');
  assert.deepEqual((receipt.evaluation as {Problem:unknown[]}).Problem,[]);
  assert.equal(f.validations(),2);
});

test('a repaired candidate invalidates the earlier review and confirmation reruns business validation',async()=>{
  const f=await fixture();
  await assert.rejects(f.store.accept(f.submission),reviewRequired);
  const invalid={...f.submission,submissionId:'invalid',evaluation:{summary:7,Problem:[]}};
  await assert.rejects(f.store.accept(invalid));
  await assert.rejects(f.store.accept({...f.submission,submissionId:'stale',
    completionReview:{candidateId:'first',reason:'Cannot confirm an older candidate.'}}),/current candidate/);
  const repaired={...f.submission,submissionId:'repaired'};
  await assert.rejects(f.store.accept(repaired),reviewRequired);
  assert.deepEqual(f.state.manifest.states[f.spec.taskId].failure?.completionCandidate?.previous,f.submission.evaluation);
  f.rejectBusiness();
  await assert.rejects(f.store.accept({...repaired,submissionId:'confirmed',
    completionReview:{candidateId:'repaired',reason:'Reviewed the repaired candidate.'}}),/Evidence incomplete/);
  assert.equal(await f.store.receipt(f.spec.taskId),undefined);
});
