import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY, emptyUsage, type AgentBinding, type AgentProfile, type AttemptSpec,
  type FailureContext, type PlannedTask, type RunRepository, type RunState, type Submission,
} from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
import { RunStore } from "./store.js";
import {
  applyRunJournalDelta, appendProgressJournal, createRunRepository, readProgressJournal, runProgressFile, RunHotStore, runJournalIdentity,
} from "@eval/data";

for (const debug of [false, true]) test(`two hundred independent activations and commits do not wait for diagnostics or checkpoint projection (debug: ${debug})`, async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "eval-activation-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  await writeFile(path.join(run, "_internal"), "diagnostics storage is unavailable");
  const sourceId = "11111111-1111-4111-8111-111111111111", input = { messages: [{ content: "source" }] };
  const binding: AgentBinding = { agent: "fixture", profile: "default", request: {
    input: {}, sources: { answer: { id: sourceId, value: input } },
  } };
  const profile: AgentProfile = {
    id: "default", requestSchema: { type: "object" }, submissionSchema: { type: "object" },
    systemPrompt: "Submit.", instructions: "Submit.", submissionNudge: "Submit.", fileSubmission: false,
    toolNames: [], toolDescriptions: { submit_evaluation: "Submit." }, renderPrompt: () => "Submit.", validate() {},
  };
  const agents = new AgentRegistry([{ id: "fixture", profiles: { default: profile } }]);
  const tasks = Array.from({ length: 200 }, (_, index) => ({ id: `task-${index}`, stage: "attribution",
    inputIds: { answer: sourceId }, dependencies: {}, data: { index } }));
  const state: RunState = {
    manifest: { format: "evaluation-run", debug, runId: "concurrent", status: "running",
      engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
      config: {}, tasks, inputs: { [sourceId]: { id: sourceId, name: "answer" } }, inputCatalog: [{ input_id: sourceId }],
      states: Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0, revision: 1 }])),
      preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
  };
  let checkpoints = 0;
  const repository: RunRepository = {
    async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() { checkpoints++; }, createResultWriter() { return async () => {}; },
  };
  const journal = new RunHotStore(":memory:", runJournalIdentity(state));
  const store = new RunStore(run, state, { [sourceId]: input }, {
    agents, repository, taskSource: { id: "fixture", bind: () => binding },
  }, undefined, journal);
  t.after(() => store.close());
  const prepared = agents.prepare(binding), engine = state.manifest.engine;
  const specs = tasks.map((task): AttemptSpec => ({ runId: "concurrent", taskId: task.id, attemptId: `attempt-${task.id}`,
    inputRevision: 1, engine, evaluation: prepared.evaluation, policy: { ...DEFAULT_POLICY, maxToolCalls: 0 },
    prompt: "Submit.", evidenceBank: [], inputs: [{ id: sourceId, name: "answer" }], hostUrl: "http://localhost",
    deadline: Date.now() + 60_000, model: { provider: "fixture", baseUrl: "http://localhost", api: "openai-completions",
      apiKeyEnv: "FIXTURE_KEY", model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } }));
  await Promise.all(specs.map(spec => store.activate(spec)));
  const acceptanceLatencies: number[] = [];
  await Promise.all(specs.map((spec, index): Promise<unknown> => {
    const submission: Submission = { taskId: spec.taskId, attemptId: spec.attemptId, submissionId: `submission-${index}`,
      evaluation: { index }, usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceReads: [],
        viewedImages: [], calculations: [], artifacts: [], evidenceBank: [] } };
    const started = performance.now();
    return store.accept(submission).finally(() => acceptanceLatencies.push(performance.now() - started));
  }));
  assert.equal(Object.keys(state.receipts).length, 200);
  assert.equal(Object.values(state.manifest.states).every(value => value.status === "succeeded"), true);
  assert.equal(checkpoints, 0, "acceptance never waits for or triggers full checkpoint projection");
  const receipts = journal.pending(1000).filter(row => row.event.receipts);
  assert.equal(receipts.length, 200);
  assert.ok(receipts.every(row => row.event.manifest === undefined && row.event.taskOrder === undefined),
    "ordinary commits never repeat the manifest or the frozen task order");
  acceptanceLatencies.sort((a, b) => a - b);
  const p95 = acceptanceLatencies[Math.ceil(acceptanceLatencies.length * 0.95) - 1]!;
  t.diagnostic(`200 accepts: p50=${acceptanceLatencies[99]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${acceptanceLatencies.at(-1)!.toFixed(1)}ms`);
  assert(p95 < 1000, `acceptance p95 must stay below one second, received ${p95.toFixed(1)}ms`);
});

