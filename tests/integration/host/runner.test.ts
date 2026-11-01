import { submitFor, draftFor, invalidDraft, taskResult } from "../../fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import type { AgentBackend, AttemptRecord } from "@eval/contracts";
import type { SessionAttributionResult } from "@eval/agents/attribution";
import { createFileLogger, exists, hasLiveRunOwner, internalPath, readJson, readJsonl, writeJsonl } from "@eval/data";
import { loadRunInputs } from "@eval/workflows/inputs";
import { readRunState } from "@eval/workflows/comparison";
import { startWorker } from "@eval/runtime/worker";
import { body, listen } from "@eval/runtime/http";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { inspectMaterials, inspectFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, optionalVerificationTask, raw } from "../../fixtures/comparison.js";

test('expensive admission serves Host control before the whole cohort is prepared',async t=>{
  const rows=Array.from({length:8},(_,i)=>raw('yield-'+i)),f=await fixtureConfig([rows,[],rows,[]]);
  t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const complete=await buildPlan(f.config),plan={...complete,tasks:complete.tasks.filter(task=>task.stage==='criteria')};
  let started=0,prepared=0,controlServed=false,servedBeforeLast=false;
  const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return{async run(){started++;const result=await submitFor(options,taskResult(options.spec));assert.notEqual(result.isError,true);},async abort(){},async dispose(){}};}};
  const workers=await Promise.all(Array.from({length:8},(_,i)=>startWorker(backend,path.join(f.directory,'yield-worker-'+i))));
  t.after(()=>Promise.all(workers.map(worker=>worker.close())));
  const taskSource={...services.taskSource,bind(...args:Parameters<typeof services.taskSource.bind>){
    if(prepared===0){const lock=JSON.parse(readFileSync(path.join(f.config.output.path,'yield-admission/.run-lock'),'utf8'));
      void fetch(lock.url+'/api/progress',{headers:{'x-run-token':lock.token}}).then(response=>{controlServed=response.ok;}).catch(()=>{});}
    const until=performance.now()+35;while(performance.now()<until){};
    if(++prepared===plan.tasks.length)servedBeforeLast=controlServed;
    return services.taskSource.bind(...args);
  }};
  await runEvaluation({...services,taskSource,report:async()=>({}),runId:'yield-admission',output:f.config.output,config:f.config,plan,
    engine:'pi',identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,modelForStage:f.modelForStage,policy:f.config.execution,
    concurrency:8,retries:0,retryDelaySeconds:0,workerUrls:workers.map(worker=>worker.url)});
  assert.equal(started,8);assert(servedBeforeLast,'preparing the cohort must not starve Host HTTP and model admission');
});

test("a failed checkpoint save during cleanup still releases the Host lock", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config), runId = "failed-save-unlocks";
    await assert.rejects(runEvaluation({ ...services, runId, output: config.output, config, engine: "pi",
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, plan, policy: config.execution, modelForStage,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [],
      repository: { ...services.repository, async writeRun() { throw new Error("checkpoint save failed"); } },
    }), /checkpoint save failed/);
    assert.equal(await hasLiveRunOwner(path.join(config.output.path, runId)), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stage content limits stop rejected attribution after its first submission even when global repairs are enabled",async()=>{
  const {directory,config,modelForStage}=await fixtureConfig([[raw()],[],[raw()],[]]);
  config.execution.repairAttempts=3;config.execution.stageRepairAttempts={"attribution-compact-field":0};
  const plan=await buildPlan(config),calls=new Map<string,number>();
  const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return {
    async run(){
      calls.set(options.spec.taskId,(calls.get(options.spec.taskId)??0)+1);
      if(options.spec.evaluation.id==="compact"){
        assert.equal(options.spec.policy.repairAttempts,0);
        assert.equal((await submitFor(options,invalidDraft(options.spec))).isError,true);
      }else assert.equal((await submitFor(options,draftFor(options.spec,taskResult(options.spec)))).terminate,true);
    },async abort(){},async dispose(){},
  };}};
  const worker=await startWorker(backend,path.join(directory,"worker"));
  try{
    await runEvaluation({...services,runId:"first-submission",output:config.output,config,engine:"pi",identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
      plan,policy:config.execution,modelForStage,concurrency:1,retries:1,retryDelaySeconds:0,
      failureGuard:{enabled:false,windowSize:50,threshold:5},workerUrls:[worker.url]});
    const state=await readRunState(path.join(config.output.path,"first-submission"));
    const components=plan.tasks.filter(task=>task.stage==="attribution-compact-field");
    assert(components.length>0);
    for(const task of components){
      assert.equal(calls.get(task.id),1);assert.equal(state.manifest.states[task.id].status,"failed");
      assert.equal(state.manifest.states[task.id].failure?.contentSubmissions,1);
    }
  }finally{await worker.close();await rm(directory,{recursive:true,force:true});}
});

