import test from "node:test";
import { waitForTestState } from "../fixtures/wait.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRegistry, runEvaluation, createChannelRequests, WorkerSupervisor, RunStore, runBatch } from "@eval/host";
import { createRunRepository, appendProgressJournal, RunHotStore, runHotFile, runJournalIdentity, type RunCodec } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { body, json, listen, request } from "@eval/runtime/http";
import {
  DEFAULT_POLICY,
  emptyUsage,
  type AgentBackend,
  type AgentDefinition,
  type AgentProfile,
  type RunState,
  type PlannedTask,
  type WorkflowDefinition,
} from "@eval/contracts";

const identity = {
  engine: "pi" as const,
  version: "test",
  commit: "test",
  buildId: "test",
};
const model = {
  provider: "test",
  baseUrl: "http://127.0.0.1:1",
  api: "openai-completions" as const,
  apiKeyEnv: "TEST_KEY",
  model: "test",
  thinking: "off" as const,
  contextWindow: 10000,
  maxOutputTokens: 1000,
};
const profile: AgentProfile = {
  id: "default",
  systemPrompt: "Evaluate JSON.",
  instructions: "Return the value as score.",
  submissionNudge: "Submit the score.",
  toolNames: [],
  fileSubmission: false,
  toolDescriptions: { submit_evaluation: "Submit JSON" },
  renderPrompt(input) { return this.instructions + "\n" + JSON.stringify(input); },
  requestSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "number" } },
  },
  submissionSchema: {
    type: "object",
    required: ["score"],
    additionalProperties: false,
    properties: { score: { type: "number" } },
  },
};
const agent: AgentDefinition = {
  id: "numeric",
  profiles: { default: profile },
};
const plan = {
  tasks: [1, 2].map((n) => ({
    id: `task-${n}`,
    stage: "numeric",
    inputIds: { record: `input-${n}` },
    dependencies: {},
    data: null,
  })),
  inputs: { "input-1": { value: 11 }, "input-2": { value: 22 } },
  summary: {},
};
const workflow: WorkflowDefinition = {
  id: "numbers",
  plan: async () => plan,
  bind(task, inputs) {
    const id = task.inputIds.record;
    return {
      agent: "numeric",
      profile: "default",
      request: {
        input: inputs[id] as { value: number },
        sources: { record: { id, value: inputs[id] } },
      },
    };
  },
};
// The generic test codec needs no comparison-only fields or input copies.
const codec: RunCodec<RunState> = {
  encode: (state) => structuredClone(state),
  references: () => [],
  resultId: (row) => String(row.id),
  decode: (value) => value,
};
const repository = createRunRepository(codec, (task, state) => ({
  id: task.id,
  file: "scores.jsonl",
  row: { id: task.id, result: state.receipts[task.id].evaluation },
}));

