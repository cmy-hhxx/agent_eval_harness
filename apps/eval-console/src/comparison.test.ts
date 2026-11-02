import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { emptyUsage, type RunState, type WorkflowShard } from "@eval/contracts";
import { fileSourceReader, runLayout, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { comparisonRepository, taskCase, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import { businessResultRepository } from "@eval/workflows/review";
import type { Candidate } from "@eval/workflows/inputs";
import { fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, inspectFor, submitFor, draftFor, taskResult } from "../../../tests/fixtures/comparison.js";
import { services } from "../../../tests/fixtures/services.js";
import { comparisonCaseShards, consoleComparisonWorkflow as workflow } from "./comparison.js";

async function stateFor(config: EvalConfig): Promise<RunState> {
  const plan = await workflow.plan(config);
  return { manifest: { format: "evaluation-run", debug: false, runId: "stream", status: "running", engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, tasks: [], inputs: {}, inputCatalog: [], states: {}, preflight: plan.summary,
    startedAt: Date.now() }, receipts: {}, recordedAttempts: 0, usage: emptyUsage() };
}
function merge(state: RunState, shard: WorkflowShard) {
  state.manifest.inputCatalog!.push(...shard.candidates);
  state.manifest.tasks.push(...shard.tasks);
  for (const t of shard.tasks) state.manifest.states[t.id] = { status: "pending", attempts: 0 };
  (state.manifest.preflight.issues as unknown[]).push(...shard.issues ?? []);
}
async function nextCase(source: ReturnType<typeof comparisonCaseShards>, state: RunState) {
  for (let n = 0; n < 100; n++) {
    const shard = await source.next();
    if (!shard) return undefined;
    merge(state, shard);
    if (shard.candidates.length) return shard;
  }
  throw new Error("Case scanner did not yield");
}

test("console comparison accepts same-tier pairs and rejects fast versus expert", async t => {
  const f = await fixtureConfig([[], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  assert.equal((await workflow.plan(f.config)).summary.sharded, true);
  f.config.comparisons = [["a_fast", "b_expert"]];
  await assert.rejects(workflow.plan(f.config), /不同模型规模/);
  f.config.comparisons = [["a_expert", "b_fast"]];
  await assert.rejects(workflow.plan(f.config), /不同模型规模/);
});

test("case streaming aligns reordered models before EOF, bounds active cases, and resumes byte cursors", async t => {
  const a = [raw("one"), raw("two"), raw("three")], b = [raw("two"), raw("one"), raw("three")];
  const f = await fixtureConfig([a, [], b, []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.execution.sessionWindow = 1;
  let rows = 0;
  const lines = fileSourceReader.lines;
  fileSourceReader.lines = async function* (...args) { for await (const row of lines(...args)) { rows++; yield row; } };
  t.after(() => { fileSourceReader.lines = lines; });
  const state = await stateFor(f.config), source = comparisonCaseShards(f.config, state);
  const first = await nextCase(source, state);
  assert(first); assert(rows < 6, "the first aligned case must not wait for the whole corpus");
  assert.equal(new Set((first.candidates as Candidate[]).map(c => c.case_id)).size, 1);
  assert.equal(first.tasks.filter(t => t.stage === "comparison").length, 1);
  assert.equal(await source.next(), undefined, "one active case fills the input window");
  for (const task of first.tasks) state.manifest.states[task.id].status = "succeeded";
  workflow.release!(state, first.inputs);
  assert.equal(Object.keys(first.inputs).length, 0, "completed bodies are released, while report indexes survive");
  const run = path.join(f.directory, "checkpoint");
  await comparisonRepository.writeRun(run, state);
  const restored = await comparisonRepository.readRun(run);
  assert.equal((restored.manifest.config as EvalConfig).inputs.batches, undefined, "resume must not restrict undiscovered dates");
  await workflow.reconcile!(run, restored, f.config);
  const resumed = comparisonCaseShards(f.config, restored), second = await nextCase(resumed, restored);
  assert(second); assert.notEqual((second.candidates[0] as Candidate).case_id, (first.candidates[0] as Candidate).case_id);
  for (const task of second.tasks) restored.manifest.states[task.id].status = "succeeded";
  workflow.release!(restored, second.inputs);
  const third = await nextCase(resumed, restored); assert(third);
  assert.equal((third.candidates[0] as Candidate).case_id, "three");
  assert.equal(rows, 6, "resume never rereads consumed rows");
});

test("invalid and missing models are diagnosed; late duplicates do not create another comparison", async t => {
  const f = await fixtureConfig([[raw("valid"), raw("invalid"), raw("missing"), raw("valid")], [],
    [raw("valid"), { ...raw("invalid"), messages: [] }], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.execution.sessionWindow = 1;
  const state = await stateFor(f.config), source = comparisonCaseShards(f.config, state);
  for (let n = 0; n < 30 && !source.done?.(); n++) {
    const shard = await source.next(); if (!shard) continue;
    merge(state, shard);
    for (const task of shard.tasks) state.manifest.states[task.id].status = "succeeded";
    workflow.release!(state, shard.inputs);
  }
  assert(source.done?.());
  assert.equal(state.manifest.tasks.filter(t => t.stage === "comparison").length, 1);
  const issues = state.manifest.preflight.issues as { reason: string; line: number }[];
  assert(issues.some(i => i.line === 2 && i.reason.length > 0), JSON.stringify(issues));
  assert(issues.some(i => i.line === 4 && i.reason.includes("duplicate_input")));
  assert.equal((state.manifest.preflight.skipped as unknown[]).length, 2);
});

test("Host starts the first case early, drains on pause, and resumes the remaining cases", { timeout: 30000 }, async t => {
  const values = [raw("one"), raw("two")];
  const f = await fixtureConfig([values, [], values, []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.execution.sessionWindow = 1;
  const pause = new AbortController();
  let reads = 0, firstReads = 0, calls = 0;
  const lines = fileSourceReader.lines;
  fileSourceReader.lines = async function* (...args) { for await (const row of lines(...args)) { reads++; yield row; } };
  t.after(() => { fileSourceReader.lines = lines; });
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (!calls++) { firstReads = reads; pause.abort(); }
    return { async run() { await inspectFor(options); await submitFor(options, draftFor(options.spec, taskResult(options.spec))); },
      async abort() {}, async dispose() {} };
  } }, path.join(f.directory, "worker"));
  t.after(() => worker.close());
  const options = { ...services, report: undefined, taskSource: workflow, runId: "case-stream", output: f.config.output,
    config: f.config, plan: await workflow.plan(f.config), engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: f.config.execution, modelForStage: f.modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(25000) };
  assert.equal((await runEvaluation({ ...options, pauseSignal: pause.signal })).status, "interrupted");
  assert.equal(firstReads, 2, "first dispatch reads only the first row of each model");
  const result = await runEvaluation(options);
  assert.equal(result.outcome, "complete", JSON.stringify(result));
  const state = await comparisonRepository.readRun(runLayout(f.config.output, options.runId).directory);
  assert.deepEqual(state.manifest.tasks.filter(t => t.stage === "comparison").map(t => taskCase(t.data as TaskData).case_id).sort(), ["one", "two"]);
  assert.equal(reads, 4, "pause/resume must not rescan the corpus");
});

test("case shards skip existing final output without a Worker or source receipt gate", async t => {
  const value = { ...raw("done"), batch_id: "2026-11-02" };
  const f = await fixtureConfig([[value], [], [value], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.output.layout = "business";
  await writeJsonl(path.join(f.config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-11-02.jsonl"), [{ case: { case_id: "done" } }]);
  const repository = businessResultRepository(comparisonRepository);
  const result = await runEvaluation({ ...services, report: undefined, taskSource: workflow, repository,
    runtime: { ...services.runtime, workerEntry: "must-not-start" }, runId: "existing-case", output: f.config.output,
    config: f.config, plan: await workflow.plan(f.config), engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: f.config.execution, modelForStage: f.modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, signal: AbortSignal.timeout(10000) });
  assert.equal(result.outcome, "complete"); assert.equal(result.skipped_cases, 1);
  assert.equal((await repository.readRun(runLayout(f.config.output, "existing-case").directory)).recordedAttempts, 0);
});

test("pause waits for an in-flight input read before saving its final checkpoint", async t => {
  const f = await fixtureConfig(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const pause = new AbortController(); let sent = false;
  const taskSource = { ...workflow, shards: (_config: unknown, state: RunState) => ({
    done: () => sent,
    async next() {
      if (sent) return undefined;
      sent = true; pause.abort();
      await new Promise(resolve => setTimeout(resolve, 200));
      state.manifest.preflight.saved_input_position = 123;
      return { source: "fixture", revision: "", candidates: [], tasks: [], inputs: {} };
    },
  }) };
  const result = await runEvaluation({ ...services, report: undefined, taskSource, runId: "pause-input", output: f.config.output,
    config: f.config, plan: await workflow.plan(f.config), engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: f.config.execution, modelForStage: f.modelForStage,
    runtime: { ...services.runtime, workerEntry: "must-not-start" }, concurrency: 1, retries: 0, retryDelaySeconds: 0,
    pauseSignal: pause.signal, signal: AbortSignal.timeout(5000) });
  assert.equal(result.status, "interrupted");
  const saved = await comparisonRepository.readRun(runLayout(f.config.output, "pause-input").directory);
  assert.equal(saved.manifest.preflight.saved_input_position, 123);
});
