import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { emptyUsage, type RunState, type WorkflowShard } from "@eval/contracts";
import { fileSourceReader, runLayout, writeJson, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { comparisonRepository, type TaskData } from "@eval/workflows/comparison";
import { attributionRepository } from "@eval/workflows/attribution";
import { businessResultRepository } from "@eval/workflows/review";
import type { Candidate } from "@eval/workflows/inputs";
import { fixtureConfig, raw, sessionRaw, fakeIdentity, fakeEvaluatorVersion, inspectFor, submitFor, draftFor, taskResult } from "../../../tests/fixtures/comparison.js";
import { services } from "../../../tests/fixtures/services.js";
import type { HostConfig } from "@eval/host-app/config";
import { checkData, emptyDataCheck } from "./data-check.js";
import { createRoundWorkflow, emptyInputSchedule, loadInputSchedule, roundAdmission } from "./rounds.js";

async function fixture(six = false, attribution = false, dated = false) {
  const f = await fixtureConfig([[], [], [], []]);
  const config = f.config;
  config.execution.sessionWindow = six ? 7 : dated ? 4 : 2;
  if (six) {
    const fast = [config.inputs.versions[0], config.inputs.versions[2]];
    config.inputs.versions = [...fast, ...["c_fast", "d_fast"].map(id => ({ ...fast[0], id, name: id })),
      config.inputs.versions[1], config.inputs.versions[3]];
  }
  if (attribution) config.inputs.versions = [config.inputs.versions[0], config.inputs.versions[1]];
  const fast = ["a_fast", "b_fast", "c_fast", "d_fast"];
  config.comparisons = six ? [...fast.flatMap((a, i) => fast.slice(i + 1).map(b => [a, b])), ["a_expert", "b_expert"]] :
    [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  for (const v of config.inputs.versions) {
    const prefix = attribution ? v.id : v.comparison_tier;
    const rows = [1, 2].flatMap(n => (dated ? ["2026-10-26", "2026-10-27"] : ["search_eval"]).map(batch_id =>
      ({ ...(attribution ? sessionRaw(prefix + "-" + n) : raw(prefix + "-" + n)), batch_id })));
    v.sources = [{ kind: "file", path: path.join(f.directory, v.id + ".jsonl") }];
    await writeJsonl(v.sources[0].path, rows);
  }
  const host = { workflow: attribution ? "attribution" : "comparison", evaluation: attribution ? { ...config, workflow: "attribution" } : config,
    models: f.models, evaluatorVersion: "fixture" } as HostConfig;
  const schedule = emptyInputSchedule();
  await checkData(host, emptyDataCheck(host.workflow), new AbortController().signal, async () => {}, "rounds", schedule);
  const workflow = createRoundWorkflow(host, schedule), plan = await workflow.plan(config);
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "rounds", status: "running", engine: fakeIdentity,
    evaluatorVersion: "fixture", config, tasks: [], inputs: {}, inputCatalog: [], states: {}, preflight: plan.summary, startedAt: Date.now() },
    receipts: {}, recordedAttempts: 0, usage: emptyUsage() };
  return { f, host, config, schedule, workflow, state };
}
function merge(state: RunState, shard: WorkflowShard) {
  const catalog = state.manifest.inputCatalog as Candidate[];
  for (const c of shard.candidates as Candidate[]) if (!catalog.some(old => old.input_id === c.input_id)) catalog.push(c);
  for (const task of shard.tasks) if (!state.manifest.states[task.id]) {
    state.manifest.tasks.push(task); state.manifest.states[task.id] = { status: "pending", attempts: 0 };
  }
}
function finish(state: RunState) { for (const value of Object.values(state.manifest.states)) value.status = "succeeded"; }

test("round planning preserves size tiers and rejects mixed fast/expert comparisons", async t => {
  const { f, workflow, config } = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.comparisons = [["a_fast", "b_expert"]];
  await assert.rejects(workflow.plan(config), /不同模型规模/);
});

