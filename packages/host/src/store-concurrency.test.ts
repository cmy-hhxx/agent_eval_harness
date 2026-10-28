import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_POLICY, emptyUsage, type AgentBinding, type AgentProfile, type AttemptSpec,
  type RunRepository, type RunState, type Submission,
} from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
import { RunStore } from "./store.js";
import { appendProgressJournal, createRunRepository, readProgressJournal, runProgressFile, RunHotStore, runJournalIdentity } from "@eval/data";

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
      config: {}, tasks, inputs: { [sourceId]: { id: sourceId, name: "answer" } },
      states: Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0, revision: 1 }])),
      preflight: {}, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
  };
  let checkpoints = 0;
  const repository: RunRepository = {
    async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() { checkpoints++; }, createResultWriter() { return async () => {}; },
  };
  const store = new RunStore(run, state, { [sourceId]: input }, {
    agents, repository, taskSource: { id: "fixture", bind: () => binding },
  }, undefined, new RunHotStore(":memory:", runJournalIdentity(state)));
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
  acceptanceLatencies.sort((a, b) => a - b);
  const p95 = acceptanceLatencies[Math.ceil(acceptanceLatencies.length * 0.95) - 1]!;
  t.diagnostic(`200 accepts: p50=${acceptanceLatencies[99]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${acceptanceLatencies.at(-1)!.toFixed(1)}ms`);
  assert(p95 < 1000, `acceptance p95 must stay below one second, received ${p95.toFixed(1)}ms`);
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
  fail = false;
  await store.persistCheckpoint();
  assert.deepEqual(await readProgressJournal(run, sequence), []);
  await store.close();
  const restored = await repository.readRun(run);
  const fresh = new RunStore(run, restored, {}, services);
  await fresh.persistCheckpoint();
  assert.equal(restored.manifest.journalSequence, sequence);
  await fresh.close();
});