test("two workers preserve same-run receipts and honor explicitly requested reevaluation across runs", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  const plan = await buildPlan(config), calls = new Map<string, number>();
  const workerDirectories = ["w1", "w2"].map(name => path.join(directory, name));
  const workers = await Promise.all(workerDirectories.map(workdir => startWorker({
    identity: fakeIdentity, async createSession(options) { return {
      async run() {
        calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
        if (options.spec.evaluation.id === "compact")
          assert.equal(options.spec.policy.maxToolCalls, 0);
        const accepted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        assert.equal(accepted.terminate, true);
      }, async abort() {}, async dispose() {},
    }; },
  }, workdir)));
  try {
    const options = { ...services, runId: "first", output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, modelForStage, concurrency: 2, retries: 0, retryDelaySeconds: 0,
      workerUrls: workers.map(worker => worker.url) };
    const summary = await runEvaluation(options), run = path.join(config.output.path, options.runId);
    const saved = await readRunState(run);
    assert.equal(summary.completed_comparisons, plan.tasks.filter(task => task.stage === "comparison").length);
    assert.equal(Object.keys(saved.receipts).length, saved.manifest.tasks.length);
    for (const task of saved.manifest.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded", task.stage);
      assert.equal(calls.get(task.id), services.taskSource.isComputedTask?.(task) ? undefined : 1);
    }
    for (const file of ["state.json", "overview.json", "stats.json", "report.md", "task_summaries.md"])
      assert.equal(await exists(path.join(run, file)), true, file);
    const attributionRows = [];
    for await (const row of readJsonl(path.join(run, "results/attribution.jsonl"))) attributionRows.push(row);
    assert.equal(attributionRows.length, plan.tasks.filter(task => task.stage === "attribution-session").length);
    const problem = (attributionRows[0] as SessionAttributionResult).turns[0].problem[0];
    assert.equal(problem.severity, "P0");
    assert.equal(problem.severity_reason, "加法结果是本题的核心交付，数值错误使回答不可采信。");
    const details = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert(details.includes(`**${problem.severity}｜${problem.problem_phenomena}**`));
    assert(details.includes(`严重程度依据：${problem.severity_reason}`));
    assert.deepEqual(await loadRunInputs(saved.manifest), plan.inputs);
    assert.equal(await exists(path.join(run, "inputs")), false);
    assert.equal(await exists(internalPath(run)), false);
    assert.equal((await validateRun(run)).valid, true);
    const callsBeforeResume = new Map(calls);
    await runEvaluation(options);
    assert.deepEqual(calls, callsBeforeResume, "accepted tasks do not execute on same-run resume");
    const resumed = await readRunState(run);
    for (const [id, receipt] of Object.entries(saved.receipts))
      assert.equal(resumed.receipts[id].submissionId, receipt.submissionId);
    const independent = await runEvaluation({ ...options, runId: "second" });
    assert.equal(independent.completed_comparisons, summary.completed_comparisons);
    assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), saved.manifest.tasks.filter(task => !services.taskSource.isComputedTask?.(task)).length * 2,
      "another run independently executes the complete graph");
    assert.equal((await validateRun(path.join(config.output.path, "second"))).valid, true);
    for (const workdir of workerDirectories)
      assert.deepEqual((await readdir(workdir)).filter(name => name !== "materials"), []);
  } finally { await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true }); }
});

