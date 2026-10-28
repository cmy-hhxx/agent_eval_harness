import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY, emptyUsage, type AgentBinding, type AgentProfile, type AttemptSpec,
  type RunRepository, type RunState, type Submission,
} from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
import { RunStore } from "./store.js";
import { RunHotStore, runJournalIdentity } from "@eval/data";

test("two hundred independent commits do not wait for checkpoint projection", async t => {
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
    manifest: { format: "evaluation-run", debug: false, runId: "concurrent", status: "running",
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
  const store = new RunStore("/unused-concurrency", state, { [sourceId]: input }, {
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
  assert.ok(receipts.every(row => row.event.manifest?.inputCatalog === undefined && row.event.taskOrder === undefined),
    "ordinary commits retain the existing catalog and task order without copying them into every receipt event");
  acceptanceLatencies.sort((a, b) => a - b);
  const p95 = acceptanceLatencies[Math.ceil(acceptanceLatencies.length * 0.95) - 1]!;
  t.diagnostic(`200 accepts: p50=${acceptanceLatencies[99]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${acceptanceLatencies.at(-1)!.toFixed(1)}ms`);
  assert(p95 < 1000, `acceptance p95 must stay below one second, received ${p95.toFixed(1)}ms`);
});
