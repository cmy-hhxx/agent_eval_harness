import { compactReceipt } from "../../fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { emptyUsage, type RunState, type TaskPlan } from "@eval/contracts";
import { claimBusinessPartitions, readBusinessResults, readJsonl, runLayout, writeJsonl } from "@eval/data";
import { attributionRepository, type AttributionConfig } from "@eval/workflows/attribution";
import { stagedAttributionPlan as planAttribution } from "../../fixtures/shards.js";
import { buildPlan } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { services } from "@eval/host-app/composition";
import { businessAttributionRepository, businessComparisonRepository } from "../../../apps/host/src/business-results.js";
import { emptyAudit, fakeIdentity, fixtureConfig, sessionRaw } from "../../fixtures/comparison.js";
import type { Candidate, EvaluationConfig, RawInput } from "@eval/workflows/inputs";

const input = (answer = "2+2=4", caseId = "same-case") => {
  const value = { ...sessionRaw(caseId, null, answer), batch_id: "2026-10-26",
    case_id: caseId, request_time: "2026-10-25T17:22:06.486Z" };
  return value as typeof value & RawInput;
};
function stateFor(config: EvaluationConfig, plan: TaskPlan, runId: string) {
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId, status: "running",
    engine: fakeIdentity, evaluatorVersion: "current", config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: Date.now() }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  return state;
}
async function prepare(config: AttributionConfig, runId: string) {
  const plan = await planAttribution(config);
  assert(plan.tasks.length > 0, JSON.stringify(plan.summary));
  return { plan, state: stateFor(config, plan, runId), run: runLayout(config.output, runId).directory };
}
async function completed(config: AttributionConfig, runId: string, version: string, summary: string, acceptedAt: number, includeCompact = true) {
  const f = await prepare(config, runId);
  if (!includeCompact) {
    f.plan.tasks = f.plan.tasks.filter(task => !task.stage.startsWith("attribution-compact"));
    f.state.manifest.tasks = f.plan.tasks;
    for (const task of f.plan.tasks) delete task.dependencies.compact;
  }
  for (const task of f.plan.tasks) {
    f.state.manifest.states[task.id].status = "succeeded";
    f.state.receipts[task.id] = { taskId: task.id, attemptId: "attempt-" + task.id, submissionId: "submission-" + task.id,
      acceptedAt, evaluatorVersion: version, judge: "judge", status: "succeeded", audit: emptyAudit(), usage: emptyUsage(),
      evaluation: task.stage === "attribution-compact" ? compactReceipt().evaluation : task.stage === "attribution-session" ? { session_meta: input().meta,
        turns: [{ meta: input().traces[0].meta, summary: "完成。", problem: [], is_correct: null, correct_reason: "无标准。" }],
        session_summary: summary, session_problem: [] } : {} };
  }
  await attributionRepository.createResultWriter(f.run, f.plan.inputs)(f.state);
  await attributionRepository.writeRun(f.run, f.state);
  return f;
}

test("final case output skips evaluation without old receipts, source equality or evaluator checks", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business" },
    inputs: { ...f.config.inputs, versions: [f.config.inputs.versions[0], f.config.inputs.versions[2]] } } as AttributionConfig;
  const model = config.inputs.versions[0].id;
  const finalFile = path.join(config.output.path, model, model + "_attribution-2026-10-26.jsonl");
  const original = { session_meta: { case_id: "same-case" }, session_summary: "旧评测器的正式结果", turns: [], session_problem: [] };
  await writeJsonl(finalFile, [original]);
  // An edited input still belongs to this case; the output is authoritative until the user selects a new output directory.
  await writeJsonl(config.inputs.versions[0].sources[0].path, [input("不同回答")]);
  const next = await prepare(config, "resume-by-case");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, new Proxy({}, { get() { throw new Error("must not read old inputs"); } }));
  try {
    assert(next.state.manifest.tasks.length > 0, "the other model must still run");
    assert(next.state.manifest.tasks.every(task => (task.data as { candidate: { version: string } }).candidate.version !== model));
    assert.equal(next.state.manifest.preflight.skipped_cases, 1);
    assert.equal(Object.keys(next.state.receipts).length, 0, "never fabricate receipts or copy verdicts");
    const rows = []; for await (const row of readJsonl(finalFile)) rows.push(row);
    assert.deepEqual(rows, [original]);
  } finally { await close(); }
});

test("compact output and a different business date do not mark a case finished", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business" },
    inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const model = config.inputs.versions[0].id, row = { session_meta: { case_id: "same-case" } };
  await writeJsonl(path.join(config.output.path, model, "compact", model + "_compact-2026-10-26.jsonl"), [row]);
  await writeJsonl(path.join(config.output.path, model, model + "_attribution-2026-10-25.jsonl"), [row]);
  const next = await prepare(config, "missing-final"), count = next.plan.tasks.length;
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try { assert.equal(next.state.manifest.tasks.length, count); assert.equal(next.state.manifest.preflight.skipped_cases, 0); }
  finally { await close(); }
});