test("pausing drains an accepted task and preserves pending work for the same run", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const pause = new AbortController();
  let started = 0, aborted = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      started++; pause.abort();
      await inspectFor(options);
      const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() { aborted++; }, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "pause-worker"));
  try {
    const options = { ...services, runId: "pause-drain", output: config.output, config, plan: await buildPlan(config),
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const result = await runEvaluation({ ...options, pauseSignal: pause.signal });
    assert.equal(result.status, "interrupted"); assert.equal(started, 1); assert.equal(aborted, 0);
    const saved = await readRunState(path.join(config.output.path, options.runId));
    assert.equal(Object.keys(saved.receipts).length, 1);
    assert(Object.values(saved.manifest.states).some(state => state.status === "pending"));
    assert(!Object.values(saved.manifest.states).some(state => state.status === "cancelled"));
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stopping concurrent attempts never trips the stage circuit and the same run resumes", async () => {
  const rows = [raw("one"), raw("two")];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController();
  let started = 0, resume = false;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      let release = () => {};
      return {
        async run() {
          await inspectFor(options);
          if (!resume) {
            const stopped = new Promise<void>((resolve) => { release = resolve; });
            if (++started === 2) controller.abort();
            await stopped;
          } else {
            const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
            assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          }
        },
        async abort() { release(); },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all([0, 1].map((i) => startWorker(backend, path.join(directory, "worker-" + i))));
  try {
    const options = {
      ...services, runId: "stop-concurrent", output: config.output, config, plan: await buildPlan(config),
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 2, retries: 1, retryDelaySeconds: 0,
      failureGuard: { windowSize: 4, threshold: 2 }, workerUrls: workers.map((worker) => worker.url),
    };
    const stopped = await runEvaluation({ ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    assert.equal(stopped.status, "interrupted");
    assert.equal(started, 2);
    assert.deepEqual(stopped.paused_stages, [], "normal shutdown must not persist a circuit pause");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    assert.deepEqual(saved.manifest.pausedStages, []);
    assert(Object.values(saved.manifest.states).every((state) => state.status === "cancelled"));
    resume = true;
    const result = await runEvaluation({ ...options, signal: AbortSignal.timeout(15_000) });
    assert.equal(result.status, "finished");
    assert.equal(result.completed_comparisons, 2);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host persists a retry deadline before another Criteria attempt and clears it after recovery", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const plan = await buildPlan(config), target = plan.tasks.find(task => task.stage === "criteria")!;
  assert(target);
  const runId = "retry-deadline", run = path.join(config.output.path, runId), starts: number[] = [];
  let retryAt: number | undefined, observation: Promise<void> | undefined, observationError: unknown;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    starts.push(Date.now());
    return { async run() {
      if (starts.length === 1) options.onEvent({ type: "message_end", message: {
        role: "assistant", stopReason: "error", errorMessage: "Connection error.",
      } });
      else assert.equal((await submitFor(options, taskResult(options.spec))).terminate, true);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const timer = setInterval(() => {
    if (observation || retryAt !== undefined) return;
    observation = readRunState(run).then(saved => {
      retryAt ??= saved.manifest.states[target.id]?.nextRetryAt;
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") observationError = error;
    }).finally(() => { observation = undefined; });
  }, 10);
  try {
    await runEvaluation({ ...services, runId, output: config.output, config, plan, taskIds: [target.id],
      modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: .2,
      workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) });
    clearInterval(timer); await observation;
    if (observationError) throw observationError;
    assert.equal(starts.length, 2);
    assert(retryAt, "the pending retry must be observable through durable run state");
    assert(starts[1]! >= retryAt, "the replacement attempt waits for its saved deadline");
    const saved = await readRunState(run);
    assert.equal(saved.manifest.states[target.id].status, "succeeded");
    assert.equal(saved.manifest.states[target.id].attempts, 2);
    assert.equal(saved.manifest.states[target.id].nextRetryAt, undefined);
  } finally { clearInterval(timer); await observation; await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an unknown final submission ledger stops automatic retries and permits explicit same-run resume", async (t) => {
  const input = raw("unknown-content-ledger", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  config.execution.repairAttempts = 3;
  const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "criteria")!;
  let attempts = 0, submissions = 0, resumed = false, hideLedger = false;
  let failedAttemptId: string | undefined;
  const repairBudgets: number[] = [];
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    const targeted = options.spec.taskId === target.id;
    if (targeted) { attempts++; repairBudgets.push(options.spec.policy.repairAttempts); }
    return { async run() {
      await inspectFor(options);
      const draft = draftFor(options.spec, taskResult(options.spec));
      if (!targeted || resumed || attempts > 1) {
        if (targeted) submissions++;
        const accepted = await submitFor(options, draft);
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        return;
      }
      failedAttemptId = options.spec.attemptId;
      for (let index = 0; index < 3; index++) {
        const rejected = { ...(invalidDraft(options.spec) as Record<string, unknown>), [`invalid_${++submissions}`]: index };
        assert.equal((await submitFor(options, rejected)).isError, true);
      }
      submissions++;
      const unacknowledged = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(unacknowledged.isError, true);
      assert.match(unacknowledged.content[0]!.text!, /HTTP 503/);
      hideLedger = true;
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url));
    if (!resumed && init?.method === "POST" && request.pathname === "/api/submissions") {
      const submission = JSON.parse(String(init.body));
      if (submission.taskId === target.id && submission.submissionStats.contentSubmissions === 4)
        return Response.json({ error: "HTTP 503 submission connection unavailable" }, { status: 503 });
    }
    if (!resumed && hideLedger && request.origin === worker.url &&
      [ `/api/attempts/${failedAttemptId}`, `/api/attempts/${failedAttemptId}/record` ].includes(request.pathname) &&
      (!init?.method || init.method === "GET"))
      return Response.json({ error: "HTTP 503 final ledger unavailable" }, { status: 503 });
    return fetch(url, init);
  });
  try {
    const options = { ...services, runId: "unknown-content-ledger", output: config.output, config, plan,
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) };
    await runEvaluation(options);
    assert.equal(attempts, 1, "an unobservable fourth submission cannot create an automatic fifth submission");
    assert.equal(submissions, 4);
    const run = path.join(config.output.path, options.runId), saved = await readRunState(run);
    const state = saved.manifest.states[target.id];
    assert.equal(state.failure?.contentSubmissions, 3, "only acknowledged checkpoints are recorded as known costs");
    assert(state.failure?.errors.some((issue) => issue.code === "submission_ledger_unavailable"));
    assert.match(state.reason!, /无法确认剩余内容额度/);
    assert.equal(saved.receipts[target.id], undefined);
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(repairBudgets, [3, 0], "explicit resume spends only the allowance left after acknowledged historical submissions");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a socket closed before worker dispatch retries the same attempt without duplicating a model session", async (t) => {
  const {directory,config,modelForStage}=await fixtureConfig([[raw()],[],[raw()],[]]);
  const plan=await buildPlan(config),target=plan.tasks.find(task=>task.stage==='criteria')!;
  let sessions=0;const attempts:string[]=[];
  const worker=await startWorker({identity:fakeIdentity,async createSession(options){sessions++;return {
    async run(){const accepted=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));assert.equal(accepted.isError,undefined,JSON.stringify(accepted));},
    async abort(){},async dispose(){},
  };}},path.join(directory,'worker'));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    if(String(url)===`${worker.url}/api/attempts`&&init?.method==='POST'){
      attempts.push(JSON.parse(String(init.body)).attemptId);
      if(attempts.length===1)throw new TypeError('fetch failed',{cause:Object.assign(new Error('other side closed'),{code:'UND_ERR_SOCKET'})});
    }
    return fetch(url,init);
  });
  try{
    await runEvaluation({...services,runId:'dispatch-reconnect',output:config.output,config,engine:'pi',identity:fakeIdentity,
      evaluatorVersion:fakeEvaluatorVersion,plan,taskIds:[target.id],policy:config.execution,modelForStage,
      concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]});
    const state=await readRunState(path.join(config.output.path,'dispatch-reconnect'));
    assert.equal(state.manifest.states[target.id].status,'succeeded',state.manifest.states[target.id].reason);
    assert.equal(state.manifest.states[target.id].attempts,1);assert.equal(sessions,1);
    assert.equal(attempts.length,2);assert.equal(attempts[0],attempts[1]);
  }finally{await worker.close();await rm(directory,{recursive:true,force:true});}
});

