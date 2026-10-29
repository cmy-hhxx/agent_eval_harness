import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rename, rm } from "node:fs/promises";
import { emptyUsage, type RunState, type TaskAnalysis, type TaskPlan } from "@eval/contracts";
import { localFiles, readJsonl, runLayout, writeJson, writeJsonl } from "@eval/data";
import { attributionRepository, planAttribution, type AttributionConfig } from "@eval/workflows/attribution";
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
async function completed(config: AttributionConfig, runId: string, version: string, summary: string, acceptedAt: number) {
  const f = await prepare(config, runId);
  for (const task of f.plan.tasks) {
    f.state.manifest.states[task.id].status = "succeeded";
    f.state.receipts[task.id] = { taskId: task.id, attemptId: "attempt-" + task.id, submissionId: "submission-" + task.id,
      acceptedAt, evaluatorVersion: version, judge: "judge", status: "succeeded", audit: emptyAudit(), usage: emptyUsage(),
      evaluation: task.stage === "attribution-session" ? { session_meta: input().meta,
        turns: [{ meta: input().traces[0].meta, summary: "完成。", problem: [], is_correct: null, correct_reason: "无标准。" }],
        session_summary: summary, session_problem: [] } : {} };
  }
  await attributionRepository.createResultWriter(f.run, f.plan.inputs)(f.state);
  await attributionRepository.writeRun(f.run, f.state);
  return f;
}

test("new runs reuse the latest complete business answer across evaluator versions and keep models separate", async t => {
  const f = await fixtureConfig([[input()], [], [input()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", output: { ...f.config.output, layout: "business", reuseCompleted: true },
    inputs: { ...f.config.inputs, batches: ["2026-10-26"], versions: [f.config.inputs.versions[0], f.config.inputs.versions[2]] } } as AttributionConfig;
  await completed(config, "old-run", "old-evaluator", "旧判词", Date.now() + 10);
  const latest = await completed(config, "newer-run", "newer-evaluator", "最新判词", Date.now() + 20);
  const next = await prepare(config, "new-run-id");
  const close = await businessAttributionRepository.prepareRun!(next.run, next.state, next.plan.inputs);
  try {
    assert.equal(next.state.manifest.tasks.length, 2, "accepted sessions do not dispatch their component/trace DAG again");
    assert(Object.values(next.state.receipts).every(receipt => receipt.evaluatorVersion === "newer-evaluator"));
    assert(Object.values(next.state.receipts).every(receipt => receipt.reusedFrom?.run === latest.run));
    await businessAttributionRepository.createResultWriter(next.run, next.plan.inputs)(next.state);
    await businessAttributionRepository.writeRun(next.run, next.state);
    const resumed = await businessAttributionRepository.readRun(next.run);
    assert.equal(Object.keys(resumed.receipts).length, 2);
    for (const model of config.inputs.versions) {
      const rows = []; for await (const row of readJsonl(path.join(config.output.path, model.id, model.id + "-2026-10-26.jsonl"))) rows.push(row);
      assert.equal(rows.length, 1);
      assert.equal((rows[0] as { session_summary: string }).session_summary, "最新判词");
    }
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
  const model = config.inputs.versions[0].id, relative = model + "/" + model + "-2026-10-26.jsonl";
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
    assert.equal(next.state.manifest.tasks.length, 1);
    const receipt = Object.values(next.state.receipts)[0];
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
  assert.equal(restored.manifest.tasks.length, 4);
  assert(Object.values(restored.receipts).every(receipt => receipt.evaluatorVersion === "original-evaluator"));
  const formal = []; for await (const row of readJsonl(path.join(config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-10-26.jsonl"))) formal.push(row);
  assert.equal(formal.length, 1);
  assert.equal((formal[0] as { evaluator_version: string }).evaluator_version, "original-evaluator");
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