test("one failed review does not block aggregation and its incomplete coverage survives downstream and resume", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-settled-dependency-"));
  const tasks: PlannedTask[] = [...plan.tasks,
    { ...plan.tasks[0], id: "aggregate", dependencies: { failed: "task-1", accepted: "task-2" }, settledDependencies: ["failed"] },
    { ...plan.tasks[0], id: "follow", dependencies: { aggregate: "aggregate" } },
    { ...plan.tasks[0], id: "strict", dependencies: { failed: "task-1" } }];
  const selectedPlan = { ...plan, tasks };
  const seen: string[] = [];
  const selectedWorkflow: WorkflowDefinition = { ...workflow, plan: async () => selectedPlan,
    bind(task, inputs, dependencies, context) {
      if (task.id === "aggregate") {
        assert.equal(dependencies.failed, undefined, "a failed review has no fabricated empty evaluation");
        assert.deepEqual(dependencies.accepted!.evaluation, { score: 22 });
      }
      if (task.id === "follow") assert.deepEqual(dependencies.aggregate!.incompleteDependencies, ["task-1"]);
      return workflow.bind(task, inputs, dependencies, context);
    } };
  const worker = await startWorker({ identity, async createSession(options) {
    return { async run() {
      seen.push(options.spec.taskId);
      if (options.spec.taskId === "task-1") throw new Error("review failed");
      const value = options.spec.taskId === "task-2" ? 22 : 11;
      assert(!(await options.execute("submit_evaluation", { score: value })).isError);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  t.after(async () => { await worker.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { agents: new AgentRegistry([agent]), taskSource: selectedWorkflow, repository,
    runtime: { root: directory, workerEntry: "unused" }, runId: "partial", output: { kind: "directory" as const, path: directory },
    engine: "pi" as const, identity, evaluatorVersion: "test", config: {}, plan: selectedPlan,
    policy: { ...DEFAULT_POLICY, repairAttempts: 0, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
    modelForStage: () => model, concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], skipFailed: true };
  await runEvaluation(options);
  const saved = await repository.readRun(path.join(directory, "partial"));
  assert.equal(saved.manifest.states["task-1"].status, "failed");
  assert.equal(saved.manifest.states.strict.status, "blocked");
  assert.equal(saved.manifest.states.follow.status, "succeeded");
  assert.deepEqual(saved.receipts.follow.incompleteDependencies, ["task-1"]);
  const accepted = saved.receipts.follow.submissionId, before = [...seen];
  await runEvaluation(options);
  const resumed = await repository.readRun(path.join(directory, "partial"));
  assert.equal(resumed.receipts.follow.submissionId, accepted);
  assert.deepEqual(resumed.receipts.follow.incompleteDependencies, ["task-1"]);
  assert.deepEqual(seen, before, "resume neither repeats accepted work nor silently clears failed coverage");
});

for (const scenario of ["projection", "conflict", "missing-hot-store"])
test(`resume reconciles projected receipt metadata while rejecting changed verdicts (${scenario})`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-projected-recovery-"));
  const oldHotRoot = process.env.EVAL_HOT_STATE_ROOT;
  process.env.EVAL_HOT_STATE_ROOT = path.join(directory, "hot");
  const worker = await startWorker({ identity, async createSession() { throw new Error("Accepted work must not call the model again"); } }, path.join(directory, "worker"));
  t.after(async () => {
    await worker.close();
    if (oldHotRoot === undefined) delete process.env.EVAL_HOT_STATE_ROOT;
    else process.env.EVAL_HOT_STATE_ROOT = oldHotRoot;
    await rm(directory, { recursive: true, force: true });
  });
  const run = path.join(directory, "resume"), selected = { ...plan, tasks: plan.tasks.slice(0, 1) };
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "resume", status: "running",
    engine: identity, evaluatorVersion: "old", config: { timeoutSeconds: 900 }, tasks: selected.tasks, inputs: {},
    states: { "task-1": { status: "running", attempts: 1 } }, preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  await repository.writeRun(run, state);
  const hot = new RunHotStore(runHotFile(process.env.EVAL_HOT_STATE_ROOT!, run), runJournalIdentity(state));
  hot.append({ at: 2, manifest: { config: state.manifest.config, evaluatorVersion: "old" },
    states: { "task-1": { status: "succeeded", attempts: 1 } }, receipts: { "task-1": {
      taskId: "task-1", attemptId: "attempt", submissionId: "submission", status: "succeeded", acceptedAt: 2,
      evaluatorVersion: "old", judge: "fixture", evaluation: { score: 11 }, usage: emptyUsage(),
      audit: { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] },
    } } });
  const projected = hot.eventsAfter();
  hot.close();
  projected[0]!.event.receipts!["task-1"]!.exported = { file: "scores.jsonl", id: "task-1", row: { id: "task-1", result: { score: 11 } } };
  if (scenario === "conflict") projected[0]!.event.receipts!["task-1"]!.evaluation = { score: 99 };
  await appendProgressJournal(run, projected);
  if (scenario === "missing-hot-store") await rm(process.env.EVAL_HOT_STATE_ROOT!, { recursive: true, force: true });
  const execute = () => runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
    runtime: { root: directory, workerEntry: "unused" }, runId: "resume", output: { kind: "directory", path: directory },
    engine: "pi", identity, evaluatorVersion: "current", config: { timeoutSeconds: 3600 }, plan: selected,
    policy: DEFAULT_POLICY, modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] });
  if (scenario === "conflict") { await assert.rejects(execute, /同一序号上不一致/); return; }
  assert.deepEqual((await execute()).execution_task_statuses, { succeeded: 1 });
  const restored = await repository.readRun(run);
  assert.equal(restored.receipts["task-1"]!.exported!.file, "scores.jsonl");
  assert.equal(restored.receipts["task-1"]!.evaluatorVersion, "old");
  assert.equal(restored.manifest.evaluatorVersion, "current");
  assert.deepEqual(restored.manifest.config, { timeoutSeconds: 3600 });
});

for (const persistent of [false, true]) test(`the stage circuit waits for bounded transport retries (${persistent ? "outage" : "recovery"})`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-transport-circuit-"));
  const calls = new Map<string, number>();
  const backend: AgentBackend = { identity, async createSession(options) {
    return { async run() {
      const id = options.spec.taskId, count = (calls.get(id) ?? 0) + 1;
      calls.set(id, count);
      if (persistent || count === 1) throw new Error("Connection error.");
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
    }, async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1].map(i => startWorker(backend, path.join(directory, `worker-${i}`))));
  try {
    const result = await runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "transport-circuit", output: { kind: "directory", path: directory },
      engine: "pi", identity, evaluatorVersion: "test", config: {}, plan,
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 10 }, modelForStage: () => model,
      concurrency: 2, retries: 1, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url),
      failureGuard: { windowSize: 2, threshold: 2 }, signal: AbortSignal.timeout(12000),
    });
    const saved = await repository.readRun(path.join(directory, "transport-circuit"));
    assert.deepEqual([...calls.values()], [2, 2], "each task gets its bounded retry before the circuit can pause");
    assert.equal(Object.keys(saved!.receipts).length, persistent ? 0 : 2);
    assert.equal(result.paused_stages.length, persistent ? 1 : 0);
    assert.equal(result.status, persistent ? "interrupted" : "finished");
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a receipt committed during terminal collection wins over an earlier failed observation", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-late-receipt-"));
  let release!: () => void, submitted!: () => void;
  const readyToSubmit = new Promise<void>(resolve => { release = resolve; });
  const submissionAccepted = new Promise<void>(resolve => { submitted = resolve; });
  let attemptId = "", calls = 0, observedFailure = false;
  const worker = await startWorker({ identity, async createSession(options) {
    attemptId = options.spec.attemptId;
    return { async run() {
      calls++;
      await readyToSubmit;
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
      submitted();
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url));
    if (attemptId && request.origin === worker.url && (!init?.method || init.method === "GET")) {
      if (!observedFailure && request.pathname === `/api/attempts/${attemptId}`) {
        observedFailure = true;
        return Response.json({ state: "failed", lastSeq: 0, error: "Stale terminal observation", failure: {
          attemptId, errors: [{ category: "structure", code: "schema_required", path: "/", message: "Stale failure" }],
          contentSubmissions: 0, fileErrors: 0, repeatedErrors: 1, stopped: false, evidenceBank: [], draft: { score: 0 },
        } });
      }
      if (observedFailure && request.pathname === `/api/attempts/${attemptId}/record`) {
        release();
        await submissionAccepted;
      }
    }
    return fetch(url, init);
  });
  try {
    const result = await runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "late-receipt", output: { kind: "directory", path: directory },
      engine: "pi", identity, evaluatorVersion: "test", config: {}, plan: { ...plan, tasks: plan.tasks.slice(0, 1) },
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 5 }, modelForStage: () => model,
      concurrency: 1, retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url],
      failureGuard: { windowSize: 2, threshold: 2 }, signal: AbortSignal.timeout(2000),
    });
    const saved = await repository.readRun(path.join(directory, "late-receipt"));
    assert(observedFailure, "the failed observation must precede the committed receipt");
    assert(saved!.receipts["task-1"], "the late submission is durable");
    assert.equal(result.status, "finished");
    assert.deepEqual(result.paused_stages, [], "accepted work cannot trip the failure guard");
    assert.equal(saved!.manifest.states["task-1"].status, "succeeded");
    assert.equal(saved!.manifest.states["task-1"].attempts, 1);
    assert.equal(calls, 1, "accepted work never calls the model again");
  } finally { release(); await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a delayed permit-release acknowledgement preserves a completed model turn and its submission", { timeout: 25000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-permit-release-"));
  let originalHost = "", active = 0, releases = 0;
  const proxy = await listen(async (req, res, url) => {
    if (req.method === "DELETE" && url.pathname.startsWith("/api/model-requests/")) {
      releases++;
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
    const value = await request(originalHost + url.pathname + url.search, req.method!,
      req.method === "POST" ? await body(req) : undefined);
    return json(res, value);
  });
  const worker = await startWorker({ identity, async createSession(options) {
    originalHost = options.spec.hostUrl;
    options.spec.hostUrl = proxy.url;
    return { async run() {
      const release = await options.modelRequest!();
      await release.release();
      assert.equal(active, 0);
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation({
      agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "release",
      output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan: { ...plan, tasks: plan.tasks.slice(0, 1) },
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 20, idleTimeoutSeconds: 15 },
      modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      workerUrls: [worker.url], modelRequests: { concurrency: () => 1,
        acquire: async context => { active++; return { model: context.model, release: () => { active--; } }; } },
    });
    assert.deepEqual(result.execution_task_statuses, { succeeded: 1 });
    assert.equal(releases, 1); assert.equal(active, 0);
  } finally { await worker.close(); await proxy.close(); await rm(directory, { recursive: true, force: true }); }
});

test("sessions warm up without model permits and queued permits do not consume worker or Host timeouts", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-model-permits-"));
  let limit = 0, sessions = 0, active = 0, grants = 0;
  const worker = await startWorker({ identity, async createSession(options) {
    sessions++;
    return { async run() {
      assert(options.modelRequest);
      const release = await options.modelRequest();
      assert.equal(active, 1);
      await release.release();
      assert.equal(active, 0, "local tools run after the LLM slot is released");
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const pending = runEvaluation({
      agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "controlled",
      output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan,
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 2, idleTimeoutSeconds: 1 },
      modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      workerUrls: [worker.url],
      modelRequests: { concurrency: () => limit, acquire: async (context, signal) => {
        while (!limit && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 25));
        signal.throwIfAborted();
        await new Promise(resolve => setTimeout(resolve, 2200));
        grants++; active++;
        return { model: context.model, release: () => { active--; } };
      } },
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(sessions, 1, "the local session can warm up while waiting for a model permit");
    assert.equal(grants, 0, "zero allocation must not start a paid model call");
    assert.equal(active, 0);
    limit = 1;
    const result = await pending;
    assert.deepEqual(result.execution_task_statuses, { succeeded: 2 },
      JSON.stringify((await repository.readRun(path.join(directory, "controlled"))).manifest.states));
    assert.equal(grants, 2);
    assert.equal(active, 0);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("attempt admission is cumulative, durable and bounded across concurrent workers and resume", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-attempt-limit-"));
  let calls = 0;
  const backend: AgentBackend = { identity, async createSession(options) {
    return { async run() {
      calls++;
      const result = await options.execute("submit_evaluation", { score: 1 });
      assert(!result.isError);
    }, async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1].map(index => startWorker(backend, path.join(directory, `worker-${index}`))));
  const options = {
    agents: new AgentRegistry([agent]), taskSource: workflow, repository,
    runtime: { root: directory, workerEntry: "unused" }, runId: "bounded",
    output: { kind: "directory" as const, path: directory }, engine: "pi" as const, identity,
    evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
    modelForStage: () => model, concurrency: 2, retries: 0, retryDelaySeconds: 0,
    workerUrls: workers.map(worker => worker.url),
  };
  try {
    const first = await runEvaluation({ ...options, maxAttempts: 1 });
    assert.equal(calls, 1);
    assert.equal(first.execution_stop_reason, "attempt_limit");
    assert.deepEqual(first.execution_task_statuses, { succeeded: 1, pending: 1 });
    const resumed = await runEvaluation(options);
    assert.equal(calls, 1);
    assert.equal(resumed.execution_stop_reason, "attempt_limit");
    const state = await repository.readRun(path.join(directory, "bounded"));
    assert.equal(state.manifest.executionLimits?.maxAttempts, 1);
    assert.equal(Object.values(state.manifest.states).reduce((sum, item) => sum + item.attempts, 0), 1);
    const finished = await runEvaluation({ ...options, maxAttempts: 2 });
    assert.equal(calls, 2);
    assert.deepEqual(finished.execution_task_statuses, { succeeded: 2 });
    assert.equal(finished.execution_stop_reason, undefined);
    const afterRetirement = await runEvaluation({ ...options, taskSource: { ...workflow,
      async reconcile(_run, state) {
        state.manifest.tasks = state.manifest.tasks.filter(task => task.id !== "task-1");
        delete state.manifest.states["task-1"];
        delete state.receipts["task-1"];
        state.manifest.tasks.push({ ...plan.tasks[0], id: "task-3" });
        state.manifest.states["task-3"] = { status: "pending", attempts: 0 };
        return { tasks: state.manifest.tasks, inputs: plan.inputs, summary: {} };
      },
    } });
    assert.equal(calls, 2, "retiring a paid task cannot refund the cumulative budget");
    assert.equal(afterRetirement.execution_stop_reason, "attempt_limit");
    assert.equal((await repository.readRun(path.join(directory, "bounded"))).manifest.cumulativeAttempts, 2);
  } finally {
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("an expired dispatch deadline preserves pending work without calling a model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-dispatch-deadline-"));
  const worker = await startWorker({ identity, async createSession() {
    throw new Error("No session may be started after the deadline");
  } }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation({
      agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "expired",
      output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
      modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      workerUrls: [worker.url], stopStartingAt: Date.now() - 1,
    });
    assert.equal(result.execution_stop_reason, "dispatch_deadline");
    assert.deepEqual(result.execution_task_statuses, { pending: 2 });
    const state = await repository.readRun(path.join(directory, "expired"));
    assert.equal(Object.values(state.manifest.states).reduce((sum, item) => sum + item.attempts, 0), 0);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dispatch deadline lets the admitted attempt finish and preserves its successor", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-inflight-deadline-"));
  const deadline = Date.now() + 2000;
  let calls = 0;
  const worker = await startWorker({ identity, async createSession(options) {
    return { async run() {
      calls++;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now() + 20)));
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation({
      agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "inflight",
      output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
      modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      workerUrls: [worker.url], stopStartingAt: deadline,
    });
    assert.equal(calls, 1);
    assert.equal(result.execution_stop_reason, "dispatch_deadline");
    assert.deepEqual(result.execution_task_statuses, { succeeded: 1, pending: 1 });
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Host accepts generic JSON and profiles replace prompt and schema together", async () => {
  const registry = new AgentRegistry([
    agent,
    {
      id: "text",
      profiles: {
        default: {
          ...profile,
          instructions: "Write a summary.",
          submissionSchema: {
            type: "object",
            required: ["summary"],
            additionalProperties: false,
            properties: { summary: { type: "string" } },
          },
        },
      },
    },
  ]);
  const binding = workflow.bind(plan.tasks[0], plan.inputs, {}, { tasks: plan.tasks }),
    audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
  assert(registry.prepare(binding).prompt.startsWith("Return the value as score."));
  assert.throws(() => registry.resolve(binding, { summary: "wrong profile" }, audit), /score/);
  const alternate = { ...binding, agent: "text" };
  assert(registry.prepare(alternate).prompt.startsWith("Write a summary."));
  assert.deepEqual(registry.resolve(alternate, { summary: "eleven" }, audit), {
    summary: "eleven",
  });
  assert.throws(
    () =>
      registry.prepare({
        ...binding,
        request: { ...binding.request, input: { unrelated: true } },
      }),
    /value/,
  );
});

for (const scenario of ["resume", "missing-tool", "invalid-input"]) {
  test(`dependent tasks bind committed results before validation: ${scenario}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eval-dependent-"));
    const dependentPlan = {
      ...plan,
      tasks: [plan.tasks[0], { ...plan.tasks[1], dependencies: { previous: plan.tasks[0].id } }],
    };
    const dependentWorkflow: WorkflowDefinition = {
      ...workflow,
      plan: async () => dependentPlan,
      bind(task, inputs, dependencies, context) {
        assert.deepEqual(context.tasks.map((item) => item.id), dependentPlan.tasks.map((item) => item.id));
        const binding = workflow.bind(task, inputs, dependencies, context);
        if (task.dependencies.previous) {
          const receipt = dependencies.previous;
          assert.equal(receipt?.taskId, task.dependencies.previous);
          binding.profile = "dependent";
          binding.request.input = {
            value:
              scenario === "invalid-input" ? "invalid" : (receipt!.evaluation as { score: number }).score + 1,
          };
        }
        return binding;
      },
    };
    const entered: string[] = [];
    let skipDependentSubmission = scenario === "resume";
    const worker = await startWorker(
      {
        identity,
        async createSession(options) {
          return {
            async run() {
              entered.push(options.spec.taskId);
              if (options.spec.taskId === plan.tasks[1].id && skipDependentSubmission) return;
              const prompt = options.spec.prompt;
              const input = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
              const result = await options.execute("submit_evaluation", { score: input.value });
              assert(!result.isError);
            },
            async abort() {},
            async dispose() {},
          };
        },
      },
      path.join(directory, "worker"),
    );
    const options = {
      runId: "dependent",
      config: {},
      engine: "pi" as const,
      evaluatorVersion: "fixture",
      identity,
      output: { kind: "directory" as const, path: directory },
      plan: dependentPlan,
      taskSource: dependentWorkflow,
      repository,
      agents: new AgentRegistry([
        {
          ...agent,
          profiles: {
            ...agent.profiles,
            dependent: {
              ...profile,
              id: "dependent",
              toolNames: scenario === "missing-tool" ? ["unavailable_tool"] : [],
              toolDescriptions: scenario === "missing-tool"
                ? { ...profile.toolDescriptions, unavailable_tool: "Unavailable test tool" }
                : profile.toolDescriptions,
            },
          },
        },
      ]),
      runtime: { root: directory, workerEntry: "unused-with-external-workers" },
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
      modelForStage: () => model,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    try {
      if (scenario !== "resume") {
        await runEvaluation(options);
        const saved = await repository.readRun(path.join(directory, options.runId));
        assert.equal(saved.manifest.status, "finished");
        const failed = saved.manifest.states[plan.tasks[1].id];
        assert.equal(failed.status, "failed");
        assert.equal(failed.attempts, 0);
        assert.match(failed.reason!, scenario === "missing-tool" ? /Required tools not available/ : /value/);
        assert.deepEqual(saved.receipts[plan.tasks[0].id].evaluation, { score: 11 });
        assert.equal(saved.receipts[plan.tasks[1].id], undefined);
        assert.deepEqual(entered, [plan.tasks[0].id]);
        return;
      }
      await runEvaluation(options);
      const interrupted = await repository.readRun(path.join(directory, options.runId));
      assert.deepEqual(interrupted.receipts[plan.tasks[0].id].evaluation, { score: 11 });
      assert.equal(interrupted.manifest.states[plan.tasks[1].id].status, "failed");

      skipDependentSubmission = false;
      const beforeRetry = [...entered];
      await runEvaluation(options);
      assert.deepEqual(entered, beforeRetry, "resume does not refund an exhausted interruption retry budget");
      options.retries = interrupted.manifest.states[plan.tasks[1].id].transportFailures!;
      await runEvaluation(options);
      const completed = await repository.readRun(path.join(directory, options.runId));
      assert(completed.receipts[plan.tasks[1].id]);
      assert.deepEqual(completed.receipts[plan.tasks[1].id].evaluation, { score: 12 });
      assert.equal(
        completed.receipts[plan.tasks[0].id].submissionId,
        interrupted.receipts[plan.tasks[0].id].submissionId,
      );
      assert.deepEqual(entered, [...beforeRetry, plan.tasks[1].id], "one explicitly added retry completes only the unfinished task");
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("parallel runs isolate sessions, workspaces, results and cancellation; completed generic JSON resumes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-generic-"));
  const workspaces = new Set<string>(),
    sessions = new Set<string>(),
    aborted: string[] = [];
  let entered = 0,
    release!: () => void,
    allStarted!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const backend: AgentBackend = {
    identity,
    async createSession(options) {
      assert(!workspaces.has(options.workdir));
      workspaces.add(options.workdir);
      assert(!sessions.has(options.spec.attemptId));
      sessions.add(options.spec.attemptId);
      let stop!: () => void,
        cancelled = false;
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      return {
        async run() {
          entered++;
          if (entered === 4) allStarted();
          await Promise.race([barrier, stopped]);
          if (cancelled) return;
          const raw = JSON.parse(await readFile(path.join(options.workdir, "inputs/record.json"), "utf8"));
          const receipt = await options.execute("submit_evaluation", {
            score: raw.value,
          });
          assert(!receipt.isError);
        },
        async abort() {
          cancelled = true;
          aborted.push(options.spec.runId);
          stop();
        },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all(
    [0, 1, 2, 3].map((n) => startWorker(backend, path.join(directory, `worker-${n}`))),
  );
  const controller = new AbortController();
  const options = {
    config: {},
    engine: "pi" as const,
    evaluatorVersion: "fixture",
    identity,
    output: { kind: "directory" as const, path: directory },
    plan,
    taskSource: workflow,
    repository,
    agents: new AgentRegistry([agent]),
    runtime: { root: directory, workerEntry: "unused-with-external-workers" },
    policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
    modelForStage: () => model,
    concurrency: 2,
    retries: 0,
    retryDelaySeconds: 0,
  };
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    first = runEvaluation({
      ...options,
      runId: "cancelled",
      signal: controller.signal,
      workerUrls: workers.slice(0, 2).map((w) => w.url),
    });
    second = runEvaluation({
      ...options,
      runId: "complete",
      workerUrls: workers.slice(2).map((w) => w.url),
    });
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("parallel sessions did not start")), 5000).unref(),
      ),
    ]);
    await assert.rejects(runEvaluation({ ...options, runId: "complete" }), /owned/);
    controller.abort();
    await first;
    assert.equal(entered, 4);
    assert.deepEqual(new Set(aborted), new Set(["cancelled"]));
    release();
    await second;
    const completed = await repository.readRun(path.join(directory, "complete"));
    assert.equal(Object.keys(completed.receipts).length, 2);
    assert.equal(
      Object.keys((await repository.readRun(path.join(directory, "cancelled"))).receipts).length,
      0,
    );
    const bytes = await readFile(path.join(directory, "complete/results/scores.jsonl"), "utf8");
    assert.deepEqual(
      bytes
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).result.score)
        .sort(),
      [11, 22],
    );
    await runEvaluation({
      ...options,
      runId: "complete",
      plan: {
        ...plan,
        inputs: { "input-1": { value: 99 }, "input-2": { value: 88 } },
      },
      modelForStage: () => ({ ...model, model: "changed" }),
      policy: { ...options.policy, maxToolCalls: 1 },
      workerUrls: [],
    });
    assert.equal(entered, 4);
    assert.deepEqual(
      (await readFile(path.join(directory, "complete/results/scores.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .sort(),
      bytes.trim().split("\n").sort(),
    );
  } finally {
    controller.abort();
    release();
    await Promise.allSettled([first, second]);
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});


test("terminal accounting is reread without repeating model work", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-final-accounting-"));
  let runs = 0, records = 0;
  const worker = await startWorker({identity, async createSession(options) {
    return {async run() {runs++; assert(!(await options.execute("submit_evaluation", {score:1})).isError);}, async abort() {}, async dispose() {}};
  }}, path.join(directory,"worker"));
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis,"fetch",async (url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1]) => {
    const response = await originalFetch(url,init), address = new URL(String(url));
    if(address.origin === worker.url && address.pathname.endsWith("/record") && (!init?.method || init.method === "GET")) {
      const record = await response.json() as {metrics?:{usage:{totalTokens:number}}};
      records++;
      if(records === 1) delete record.metrics;
      else {assert(record.metrics); record.metrics.usage.totalTokens=123;}
      return Response.json(record);
    }
    return response;
  });
  try {
    await runEvaluation({agents:new AgentRegistry([agent]),taskSource:workflow,repository,
      runtime:{root:directory,workerEntry:"unused"},runId:"accounting",output:{kind:"directory",path:directory},
      engine:"pi",identity,evaluatorVersion:"test",config:{},plan:{...plan,tasks:plan.tasks.slice(0,1)},
      policy:{...DEFAULT_POLICY,timeoutSeconds:5},modelForStage:()=>model,concurrency:1,retries:0,retryDelaySeconds:0,
      workerUrls:[worker.url],signal:AbortSignal.timeout(5000)});
    const saved=await repository.readRun(path.join(directory,"accounting"));
    assert.equal(records,2); assert.equal(runs,1); assert.equal(saved!.usage.totalTokens,123);
    assert.equal(saved!.manifest.states["task-1"].status,"succeeded");
  } finally {await worker.close();await rm(directory,{recursive:true,force:true});}
});


test("a gateway disabled while a Worker waits for admission preserves the record as pending", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-permit-denied-"));
  const control = createChannelRequests({ [model.provider]: 1 });
  const held = await control.acquire({ runId: "holder", taskId: "holder", callId: "holder", stage: "fixture", model }, new AbortController().signal);
  const worker = await startWorker({ identity, async createSession(options) { return {
    async run() { await options.modelRequest!(); throw new Error("a disabled gateway must never start a model call"); },
    async abort() {}, async dispose() {},
  }; } }, path.join(directory, "worker"));
  try {
    const pending = runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "denied", output: { kind: "directory", path: directory },
      engine: "pi", identity, evaluatorVersion: "test", config: {}, plan,
      policy: DEFAULT_POLICY, modelForStage: () => model, modelRequests: control,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) });
    await waitForTestState(async () => control.snapshot().queued, count => count === 1, "Worker reaches the real Host admission queue");
    control.disable(model.provider, "account unavailable");
    const result = await pending;
    assert.deepEqual(result.execution_task_statuses, { pending: 2 });
    assert.equal(result.resource_pause, "model_channels_unavailable");
  } finally { held.release(); await worker.close(); await rm(directory, { recursive: true, force: true }); }
});


test("an unexpected admission controller failure interrupts the run without judging its queued record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-admission-fault-"));
  const worker = await startWorker({ identity, async createSession(options) { return {
    async run() { await options.modelRequest!(); }, async abort() {}, async dispose() {},
  }; } }, path.join(directory, "worker"));
  try {
    await assert.rejects(runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "admission-fault", output: { kind: "directory", path: directory },
      engine: "pi", identity, evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
      modelForStage: () => model, modelRequests: { concurrency: () => 1, async acquire() { throw new Error("admission controller fixture fault"); } },
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) }), /admission controller fixture fault/);
    const saved = await repository.readRun(path.join(directory, "admission-fault"));
    assert.equal(saved.manifest.status, "interrupted");
    assert(Object.values(saved.manifest.states).every(state => state.status === "pending"));
    assert.equal((await request<{ activeAttempt: string | null }>(worker.url + "/api/health")).activeAttempt, null,
      "a Host admission fault must not poison a successfully cleaned Worker shared with other runs");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a global admission failure releases other queued attempts before draining the run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-admission-drain-"));
  const workers = await Promise.all([1, 2].map(n => startWorker({ identity, async createSession(options) { return {
    async run() { await options.modelRequest!(); }, async abort() {}, async dispose() {},
  }; } }, path.join(directory, "worker-" + n))));
  let calls = 0, queuedAborted = false;
  const safety = AbortSignal.timeout(2000);
  try {
    await assert.rejects(runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, runId: "drain", output: { kind: "directory", path: directory },
      engine: "pi", identity, evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
      modelForStage: () => model, modelRequests: { concurrency: () => 2, async acquire(_context, signal) {
        if (++calls === 2) throw new Error("admission drain fixture fault");
        return new Promise((_, reject) => signal.addEventListener("abort", () => {
          queuedAborted = true; reject(signal.reason);
        }, { once: true }));
      } }, concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url), signal: safety }), /admission drain fixture fault/);
    assert.equal(safety.aborted, false, "global failure must not wait for the external cancellation deadline");
    assert.equal(queuedAborted, true);
    const saved = await repository.readRun(path.join(directory, "drain"));
    assert.equal(saved.manifest.status, "interrupted");
    assert(Object.values(saved.manifest.states).every(state => state.status === "pending"));
  } finally { await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true }); }
});

test("Worker shutdown failure still checkpoints an interrupted run and closes its store", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-shutdown-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const close = WorkerSupervisor.prototype.close, closeStore = RunStore.prototype.close;
  let storesClosed = 0;
  t.mock.method(WorkerSupervisor.prototype, "close", async function(this: WorkerSupervisor) {
    await close.call(this); throw new Error("shutdown fixture fault");
  });
  t.mock.method(RunStore.prototype, "close", async function(this: RunStore) { storesClosed++; await closeStore.call(this); });
  await assert.rejects(runEvaluation({ agents: new AgentRegistry([agent]),
    taskSource: { ...workflow, canStart() { throw new Error("scheduler fixture fault"); } }, repository,
    runtime: { root: directory, workerEntry: "unused" }, runId: "shutdown", output: { kind: "directory", path: directory },
    engine: "pi", identity, evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY,
      modelForStage: () => model, concurrency: 1, retries: 0, retryDelaySeconds: 0 }), error => {
    assert(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(error => error.message), ["scheduler fixture fault", "shutdown fixture fault"]);
    return true;
  });
  assert.equal(storesClosed, 1);
  assert.equal((await repository.readRun(path.join(directory, "shutdown"))).manifest.status, "interrupted");
  await assert.rejects(readFile(path.join(directory, "shutdown/.run-lock")), { code: "ENOENT" });
});

test("a Host storage error remains fatal even when the corresponding Worker is lost", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-lost-worker-storage-"));
  const worker = await startWorker({ identity, async createSession() { throw new Error("must not dispatch after storage failure"); } }, path.join(directory, "worker"));
  let lost = false;
  class Supervisor extends WorkerSupervisor {
    override setDemand() {}
    override exited() { return lost; }
  }
  const supervisor = new Supervisor({ identity, runtime: { root: directory, workerEntry: "unused" },
    directory, retries: 0, retryDelaySeconds: 0, wake() {}, event() {} });
  supervisor.slots.push({ url: worker.url, health: { identity, tools: [], activeAttempt: null } });
  t.mock.method(RunStore.prototype, "activate", async () => { lost = true; throw new Error("WAL fixture failure"); });
  const safety = AbortSignal.timeout(2000);
  try {
    await assert.rejects(runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, workerSupervisor: supervisor,
      runId: "storage", output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan, policy: DEFAULT_POLICY, modelForStage: () => model,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, signal: safety }), /WAL fixture failure/);
    assert.equal(safety.aborted, false);
    assert.equal((await repository.readRun(path.join(directory, "storage"))).manifest.status, "interrupted");
  } finally { await supervisor.close(); await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an accepted receipt still retires a Worker whose session cleanup timed out", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-receipt-retire-"));
  const worker = await startWorker({ identity, async createSession(options) { return {
    async run() { assert(!(await options.execute("submit_evaluation", { score: 1 })).isError); },
    async abort() {}, async dispose() { await new Promise(() => {}); },
  }; } }, path.join(directory, "worker"));
  let retired = 0;
  class Supervisor extends WorkerSupervisor { override setDemand() {} }
  const supervisor = new Supervisor({ identity, runtime: { root: directory, workerEntry: "unused" },
    directory, retries: 0, retryDelaySeconds: 0, wake() {}, event() {} });
  supervisor.slots.push({ url: worker.url, health: { identity, tools: [], activeAttempt: null } });
  t.mock.method(supervisor, "retire", () => { retired++; supervisor.slots.length = 0; });
  try {
    await runEvaluation({ agents: new AgentRegistry([agent]), taskSource: workflow, repository,
      runtime: { root: directory, workerEntry: "unused" }, workerSupervisor: supervisor,
      runId: "retire", output: { kind: "directory", path: directory }, engine: "pi", identity,
      evaluatorVersion: "test", config: {}, plan: { ...plan, tasks: plan.tasks.slice(0, 1) },
      policy: { ...DEFAULT_POLICY, cleanupTimeoutSeconds: 0.05 }, modelForStage: () => model,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, signal: AbortSignal.timeout(5000) });
    assert.equal(retired, 1);
    assert.equal((await repository.readRun(path.join(directory, "retire"))).manifest.states["task-1"].status, "succeeded");
  } finally { await supervisor.close(); await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const priority of [0, 1]) test(`a session window returns unused batch capacity to a ${priority === 0 ? "lower" : "same"} priority run`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-window-handoff-"));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const starts: string[] = [];
  const workers = await Promise.all([1, 2, 3, 4].map(n => startWorker({ identity, async createSession(options) { return {
    async run() {
      starts.push(options.spec.runId);
      if (starts.length === 4) release();
      await held;
      assert(!(await options.execute("submit_evaluation", { score: 1 })).isError);
    }, async abort() { release(); }, async dispose() {},
  }; } }, path.join(directory, "worker-" + n))));
  class Supervisor extends WorkerSupervisor { override setDemand() {} }
  const supervisor = new Supervisor({ identity, runtime: { root: directory, workerEntry: "unused" },
    directory, retries: 0, retryDelaySeconds: 0, wake() {}, event() {} });
  supervisor.slots.push(...workers.map(worker => ({ url: worker.url, health: { identity, tools: [], activeAttempt: null } })));
  const safety = AbortSignal.timeout(10_000);
  const tasks = Array.from({ length: 10 }, (_, n) => ({ ...plan.tasks[0], id: "task-" + n }));
  try {
    const result = await runBatch(["window", "healthy"].map(id => ({ id, priority: id === "window" ? priority : 1,
      run: async (control, taskLimit, signal) => {
        if (id === "healthy") await waitForTestState(async () => starts.includes("window"), value => value, "the window run starts", 5000);
        return runEvaluation({ agents: new AgentRegistry([agent]), repository,
        taskSource: id === "window" ? { ...workflow, scheduling: { sessionAdmission: {
          id: task => task.id, window: 1, completed: () => true,
        } } } : workflow,
        runtime: { root: directory, workerEntry: "unused" }, workerSupervisor: supervisor,
        runId: id, output: { kind: "directory", path: directory }, engine: "pi", identity,
        evaluatorVersion: "test", config: {}, plan: { ...plan, tasks }, policy: DEFAULT_POLICY,
        modelForStage: () => model, modelRequests: control, taskLimit, taskConcurrency: 4,
        concurrency: 4, retries: 0, retryDelaySeconds: 0, signal });
      },
    })), { [model.provider]: 4 }, 4, safety, () => {});
    assert.equal(safety.aborted, false);
    assert.equal(result.window.status, "finished", JSON.stringify(result));
    assert.equal(result.healthy.status, "finished", JSON.stringify(result));
    assert.equal(starts.slice(0, 4).filter(id => id === "window").length, 1);
    assert.equal(starts.slice(0, 4).filter(id => id === "healthy").length, 3);
  } finally {
    release(); await supervisor.close(); await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