test("a rejected worker start with no registered attempt can retry without spending content", async (t) => {
  const input = raw("rejected-worker-start", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "criteria")!;
  let starts = 0, sessions = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (options.spec.taskId === target.id) sessions++;
    return { async run() {
      await inspectFor(options);
      const accepted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url));
    if (request.origin === worker.url && request.pathname === "/api/attempts" && init?.method === "POST" &&
      JSON.parse(String(init.body)).taskId === target.id && ++starts === 1)
      return Response.json({ error: "Worker busy" }, { status: 409 });
    return fetch(url, init);
  });
  try {
    const runId = "rejected-worker-start";
    const complete = await runEvaluation({ ...services, runId, output: config.output, config, plan,
      modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) });
    assert.equal(starts, 2, "explicit pre-execution rejection preserves the normal transport retry");
    assert.equal(sessions, 1, "the rejected attempt never starts an agent session");
    assert.equal(complete.completed_comparisons, 1);
    const saved = await readRunState(path.join(config.output.path, runId));
    assert.equal(saved.manifest.states[target.id].attempts, 2);
    assert.equal(saved.receipts[target.id].submissionStats?.contentSubmissions, 1);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a task deadline without a submission does not consume the automatic retry budget", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, attempts = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    targetId ??= options.spec.taskId;
    let release = () => {};
    return { async run() {
      await inspectFor(options);
      if (options.spec.taskId === targetId) {
        attempts++;
        await new Promise<void>((resolve) => { release = resolve; });
      } else {
        const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }
    }, async abort() { release(); }, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "unsubmitted-deadline", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: { ...config.execution, timeoutSeconds: 1, idleTimeoutSeconds: 10 }, concurrency: 1,
      retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) });
    const saved = await readRunState(path.join(config.output.path, "unsubmitted-deadline"));
    assert.equal(attempts, 1);
    assert.equal(saved.manifest.states[targetId!].attempts, 1);
    assert.equal(saved.manifest.states[targetId!].status, "timed_out");
    assert.equal(saved.manifest.states[targetId!].reason, "Task deadline exceeded");
    assert.equal(saved.receipts[targetId!], undefined);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same run ID preserves accepted work when the model, budget and evaluator change", async () => {
  const rows = ["2026-09-23", "2026-09-24"].map(batch_id => ({ ...raw("q1", null), batch_id }));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController(), calls = new Map<string, number>();
  let resume = false;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    const id = options.spec.taskId;
    let release = () => {};
    return { async run() {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (!resume && calls.size === 2) {
        const stopped = new Promise<void>(resolve => { release = resolve; });
        controller.abort(); await stopped;
      } else assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() { release(); }, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config), runId = "resume", run = path.join(config.output.path, runId);
    const options = { ...services, runId, output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const stopped = await runEvaluation({ ...options, signal: controller.signal });
    assert.equal(stopped.status, "interrupted");
    const before = await readRunState(run), previousCalls = new Map(calls);
    assert(Object.keys(before.receipts).length > 0, "interruption retains accepted work");
    resume = true;
    const complete = await runEvaluation({ ...options, evaluatorVersion: "fixture-2",
      config: { ...config, inputs: { ...config.inputs, batches: [rows[0]!.batch_id] } },
      modelForStage: stage => ({ ...modelForStage(stage), model: "changed-model" }),
      policy: { ...config.execution, maxToolCalls: config.execution.maxToolCalls + 1 } });
    assert.equal(complete.completed_comparisons, plan.tasks.filter(task => task.stage === "comparison").length);
    const after = await readRunState(run);
    assert.equal(after.manifest.evaluatorVersion, "fixture-2");
    const originalShape = (task: typeof plan.tasks[number]) => task.stage === "attribution-trace" ? { ...task,
      dependencies: Object.fromEntries(Object.entries(task.dependencies).filter(([label]) => !label.startsWith("group:"))), settledDependencies: [] } : task;
    assert.deepEqual(after.manifest.tasks.filter(task => before.manifest.tasks.some(original => original.id === task.id)).map(originalShape),
      before.manifest.tasks.map(originalShape), "resume preserves task identities and blind assignments while Compact can add component dependencies");
    for (const task of after.manifest.tasks) {
      const receipt = after.receipts[task.id], previous = before.receipts[task.id];
      assert.equal(after.manifest.states[task.id].status, "succeeded", task.stage);
      assert.equal(calls.get(task.id), services.taskSource.isComputedTask?.(task) ? undefined : previous ? previousCalls.get(task.id) : (previousCalls.get(task.id) ?? 0) + 1);
      assert.equal(receipt.evaluatorVersion, previous ? previous.evaluatorVersion : "fixture-2");
      assert.equal(receipt.judge, previous ? previous.judge : services.taskSource.isComputedTask?.(task) ? "code" : "changed-model");
      if (previous) assert.equal(receipt.submissionId, previous.submissionId);
    }
    assert.deepEqual(complete.evaluator_versions, [fakeEvaluatorVersion, "fixture-2"].sort());
    assert.equal((await validateRun(run)).valid, true);
    assert.equal(await exists(internalPath(run)), false);
    for (const version of config.inputs.versions)
      await writeJsonl(version.sources[0]!.path, ["a_fast", "b_fast"].includes(version.id)
        ? [...rows, { ...raw("q1", null), batch_id: "2026-09-25" }] : []);
    const callsBeforeAppend = new Map(calls), appendedPlan = await buildPlan(config);
    assert(appendedPlan.tasks.length > plan.tasks.length);
    const unchanged = await runEvaluation({ ...options, plan: appendedPlan });
    assert.equal(unchanged.completed_comparisons, complete.completed_comparisons);
    assert.deepEqual(Object.keys(unchanged.by_batch as object).sort(), rows.map(row => row.batch_id).sort());
    assert.deepEqual(calls, callsBeforeAppend, "unrelated appended source rows do not expand the saved run");
    assert.equal((await validateRun(run)).valid, true);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});