test("accept events persist only their execution-scope extension, never the repeated manifest or task order", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "eval-receipt-scope-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  const sourceId = "22222222-2222-4222-8222-222222222222", input = { messages: [{ content: "source" }] };
  const task: PlannedTask = { id: "task", stage: "attribution", inputIds: { answer: sourceId }, dependencies: {}, data: {} };
  const next: PlannedTask = { id: "next", stage: "attribution", inputIds: { answer: sourceId }, dependencies: {}, data: {} };
  const binding: AgentBinding = { agent: "fixture", profile: "default", request: {
    input: {}, sources: { answer: { id: sourceId, value: input } },
  } };
  const profile: AgentProfile = {
    id: "default", requestSchema: { type: "object" }, submissionSchema: { type: "object" },
    systemPrompt: "Submit.", instructions: "Submit.", submissionNudge: "Submit.", fileSubmission: false,
    toolNames: [], toolDescriptions: { submit_evaluation: "Submit." }, renderPrompt: () => "Submit.", validate() {},
  };
  const agents = new AgentRegistry([{ id: "fixture", profiles: { default: profile } }]);
  const state: RunState = {
    manifest: { format: "evaluation-run", debug: false, runId: "receipt-scope", status: "running",
      engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
      config: { inputs: { records: ["immutable".repeat(20_000)] } }, tasks: [task],
      inputs: { [sourceId]: { id: sourceId, name: "answer" } }, inputCatalog: [{ input_id: sourceId }],
      states: { task: { status: "pending", attempts: 0, revision: 1 } }, executionScope: ["task"],
      preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
  };
  const checkpoint = structuredClone(state);
  const repository: RunRepository = {
    async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() {}, createResultWriter() { return async () => {}; },
  };
  const journal = new RunHotStore(":memory:", runJournalIdentity(state));
  const store = new RunStore(run, state, { [sourceId]: input }, {
    agents, repository, taskSource: { id: "fixture", bind: () => binding, advance: () => ({ tasks: [next] }) },
  }, undefined, journal);
  t.after(() => store.close());
  const prepared = agents.prepare(binding), engine = state.manifest.engine;
  const spec: AttemptSpec = { runId: "receipt-scope", taskId: task.id, attemptId: "attempt",
    inputRevision: 1, engine, evaluation: prepared.evaluation, policy: { ...DEFAULT_POLICY, maxToolCalls: 0 },
    prompt: "Submit.", evidenceBank: [], inputs: [{ id: sourceId, name: "answer" }], hostUrl: "http://localhost",
    deadline: Date.now() + 60_000, model: { provider: "fixture", baseUrl: "http://localhost", api: "openai-completions",
      apiKeyEnv: "FIXTURE_KEY", model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } };
  await store.activate(spec);
  const submission: Submission = { taskId: task.id, attemptId: spec.attemptId, submissionId: "submission",
    evaluation: { index: 0 }, usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceReads: [],
      viewedImages: [], calculations: [], artifacts: [], evidenceBank: [] } };
  await store.accept(submission);
  const events = journal.pending();
  const accept = events.find(row => row.event.receipts)!;
  assert.deepEqual(accept.event.manifest, { executionScope: ["task", "next"] },
    "a receipt owns only the scope extension it made, not the immutable config or plan indexes");
  assert.equal(accept.event.taskOrder, undefined, "appended tasks replay in their append order");
  const replayed = structuredClone(checkpoint);
  for (const row of events) applyRunJournalDelta(replayed, row.event);
  assert.deepEqual(replayed.manifest.tasks.map(item => item.id), ["task", "next"]);
  assert.deepEqual(replayed.manifest.executionScope, ["task", "next"]);
});

test("blocked scheduler subsets persist only the newly blocked states", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "eval-blocked-states-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "blocked", status: "running",
    engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
    config: {}, tasks: [], inputs: {}, states: {
      a: { status: "blocked", attempts: 0 }, b: { status: "pending", attempts: 0 }, c: { status: "blocked", attempts: 0 },
    }, preflight: {}, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const repository: RunRepository = {
    async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() {}, createResultWriter() { return async () => {}; },
  };
  const hot = new RunHotStore(":memory:", runJournalIdentity(state));
  const store = new RunStore(run, state, {}, { agents: new AgentRegistry([]),
    taskSource: { id: "fixture", bind(): never { throw new Error("unused"); } }, repository }, undefined, hot);
  t.after(() => store.close());
  await store.save(undefined, { manifest: false, stateIds: ["a", "c"] });
  const pending = hot.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.event.manifest, undefined);
  assert.deepEqual(Object.keys(pending[0]!.event.states!), ["a", "c"]);
});

