import { compactReceipt } from "../../fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rename, rm } from "node:fs/promises";
import { emptyUsage, type PlannedTask, type RunState, type TaskAnalysis, type TaskPlan } from "@eval/contracts";
import { localFiles, readJsonl, runLayout, writeJson, writeJsonl } from "@eval/data";
import { attributionRepository, type AttributionConfig } from "@eval/workflows/attribution";
import { stagedAttributionPlan as planAttribution } from "../../fixtures/shards.js";
import { buildPlan, comparisonRepository, type TaskData } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { services } from "@eval/host-app/composition";
import { businessAttributionRepository, businessComparisonRepository } from "../../../apps/host/src/business-results.js";
import { comparisonResult, criteriaResultForTask, emptyAudit, fakeIdentity, fixtureConfig, sessionRaw } from "../../fixtures/comparison.js";
import type { EvaluationConfig, RawInput } from "@eval/workflows/inputs";

const input = (answer = "2+2=4") => {
  const value = { ...sessionRaw("same-case", null, answer), batch_id: "2026-10-26",
    case_id: "same-case", request_time: "2026-10-25T17:22:06.486Z" };
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

test("business admission resolves a large rewrite fan-out without repeated manifest scans", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []], true);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, output: { ...f.config.output, layout: "business" as const, reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"] } };
  const plan = await buildPlan(config), rewrite = plan.tasks.find(task => task.stage === "rewrite")!;
  assert(rewrite);
  plan.tasks.unshift(...Array.from({ length: 1000 }, (_, i) => ({ ...structuredClone(rewrite), id: `rewrite-${i}` })));
  let visited = 0;
  Object.defineProperty(plan.tasks, "find", { value: (predicate: (task: PlannedTask, index: number) => unknown) =>
    Array.prototype.find.call(plan.tasks, (task: PlannedTask, index: number) => { visited++; return predicate(task, index); }) });
  const state = stateFor(config, plan, "indexed-load"), run = runLayout(config.output, "indexed-load").directory;
  const close = await businessComparisonRepository.prepareRun!(run, state, plan.inputs);
  try {
    assert(visited <= plan.tasks.length * 4, `visited ${visited} tasks for ${plan.tasks.length} planned tasks`);
    assert(state.manifest.tasks.every(task => !state.manifest.states[task.id].admissionBlock));
  } finally { await close(); }
});

test("new runs reuse the latest complete business answer across evaluator versions and keep models separate", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: [f.config.inputs.versions[0], f.config.inputs.versions[2]] } } as AttributionConfig;
  const oldest = await completed(config, "old-run", "old-evaluator", "旧判词", Date.now() + 10);
  const latest = await completed(config, "newer-run", "newer-evaluator", "最新判词", Date.now() + 20);
  const next = await prepare(config, "new-run-id");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    assert.deepEqual((next.plan.catalog as { version: string; input_id: string }[]).map(candidate => [candidate.version, candidate.input_id]),
      (oldest.plan.catalog as { version: string; input_id: string }[]).map(candidate => [candidate.version, candidate.input_id]),
      "verified identical input retains the persistent source UUID across fresh runs");
    assert(next.state.manifest.tasks.every(task => Object.values(task.inputIds).every(id => Object.hasOwn(next.plan.inputs, id))));
    assert.equal(next.state.manifest.tasks.length, 4, "accepted sessions do not dispatch their component/trace DAG again");
    assert(Object.values(next.state.receipts).every(receipt => receipt.evaluatorVersion === "newer-evaluator"));
    assert(Object.values(next.state.receipts).every(receipt => receipt.reusedFrom?.run === latest.run));
    await businessAttributionRepository.createResultWriter(next.run, next.plan.inputs)(next.state);
    await businessAttributionRepository.writeRun(next.run, next.state);
    const resumed = await businessAttributionRepository.readRun(next.run);
    assert.equal(Object.keys(resumed.receipts).length, 4);
    for (const model of config.inputs.versions) {
      const rows = []; for await (const row of readJsonl(path.join(config.output.path, model.id, model.id + "_attribution-2026-10-26.jsonl"))) rows.push(row);
      assert.equal(rows.length, 1);
      assert.equal((rows[0] as { session_summary: string }).session_summary, "最新判词");
      const compacts = []; for await (const row of readJsonl(path.join(config.output.path, model.id, "compact", model.id + "_compact-2026-10-26.jsonl"))) compacts.push(row);
      assert.equal(compacts.length, 1);
    }
  } finally { await close(); }
});