for (const reportedContent of [0, undefined]) test(`a worker's ${reportedContent === undefined ? "missing" : "lower"} final ledger cannot authorize another draft after a Host-confirmed inspection`, async (t) => {
  const input = raw("inspection-final-ledger", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  config.execution.repairAttempts = 3;
  const plan = await buildPlan(config), target = optionalVerificationTask(plan.tasks.find(task => task.stage === "comparison")!);
  plan.tasks.push(target);
  let attempts = 0, resumed = false, targetAttempt: string | undefined, restoredInspection: string | undefined;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    const targeted = options.spec.taskId === target.id;
    if (targeted) { attempts++; targetAttempt = options.spec.attemptId; }
    return { async run() {
      if (targeted && !resumed && attempts === 1) {
        for (let index = 0; index < 2; index++)
          assert.equal((await inspectMaterials(options, { checks: [], concerns: [] })).isError, true);
        await inspectFor(options);
        throw new Error("Connection error after Host acknowledged inspection.");
      }
      await inspectFor(options);
      if (targeted && resumed) {
        restoredInspection = options.spec.recovery?.inspection?.id;
        assert.equal(options.spec.policy.repairAttempts, 0,
          "a confirmed inspection at count three leaves exactly one final submission within the cap of four");
      }
      const value = taskResult(options.spec);
      if (options.spec.evaluation.id === "attribution" && options.spec.evaluation.profile === "component")
        (value as { problems: unknown[] }).problems = [];
      const result = await submitFor(options, draftFor(options.spec, value));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url)), response = await fetch(url, init);
    if (!resumed && targetAttempt && request.origin === worker.url && response.ok &&
      [`/api/attempts/${targetAttempt}`, `/api/attempts/${targetAttempt}/record`].includes(request.pathname) &&
      (!init?.method || init.method === "GET")) {
      const value = await response.json() as { failure?: { contentSubmissions?: number }; status?: { failure?: { contentSubmissions?: number } } };
      for (const failure of [value.failure, value.status?.failure]) if (failure) {
        if (reportedContent === undefined) delete failure.contentSubmissions;
        else failure.contentSubmissions = reportedContent;
      }
      return Response.json(value);
    }
    return response;
  });
  try {
    const options = { ...services, runId: "inspection-final-ledger", output: config.output, config, plan,
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) };
    const failed = await runEvaluation(options), run = path.join(config.output.path, options.runId), saved = await readRunState(run);
    assert.equal(attempts, 1, JSON.stringify(saved.manifest.states[target.id]));
    assert.equal(failed.completed_comparisons, 1, "the failed optional inspection cannot withhold the accepted primary comparison");
    const state = saved.manifest.states[target.id];
    assert.equal(state.failure!.contentSubmissions, 3, "preserve only the acknowledged historical count without inventing unknown costs");
    assert(state.failure!.inspection); assert(state.failure!.errors.some(issue => issue.code === "submission_ledger_unavailable"));
    assert.equal(saved.receipts[target.id], undefined);
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1); assert.equal(attempts, 2);
    const recovered = (await readRunState(run)).receipts[target.id];
    assert.equal(recovered.submissionStats!.contentSubmissions, 4);
    assert.equal(restoredInspection, state.failure!.inspection!.id,
      "the resumed session receives the real Host inspection rather than creating another one");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});