test("two cold restores retain unfinished drafts and inspection proof after journal compaction", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "eval-recovery-checkpoint-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  const failure: FailureContext = {
    errors: [{ category: "decision", code: "missing", path: "/label", message: "补齐字段", expected: "label" }],
    draft: { summary: "已有草稿", evidence: [0] }, evidenceBank: ["source:0:text:/content:0:2"],
    inspection: { id: "inspection", value: { checked: true }, proof: {
      traceReads: [{ candidate: "answer", message_index: 0, path: "/content", kind: "text", start: 0, end: 2 }], viewedImages: [] } },
    review: { quotes: [], sources: [{ id: "source", content: "原文", record: {} }], actions: [], viewed: [], searches: [] },
    contentSubmissions: 1, fileErrors: 2, repeatedErrors: 0, stopped: false, attemptId: "attempt" };
  let state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "cold", status: "interrupted",
    engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
    config: {}, tasks: [{ id: "task", stage: "review", inputIds: {}, dependencies: {}, data: {} }], inputs: {},
    states: { task: { status: "cancelled", attempts: 1, failure } }, preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const repository = createRunRepository<RunState>({ encode: value => value, decode: value => value,
    references: () => [], resultId: () => "" }, () => null);
  for (let round = 0; round < 2; round++) {
    const store = new RunStore(run, state, {}, { repository, agents: new AgentRegistry([]),
      taskSource: { id: "fixture", bind(): never { throw new Error("No material should be prepared to restore state"); } } },
      undefined, new RunHotStore(":memory:", runJournalIdentity(state)));
    store.startOutbox();
    await store.save("task");
    await store.persistCheckpoint();
    await store.close(); // The local hot store is gone; only the checkpoint and compacted progress remain.
    state = await repository.readRun(run);
    assert.deepEqual(state.manifest.states.task!.failure, failure);
    assert.deepEqual(await readProgressJournal(run, state.manifest.journalSequence), []);
    assert.equal(state.manifest.states.task!.attempts, 1);
  }
});

test("only a durable checkpoint compacts progress and a fresh hot store retains the covered sequence", async t => {
  const run = await mkdtemp(path.join(os.tmpdir(), "eval-checkpoint-commit-"));
  t.after(() => rm(run, { recursive: true, force: true }));
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "checkpoint", status: "running",
    engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
    config: {}, tasks: [], inputs: {}, states: {}, preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const repository = createRunRepository<RunState>({ encode: value => value, decode: value => value,
    references: () => [], resultId: () => "" }, () => null);
  let fail = true;
  const services = { agents: new AgentRegistry([]), taskSource: { id: "fixture", bind(): never { throw new Error("unused"); } },
    repository: { ...repository, async writeRun(run: string, state: RunState) {
      if (fail) throw new Error("fixture checkpoint failure");
      await repository.writeRun(run, state);
    } } };
  const hot = new RunHotStore(":memory:", runJournalIdentity(state));
  const sequence = hot.append({ at: 1, recordedAttempts: 1 });
  hot.markDelivered([sequence]);
  await appendProgressJournal(run, hot.eventsAfter());
  const store = new RunStore(run, state, {}, services, undefined, hot);
  const original = await readFile(runProgressFile(run), "utf8");
  await assert.rejects(store.persistCheckpoint(), /fixture checkpoint failure/);
  assert.equal(await readFile(runProgressFile(run), "utf8"), original);
  assert.equal(store.admissionPaused(), false, "a transient snapshot failure does not discard healthy work");
  store.checkpointMetrics.failedSince = Date.now() - 5 * 60_000 - 1;
  assert.equal(store.admissionPaused(), true, "a stale snapshot stops admission after the agreed window");
  fail = false;
  await store.persistCheckpoint();
  assert.equal(store.admissionPaused(), false, "durable recovery automatically resumes admission");
  assert.equal(store.checkpointMetrics.lastError, undefined);
  assert.deepEqual(await readProgressJournal(run, sequence), []);
  await store.close();
  const restored = await repository.readRun(run);
  const fresh = new RunStore(run, restored, {}, services);
  await fresh.persistCheckpoint();
  assert.equal(restored.manifest.journalSequence, sequence);
  await fresh.close();
});