test("resuming a partially published run verifies its own receipts without blocking unfinished work", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const current = await completed(config, "partially-published", "current", "完成", Date.now() + 10);
  for (const task of current.state.manifest.tasks) if (task.stage !== "attribution-compact") {
    delete current.state.receipts[task.id];
    current.state.manifest.states[task.id] = { status: "pending", attempts: 0 };
  }
  await businessAttributionRepository.createResultWriter(current.run, current.plan.inputs)(current.state);
  await attributionRepository.writeRun(current.run, current.state);
  const resumed = await businessAttributionRepository.readRun(current.run);
  const close = await businessAttributionRepository.prepareRun!(current.run, resumed, current.plan.inputs);
  try {
    assert(resumed.manifest.tasks.some(task => !resumed.receipts[task.id]));
    assert(resumed.manifest.tasks.every(task => !resumed.manifest.states[task.id].admissionBlock));
    assert.equal(Object.keys(resumed.receipts).length, 1);
  } finally { await close(); }
});

test("organized historical verdicts retain missing newer fields and are reused from an explicitly located ledger", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const original = await completed(config, "organized-origin", "historical-evaluator", "历史判词", Date.now() + 10);
  const source = original.state.manifest.tasks.find(task => task.stage === "attribution-session")!;
  const row = structuredClone(original.state.receipts[source.id].exported!.row);
  row.session_problem = [{ problem_id: "old-problem", component: "终稿生成轮", label: "旧问题", definition: "旧定义",
    problem_phenomena: "旧现象", reason: "旧依据", evidence: [] }];
  await writeJsonl(path.join(original.run, "results/attribution.jsonl"), [row]);
  const model = config.inputs.versions[0].id, relative = model + "/" + model + "_attribution-2026-10-26.jsonl";
  const unrelated = { session_meta: { session_id: "unselected-original" }, turns: [], session_summary: "保留原结果", session_problem: [] };
  await writeJsonl(path.join(config.output.path, relative), [row, unrelated]);
  await writeJson(path.join(original.run, "organization.json"), { source_file: path.join(original.run, "results/attribution.jsonl"),
    files: [{ artifact: "attribution.jsonl", relative, date: "2026-10-26", model, rows: 1, source_lines: [1] }] });
  const archived = path.join(config.output.path, ".archive", "organized-origin");
  await localFiles.mkdir(path.dirname(archived), { recursive: true });
  await rename(original.run, archived);
  config.output.receiptSources = [archived];
  const next = await prepare(config, "reuse-organized");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    assert.equal(next.state.manifest.tasks.length, 2);
    const receipt = next.state.receipts[next.state.manifest.tasks.find(task => task.stage === "attribution-session")!.id];
    assert.equal(receipt.evaluatorVersion, "historical-evaluator");
    assert.equal(receipt.reusedFrom?.run, archived);
    assert.deepEqual(receipt.evaluation, row);
    await businessAttributionRepository.createResultWriter(next.run, next.plan.inputs)(next.state);
    const rows = []; for await (const result of readJsonl(path.join(config.output.path, relative))) rows.push(result);
    assert.deepEqual(rows, [row, unrelated]);
  } finally { await close(); }
});