test("named task batches publish formal results and skip completed cases on resume", async t => {
  const value = { ...input(), batch_id: "search_eval" };
  const f = await fixtureConfig([[value], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business" },
    inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const accepted = await completed(config, "named-batch", "current", "保留任务批次", 1);
  const close = await businessAttributionRepository.prepareRun!(accepted.run, accepted.state, accepted.plan.inputs);
  try { await businessAttributionRepository.createResultWriter(accepted.run, accepted.plan.inputs)(accepted.state); }
  finally { await close(); }
  const model = config.inputs.versions[0].id;
  const rows = []; for await (const row of readJsonl(path.join(config.output.path, model, model + "_attribution-search_eval.jsonl"))) rows.push(row);
  assert.equal(rows.length, 1);
  assert((await readBusinessResults(config.output.path)).some(record => record.date === "search_eval" && record.published));
  const resumed = await prepare(config, "named-batch-resume");
  const release = await businessAttributionRepository.prepareRun!(resumed.run, resumed.state, resumed.plan.inputs);
  try { assert.equal(resumed.state.manifest.tasks.length, 0); assert.equal(resumed.state.manifest.preflight.skipped_cases, 1); }
  finally { await release(); }
});

test("partition conflicts block later shards and clear when a resumed run acquires the lock", async t => {
  const f = await fixtureConfig([[input(), input("2+2=4", "next-case")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business" },
    inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const next = await prepare(config, "partition-conflict"), catalog = next.plan.catalog as Candidate[];
  const first = catalog.filter(candidate => candidate.case_id === "same-case");
  const later = catalog.filter(candidate => candidate.case_id === "next-case");
  const firstIds = new Set(first.map(candidate => candidate.input_id));
  const firstTasks = next.plan.tasks.filter(task => Object.values(task.inputIds).some(id => firstIds.has(id)));
  const laterTasks = next.plan.tasks.filter(task => !firstTasks.includes(task));
  assert(firstTasks.length > 0 && laterTasks.length > 0);
  next.state.manifest.tasks = firstTasks;
  next.state.manifest.inputCatalog = first;
  const other = await claimBusinessPartitions(config.output.path, [{ date: "2026-10-26", model: config.inputs.versions[0].id }]);
  let otherClosed = false;
  t.after(async () => { if (!otherClosed) await other.close(); });
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  t.after(close);
  for (const task of firstTasks) assert.equal(next.state.manifest.states[task.id].status, "blocked");
  await businessAttributionRepository.prepareShard!(next.run, next.state, next.plan.inputs, later, laterTasks);
  for (const task of laterTasks) {
    assert.equal(next.state.manifest.states[task.id].status, "blocked");
    assert(next.state.manifest.states[task.id].admissionBlock);
  }
  next.state.manifest.tasks.push(...laterTasks);
  next.state.manifest.inputCatalog.push(...later);
  await close(); await other.close(); otherClosed = true;
  const resumedClose = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    for (const task of next.state.manifest.tasks) {
      assert.equal(next.state.manifest.states[task.id].status, "pending");
      assert.equal(next.state.manifest.states[task.id].admissionBlock, undefined);
    }
  } finally { await resumedClose(); }
});

test("an existing comparison pair finishes a new run without starting a Worker", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, output: { ...f.config.output, layout: "business" as const } };
  await writeJsonl(path.join(config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-10-26.jsonl"),
    [{ case: { batch_id: "2026-10-26", case_id: "same-case" }, evaluator_version: "old" }]);
  await writeJsonl(path.join(config.output.path, ".delivery/provenance/2026-10-26.jsonl"), [{ unused: true }]);
  const plan = await buildPlan(config);
  const result = await runEvaluation({ ...services, report: undefined, repository: businessComparisonRepository,
    identity: fakeIdentity, engine: "pi", evaluatorVersion: "new", runtime: { ...services.runtime, workerEntry: "must-not-start" },
    runId: "case-output-only", output: config.output, config, plan, policy: config.execution, modelForStage: f.modelForStage,
    concurrency: 1, retries: 0, retryDelaySeconds: 0, signal: AbortSignal.timeout(10000) });
  assert.equal(result.status, "finished"); assert.notEqual(result.outcome, "partial");
  const restored = await businessComparisonRepository.readRun(runLayout(config.output, "case-output-only").directory);
  assert.equal(restored.manifest.tasks.length, 0);
  assert.equal(restored.manifest.preflight.skipped_cases, 1);
});

test("a restarted writer republishes a journaled result whose delivery row never landed", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business" },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const finished = await completed(config, "interrupted-delivery", "fixture", "已完成判词", Date.now());
  await businessAttributionRepository.createResultWriter(finished.run, finished.plan.inputs)(finished.state);
  const journal = path.join(config.output.path, ".delivery", "provenance", "2026-10-26.jsonl");
  const entries: { id: string; file: string; line: number; published: boolean }[] = [];
  for await (const entry of readJsonl(journal)) entries.push(entry as (typeof entries)[number]);
  const pending = entries.findLast(entry => entry.published && entry.file.endsWith("_attribution-2026-10-26.jsonl"))!;
  // Crash between journaling the result and appending its delivery row.
  await writeJsonl(journal, entries.filter(entry => !(entry.id === pending.id && entry.published)));
  const file = path.join(config.output.path, pending.file), delivered = [];
  for await (const row of readJsonl(file)) delivered.push(row);
  assert.equal(delivered.length, 1);
  await writeJsonl(file, []);
  // A restarted writer must not treat the journaled-but-unpublished submission as delivered.
  await businessAttributionRepository.createResultWriter(finished.run, finished.plan.inputs)(finished.state);
  const rebuilt = []; for await (const row of readJsonl(file)) rebuilt.push(row);
  assert.deepEqual(rebuilt, delivered);
});