test("search dispatch rotates through six fast pairs and one expert pair within the input window", async t => {
  const { f, config, workflow, state, schedule } = await fixture(true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  assert.equal(schedule.units.length, 14);
  assert.deepEqual(Object.keys(schedule.records[0]).sort(), ["batch_id", "byte_length", "byte_offset", "case_id", "input_id", "line", "source", "version"]);
  const source = workflow.shards!(config, state);
  for (let n = 0; n < 7; n++) { const shard = await source.next(); assert(shard); merge(state, shard); }
  const first = state.manifest.tasks.filter(task => task.stage === "comparison");
  assert.equal(first.length, 7);
  assert.equal(state.manifest.tasks.filter(task => task.stage === "attribution-session").length, 6,
    "the four fast answers share their original Criteria/attribution across all six pairs");
  assert.equal(new Set(first.map(task => Object.values((task.data as TaskData).candidates).map(c => c.version).sort().join("+"))).size, 7);
  assert(first.every(task => Object.values((task.data as TaskData).candidates).every(c => c.case_id.endsWith("-1"))));
  assert.equal(await source.next(), undefined, "a full input window waits for capacity");
  const future = structuredClone(first[0]); future.id = "outside-round";
  for (const candidate of Object.values((future.data as TaskData).candidates)) candidate.case_id = "Fast-2";
  state.manifest.tasks.push(future); state.manifest.states[future.id] = { status: "pending", attempts: 0 };
  assert(!roundAdmission(state.manifest, true).has(future.id), "unbound future cases cannot bypass admission on resume");
  state.manifest.tasks.pop(); delete state.manifest.states[future.id];
  finish(state);
  for (let n = 0; n < 7; n++) { const shard = await source.next(); assert(shard); merge(state, shard); }
  assert.equal(state.manifest.tasks.filter(task => task.stage === "comparison").length, 14);
});

test("search keeps the 6+1 dispatch order while multiple rounds remain in flight", async t => {
  const { f, config, workflow, state } = await fixture(true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.execution.sessionWindow = 14;
  const source = workflow.shards!(config, state), cases: string[] = [];
  for (let n = 0; n < 14; n++) {
    const shard = await source.next(); assert(shard); merge(state, shard);
    cases.push((shard.candidates[0] as Candidate).case_id);
  }
  assert(cases.slice(0, 7).every(id => id.endsWith("-1")));
  assert(cases.slice(7).every(id => id.endsWith("-2")));
  await source.next();
  const allowed = roundAdmission(state.manifest, true);
  assert.equal(state.manifest.tasks.filter(task => task.stage === "comparison" && allowed.has(task.id)).length, 14);
  assert.equal(await source.next(), undefined);
  assert(!source.done?.(), "in-flight rounds must drain before the source finishes");
});

test("AIME overlaps date rounds, bounds live units and refills a single freed slot", async t => {
  const { f, config, workflow, state } = await fixture(false, true, true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.execution.sessionWindow = 5;
  const source = workflow.shards!(config, state), rows: Candidate[] = [];
  for (let n = 0; n < 5; n++) {
    const shard = await source.next(); assert(shard); merge(state, shard); rows.push(shard.candidates[0] as Candidate);
  }
  assert.deepEqual(rows.map(row => row.batch_id), ["2026-10-27", "2026-10-27", "2026-10-26", "2026-10-26", "2026-10-27"]);
  assert(rows[4].case_id.endsWith("-2"));
  assert.equal(await source.next(), undefined);
  for (const task of state.manifest.tasks) if ((task.data as { candidate: Candidate }).candidate.input_id === rows[2].input_id)
    state.manifest.states[task.id].status = "succeeded";
  const next = await source.next(); assert(next); merge(state, next);
  assert.equal((next.candidates[0] as Candidate).batch_id, "2026-10-27");
  assert.equal((next.candidates[0] as Candidate).version, rows[1].version);
  assert.equal(await source.next(), undefined);
  assert(roundAdmission(state.manifest, false).size > 0);
});

test("an exhausted expert queue leaves the remaining fast pairs progressing", async t => {
  const { f, host, schedule, config, state } = await fixture(true); t.after(() => rm(f.directory, { recursive: true, force: true }));
  schedule.units = schedule.units.filter(unit => !unit.models[0].includes("expert") || unit.case_id.endsWith("-1"));
  const workflow = createRoundWorkflow(host, schedule), source = workflow.shards!(config, state);
  for (let n = 0; n < 7; n++) { const shard = await source.next(); assert(shard); merge(state, shard); }
  finish(state);
  for (let n = 0; n < 6; n++) { const shard = await source.next(); assert(shard); merge(state, shard); }
  assert.equal(await source.next(), undefined);
  finish(state); await source.next(); assert(source.done?.());
});

for (const attribution of [false, true]) test(`${attribution ? "AIME attribution" : "daily comparison"} interleaves real batches newest-first, independent of file/row names`, async t => {
  const { f, config, workflow, state } = await fixture(false, attribution, true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const source = workflow.shards!(config, state), seen: string[] = [];
  for (let round = 0; round < 2; round++) {
    for (let n = 0; n < 4; n++) {
      const shard = await source.next(); assert(shard); merge(state, shard);
      seen.push((shard.candidates[0] as Candidate).batch_id);
    }
    assert.equal(await source.next(), undefined);
    const allowed = roundAdmission(state.manifest, !attribution);
    const batch = (id: string) => {
      const data = state.manifest.tasks.find(task => task.id === id)!.data as { candidate?: Candidate; candidates?: Record<string, Candidate> };
      return (data.candidate ?? Object.values(data.candidates!)[0]).batch_id;
    };
    assert.deepEqual([...new Set([...allowed].map(batch))].sort().reverse(), ["2026-10-27", "2026-10-26"]);
    finish(state);
  }
  assert.deepEqual(seen, ["2026-10-27", "2026-10-27", "2026-10-26", "2026-10-26", "2026-10-27", "2026-10-27", "2026-10-26", "2026-10-26"]);
  await source.next(); assert(source.done?.());
  assert.equal((state.manifest.preflight.rounds as { number: number }).number, 2);
});

test("resume retains the unfinished round and shared input UUIDs without rescanning input files", async t => {
  const { f, host, config, workflow, state, schedule } = await fixture(true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const source = workflow.shards!(config, state), first = await source.next(); assert(first); merge(state, first);
  const original = new Map((state.manifest.inputCatalog as Candidate[]).map(c => [c.version, c.input_id]));
  const restored = structuredClone(state);
  const file = path.join(f.directory, "schedule.json"); await writeJson(file, schedule);
  const changed = config.inputs.versions[0];
  await writeJsonl(changed.sources[0].path, [2, 1].map(n => ({ ...raw("Fast-" + n), batch_id: "search_eval" })));
  const refreshed = await loadInputSchedule(host, file, new AbortController().signal);
  const resumedWorkflow = createRoundWorkflow(host, refreshed);
  await resumedWorkflow.reconcile!(f.directory, restored, config);
  assert.equal(roundAdmission(restored.manifest, true).size, 0, "saved tasks wait for current source bindings");
  const resumed = resumedWorkflow.shards!(config, restored);
  const lines = t.mock.method(fileSourceReader, "lines", () => { throw new Error("resume rescanned input"); });
  for (let n = 0; n < 7; n++) {
    const shard = await resumed.next(); assert(shard); merge(restored, shard);
    for (const id of Object.keys(shard.inputs)) assert.doesNotThrow(() => { void shard.inputs[id]; });
  }
  assert.equal(lines.mock.callCount(), 0);
  for (const c of restored.manifest.inputCatalog as Candidate[]) if (original.has(c.version)) assert.equal(c.input_id, original.get(c.version));
  assert.equal(restored.manifest.tasks.filter(t => t.stage === "comparison").length, 7);
  assert.equal(await resumed.next(), undefined);
});

test("completed outputs skip every selected unit before any source body is read", async t => {
  const { f, config, host, schedule } = await fixture(true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.output.layout = "business";
  const byPair = new Map<string, { case: { case_id: string } }[]>();
  for (const unit of schedule.units) {
    const name = unit.models.join("_vs_");
    byPair.set(name, [...(byPair.get(name) ?? []), { case: { case_id: unit.case_id } }]);
  }
  for (const [pair, rows] of byPair) await writeJsonl(path.join(config.output.path, "comparison", pair, pair + "-search_eval.jsonl"), rows);
  const workflow = createRoundWorkflow(host, schedule), plan = await workflow.plan(config);
  const state = { manifest: { tasks: [], states: {}, config, preflight: plan.summary }, receipts: {} } as unknown as RunState;
  t.mock.method(fileSourceReader, "record", () => { throw new Error("must skip before reading source"); });
  const source = workflow.shards!(config, state);
  assert.equal(await source.next(), undefined); assert(source.done?.());
  assert.equal(state.manifest.preflight.skipped_cases, 14);
});

test("AIME completion also recognizes the original session identity without reading its body", async t => {
  const { f, config, host, schedule } = await fixture(false, true); t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.output.layout = "business";
  for (const model of config.inputs.versions) {
    const units = schedule.units.filter(unit => unit.models[0] === model.id);
    for (const unit of units) unit.aliases = ["session-" + unit.case_id];
    await writeJsonl(path.join(config.output.path, model.id, model.id + "_attribution-search_eval.jsonl"),
      units.map(unit => ({ session_meta: { session_id: unit.aliases![0] } })));
  }
  const workflow = createRoundWorkflow(host, schedule), plan = await workflow.plan(config);
  const state = { manifest: { tasks: [], states: {}, config, preflight: plan.summary }, receipts: {} } as unknown as RunState;
  t.mock.method(fileSourceReader, "record", () => { throw new Error("completed session body was read"); });
  const source = workflow.shards!(config, state); assert.equal(await source.next(), undefined); assert(source.done?.());
  assert.equal(state.manifest.preflight.skipped_cases, 4);
});

test("the real Host runs overlapping rounds and publishes all 6+1 pairs", { timeout: 60000 }, async t => {
  const { f, config, workflow } = await fixture(true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  config.output.layout = "business";
  config.execution.sessionWindow = 14;
  const order: string[] = [];
  let comparisons = 0;
  const backend = { identity: fakeIdentity, async createSession(options: Parameters<Parameters<typeof startWorker>[0]["createSession"]>[0]) {
    return { async run() {
      await inspectFor(options);
      const comparison = options.spec.evaluation.id === "comparison";
      if (comparison && !comparisons++) await new Promise(resolve => setTimeout(resolve, 100));
      await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      if (comparison) order.push(options.spec.taskId);
    }, async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1, 2, 3].map(i => startWorker(backend, path.join(f.directory, "worker", String(i)))));
  t.after(() => Promise.all(workers.map(worker => worker.close())));
  const result = await runEvaluation({ ...services, report: undefined, taskSource: workflow,
    repository: businessResultRepository(comparisonRepository), runId: "round-host", output: config.output,
    config, plan: await workflow.plan(config), engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution, modelForStage: f.modelForStage, concurrency: 4, retries: 0, retryDelaySeconds: 0,
    workerUrls: workers.map(worker => worker.url), signal: AbortSignal.timeout(50000) });
  assert.equal(result.outcome, "complete", JSON.stringify(result));
  const saved = await comparisonRepository.readRun(runLayout(config.output, "round-host").directory);
  const pairs = saved.manifest.tasks.filter(task => task.stage === "comparison");
  assert.equal(pairs.length, 14); assert.equal(order.length, 14);
  assert(pairs.every(task => saved.manifest.states[task.id].status === "succeeded"));
  assert.equal(new Set(order).size, 14);
});

test("rebuilding changed index coordinates accepts the same business cases on resume", async t => {
  const { f, host } = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const file = path.join(f.directory, "input-schedule.json"), signal = new AbortController().signal;
  const first = await loadInputSchedule(host, file, signal);
  const version = host.evaluation.inputs.versions[0];
  await writeJsonl(version.sources[0].path, [{ ...raw("Fast-2"), batch_id: "search_eval" }, { ...raw("Fast-1"), batch_id: "search_eval" }]);
  const second = await loadInputSchedule(host, file, signal);
  assert.equal(first.records[0].case_id, "Fast-1"); assert.equal(second.records[0].case_id, "Fast-2");
  assert.equal(first.records[0].input_id, second.records.find(r => r.version === first.records[0].version && r.case_id === "Fast-1")!.input_id);
});

test("pause waits for the in-flight shard before saving its position", async t => {
  const { f, config, workflow } = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const pause = new AbortController(); let sent = false;
  const taskSource = { ...workflow, shards: (_config: unknown, state: RunState) => ({
    done: () => sent,
    async next() {
      if (sent) return undefined;
      sent = true; pause.abort(); await new Promise(resolve => setTimeout(resolve, 200));
      state.manifest.preflight.saved_input_position = 123;
      return { source: "fixture", revision: "", candidates: [], tasks: [], inputs: {} };
    },
  }) };
  const result = await runEvaluation({ ...services, report: undefined, taskSource, runId: "pause-input", output: config.output,
    config, plan: await workflow.plan(config), engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution, modelForStage: f.modelForStage, runtime: { ...services.runtime, workerEntry: "must-not-start" },
    concurrency: 1, retries: 0, retryDelaySeconds: 0, pauseSignal: pause.signal, signal: AbortSignal.timeout(5000) });
  assert.equal(result.status, "interrupted");
  assert.equal((await comparisonRepository.readRun(runLayout(config.output, "pause-input").directory)).manifest.preflight.saved_input_position, 123);
});

test("the real AIME Host publishes both models across dates with overlapping work", { timeout: 60000 }, async t => {
  const { f, host, schedule } = await fixture(false, true, true); t.after(() => rm(f.directory, { recursive: true, force: true }));
  schedule.units = schedule.units.filter(unit => unit.case_id.endsWith("-1"));
  const config = host.evaluation; config.output.layout = "business";
  const workflow = createRoundWorkflow(host, schedule);
  const backend = { identity: fakeIdentity, async createSession(options: Parameters<Parameters<typeof startWorker>[0]["createSession"]>[0]) {
    return { async run() { await inspectFor(options); await submitFor(options, draftFor(options.spec, taskResult(options.spec))); },
      async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1].map(i => startWorker(backend, path.join(f.directory, "worker", String(i)))));
  t.after(() => Promise.all(workers.map(w => w.close())));
  const result = await runEvaluation({ ...services, report: undefined, taskSource: workflow,
    repository: businessResultRepository(attributionRepository), runId: "aime-rounds", output: config.output,
    config, plan: await workflow.plan(config), engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution, modelForStage: f.modelForStage, concurrency: 4, retries: 0, retryDelaySeconds: 0,
    workerUrls: workers.map(w => w.url), signal: AbortSignal.timeout(50000) });
  assert.equal(result.outcome, "complete", JSON.stringify(result));
  const times = async (date: string) => Promise.all(config.inputs.versions.map(async v => {
    const file = path.join(config.output.path, v.id, v.id + "_attribution-" + date + ".jsonl");
    return (await stat(file)).mtimeMs;
  }));
  assert.equal((await times("2026-10-27")).length + (await times("2026-10-26")).length, 4);
});