test("Comparison and shared Criteria reuse their original receipts and finish without starting a Worker", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, output: { ...f.config.output, layout: "business" as const, reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"] } };
  const plan = await buildPlan(config), state = stateFor(config, plan, "comparison-origin"), at = Date.now() + 10;
  for (const task of plan.tasks) {
    state.manifest.states[task.id].status = "succeeded";
    state.receipts[task.id] = { taskId: task.id, attemptId: "attempt-" + task.id, submissionId: "submission-" + task.id,
      acceptedAt: at, evaluatorVersion: "original-evaluator", judge: "judge", status: "succeeded", audit: emptyAudit(), usage: emptyUsage(), evaluation: {} };
  }
  for (const task of plan.tasks) if (task.stage === "attribution-compact") state.receipts[task.id].evaluation = compactReceipt().evaluation;
  for (const task of plan.tasks) if (task.stage === "criteria") state.receipts[task.id].evaluation = criteriaResultForTask(task, plan.inputs);
  for (const task of plan.tasks) if (task.stage === "attribution-session") state.receipts[task.id].evaluation = {
    session_meta: input().meta, turns: [{ meta: input().traces[0].meta, summary: "完成。", problem: [], is_correct: null, correct_reason: "无标准。" }],
    session_summary: "原归因", session_problem: [] };
  for (const task of plan.tasks) if (task.stage === "comparison") state.receipts[task.id].evaluation =
    comparisonResult(Object.keys((task.data as TaskData).candidates), state.receipts[task.dependencies.criteria].evaluation as TaskAnalysis);
  const run = runLayout(config.output, "comparison-origin").directory;
  await comparisonRepository.createResultWriter(run, plan.inputs)(state);
  await comparisonRepository.writeRun(run, state);
  const next = await buildPlan(config);
  const result = await runEvaluation({ ...services, report: undefined, repository: businessComparisonRepository,
    taskSource: { ...services.taskSource }, identity: fakeIdentity, engine: "pi", evaluatorVersion: "later-evaluator",
    runtime: { ...services.runtime, workerEntry: path.join(f.directory, "must-not-start.mjs") },
    runId: "comparison-reused", output: config.output, config, plan: next, policy: config.execution,
    modelForStage: f.modelForStage, concurrency: 2, retries: 0, retryDelaySeconds: 0, signal: AbortSignal.timeout(10_000) });
  assert.equal(result.status, "finished", JSON.stringify(result));
  assert.notEqual(result.outcome, "partial");
  const restored = await businessComparisonRepository.readRun(runLayout(config.output, "comparison-reused").directory);
  assert.equal(restored.manifest.tasks.length, 6);
  assert(Object.values(restored.receipts).every(receipt => receipt.evaluatorVersion === "original-evaluator"));
  const formal = []; for await (const row of readJsonl(path.join(config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-10-26.jsonl"))) formal.push(row);
  assert.equal(formal.length, 1);
  assert.equal((formal[0] as { evaluator_version: string }).evaluator_version, "original-evaluator");
  const comparison = restored.manifest.tasks.find(task => task.stage === "comparison")!;
  const data = comparison.data as TaskData, rewriteId = "rewrite-comparison-reason";
  const reason = "双方都好：两个模型都给出了正确的 2+2=4，结果清楚可用。";
  const target = runLayout(config.output, "comparison-reused").directory;
  const write = businessComparisonRepository.createResultWriter(target, next.inputs);
  await write(restored);
  restored.manifest.tasks.push({ id: rewriteId, stage: "rewrite", inputIds: {}, dependencies: { source: comparison.id },
    data: { stage: "rewrite", candidates: {}, reference: null, case: { batch_id: "2026-10-26", case_id: "same-case", question: data.candidates.A.question },
      rewriteOf: { stage: "comparison", taskId: comparison.id, resultId: data.comparisonId! },
      rewriteNames: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => [label, candidate.name])) } satisfies TaskData });
  restored.manifest.states[rewriteId] = { status: "succeeded", attempts: 1 };
  restored.receipts[rewriteId] = { ...restored.receipts[comparison.id], taskId: rewriteId, submissionId: rewriteId,
    acceptedAt: at + 1, evaluation: { rewrites: [{ id: "verdict.A__vs__B.reason", text: reason }] } };
  delete restored.receipts[rewriteId].exported;
  await write(restored);
  await businessComparisonRepository.writeRun(target, restored);
  const readReason = async () => {
    const rows: any[] = []; for await (const row of readJsonl(path.join(config.output.path,
      "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-10-26.jsonl"))) rows.push(row);
    assert.equal(rows.length, 1);
    assert.equal(Object.values(rows[0].verdicts as Record<string, { reason: string }>)[0].reason, reason);
  };
  await readReason();
  const replay = await businessComparisonRepository.readRun(target);
  await businessComparisonRepository.createResultWriter(target, {})(replay);
  await readReason();
});

test("an in-place answer change cannot inherit an older completed verdict", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  await completed(config, "before-edit", "old-evaluator", "旧回答的判词", Date.now() + 10);
  await writeJsonl(config.inputs.versions[0].sources[0].path, [input("2+2=5")]);
  const next = await prepare(config, "after-edit");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    assert.equal(Object.keys(next.state.receipts).length, 0);
    assert(next.state.manifest.tasks.every(task => next.state.manifest.states[task.id].admissionBlock),
      "unverifiable old source identity is paused instead of silently reusing or reevaluating it");
  } finally { await close(); }
});

test("a restarted writer republishes a journaled result whose delivery row never landed", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
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

test("an accepted attribution without compact only schedules the missing summary and retains the original verdict", async t => {
  const f = await fixtureConfig([[input()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  await completed(config, "accepted-without-summary", "original-evaluator", "保留原正式判词。", Date.now() + 10, false);
  const next = await prepare(config, "backfill-summary");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    assert.equal(next.state.manifest.tasks.filter(task => task.stage === "attribution-compact-field").length, 9);
    assert.deepEqual(next.state.manifest.tasks.filter(task => task.stage !== "attribution-compact-field").map(task => task.stage).sort(), ["attribution-compact", "attribution-session"]);
    const compact = next.state.manifest.tasks.find(task => task.stage === "attribution-compact")!;
    const source = next.state.manifest.tasks.find(task => task.stage === "attribution-session")!;
    assert.equal(next.state.manifest.states[compact.id]!.status, "pending");
    assert.equal(next.state.manifest.states[source.id]!.status, "succeeded");
    assert.equal(next.state.receipts[source.id]!.evaluatorVersion, "original-evaluator");
    assert.equal((next.state.receipts[source.id]!.evaluation as { session_summary: string }).session_summary, "保留原正式判词。");
  } finally { await close(); }
});