test("terminal archival drains the actual worker event sequence before compressing", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const plan = await buildPlan(config);
  plan.tasks = plan.tasks.filter(task => task.stage === "criteria");
  let calls = 0;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          for (let index = 0; index < 2200; index++) options.onEvent({ type: "text_delta", delta: "x" });
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    await runEvaluation({
      runId: "event-backlog", debug: true, output: config.output, engine: "pi", identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion, config, ...services, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url],
      onEvent() {
        // A deterministic slow durable consumer recreates the terminal poll outrunning its sink.
        const until = performance.now() + 1; while (performance.now() < until) {}
      },
    });
    assert.equal(calls, 1);
    const task = plan.tasks[0]!;
    const attempt = path.join(config.output.path, "event-backlog", "_internal", "tasks", task.id, "attempt-001");
    const record = await readJson<AttemptRecord>(path.join(attempt, "attempt.json"));
    const events: { seq: number; type: string }[] = [];
    for await (const event of readJsonl(path.join(attempt, "events.jsonl.gz"))) events.push(event as { seq: number; type: string });
    assert.equal(events.at(-1)?.seq, record.status!.lastSeq, "terminal archive must reach its authoritative worker lastSeq");
    assert.equal(events.at(-1)?.type, "finished");
    assert.deepEqual(await readdir(path.join(directory, "worker")), ["materials"], "release requires the complete durable archive");
    assert.deepEqual(await readdir(path.join(directory, "worker/materials")), [], "finished sessions retain no shared material");
  } finally {
    await worker.close(); await rm(directory, { recursive: true, force: true });
  }
});


test("incomplete terminal SSE preserves the worker and reports a missing archive without reevaluating", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  config.execution.idleTimeoutSeconds = 1;
  const plan = await buildPlan(config);
  plan.tasks = plan.tasks.filter(task => task.stage === "criteria");
  const calls = new Map<string, number>();
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1); await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const proxy = await listen(async (req, res, url) => {
    if (url.pathname.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (url.searchParams.get("after") !== "0") { res.end(); return; }
      const upstream = await fetch(worker.url + url.pathname + url.search);
      const reader = upstream.body!.getReader(); let first = "";
      while (!first.includes("\n\n")) {
        const next = await reader.read(); if (next.done) break;
        first += new TextDecoder().decode(next.value);
      }
      res.end(first.slice(0, first.indexOf("\n\n") + 2)); await reader.cancel(); return;
    }
    const upstream = await fetch(worker.url + url.pathname + url.search, { method: req.method,
      ...(req.method === "POST" ? { body: JSON.stringify(await body(req)), headers: { "content-type": "application/json" } } : {}) });
    res.writeHead(upstream.status, { "content-type": "application/json" }); res.end(await upstream.text());
  });
  const options = {
    runId: "incomplete-events", debug: true, output: config.output, engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, ...services, plan, policy: config.execution,
    modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [proxy.url],
    logger: createFileLogger({ directory: path.join(directory, "log"), lockDirectory: path.join(directory, "locks") }),
  };
  try {
    await runEvaluation(options);
    const task = plan.tasks[0]!;
    const run = path.join(config.output.path, "incomplete-events");
    const attempt = path.join(run, "_internal", "tasks", task.id, "attempt-001");
    const record = await readJson<AttemptRecord>(path.join(attempt, "attempt.json"));
    assert.match(record.artifactError!, /Terminal event archive incomplete/);
    assert.equal(await exists(path.join(attempt, "events.jsonl")), true);
    assert.equal(await exists(path.join(attempt, "events.jsonl.gz")), false, "a known prefix must never become a compressed terminal archive");
    const state = await readRunState(run);
    assert.equal(state.manifest.states[task.id]!.status, "succeeded", "accepted evaluation survives a missing debug archive");
    assert.equal(state.manifest.states[task.id]!.artifactStatus?.status, "missing");
    assert.deepEqual((await readdir(path.join(directory, "worker"))).sort(), [record.spec.attemptId, "materials"].sort());
    assert.deepEqual(await readdir(path.join(directory, "worker/materials")), [], "archive retention does not retain shared material");
    assert.match(await readFile(path.join(directory, "log/runtime.log"), "utf8"), /event_archive_incomplete/);
    await runEvaluation(options); assert.equal(calls.get(task.id), 1, "resume may add pending workflow tasks but must not reevaluate the committed task to repair debug output");
  } finally {
    await proxy.close(); await worker.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("a streamed plan dispatches as soon as its first file is read under batch task capacity", async t => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) { return {
    async run() { await inspectFor(options); await submitFor(options, draftFor(options.spec, taskResult(options.spec))); },
    async abort() {}, async dispose() {},
  }; } }, path.join(f.directory, "worker"));
  t.after(() => worker.close());
  const plan = await buildPlan(f.config);
  // Batch fair share grants no task slot while every run reports zero demand, and a streamed
  // plan has no task before its first file is read: the idle pass must not freeze at zero.
  const taskSource = { ...services.taskSource, shards: () => {
    let sent = false;
    return { async next() {
      if (sent) return undefined;
      sent = true;
      await new Promise(resolve => setTimeout(resolve, 50));
      return { source: "fixture.jsonl", revision: "1", candidates: plan.catalog ?? [], tasks: plan.tasks, inputs: plan.inputs };
    } };
  } };
  const result = await runEvaluation({ ...services, taskSource, runId: "streamed-admission", output: f.config.output,
    config: f.config, plan: { ...plan, tasks: [], inputs: {}, catalog: [] }, engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: f.config.execution, modelForStage: f.modelForStage,
    concurrency: 4, taskConcurrency: 8, taskLimit: ({ running, ready }) => Math.min(8, running + ready),
    retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(15_000) });
  assert.deepEqual(Object.keys(result.execution_task_statuses), ["succeeded"]);
  assert((result.execution_task_statuses.succeeded ?? 0) >= plan.tasks.length);
  assert.equal(result.outcome, "complete");
});
