import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { RunStore } from "@eval/host";
import { services } from "../../../../tests/fixtures/services.js";
import { attributionResult, comparisonResult, criteriaResultForTask, emptyAudit,
  fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { comparisonCodec } from "./codec.js";
import { encodeResult, originalResultRow, stageResult } from "./results.js";
import { readRunState, writeRunState } from "./run-data.js";
import { prepareComparisonVerification } from "./verification-preparation.js";
import type { TaskData } from "./types.js";

const receiptFor = (task: PlannedTask, evaluation: unknown): SubmissionReceipt => ({
  taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), status: "succeeded", acceptedAt: 1,
  evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation, audit: emptyAudit(), usage: emptyUsage(),
});

async function setup() {
  const fixture = await fixtureConfig(undefined, true), plan = await buildPlan(fixture.config);
  const source = plan.tasks.find(task => task.stage === "comparison" && !(task.data as TaskData).verificationAudit)!;
  const criteria = plan.tasks.find(task => task.stage === "criteria")!;
  const analysis = criteriaResultForTask(criteria, plan.inputs);
  const state = { manifest: { format: "evaluation-run", runId: "optional", engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config: fixture.config, preflight: plan.summary, tasks: plan.tasks,
    inputCatalog: plan.catalog, inputs: {}, status: "completed", finishedAt: 1,
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])) },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 } as unknown as RunState;
  state.receipts[criteria.id] = receiptFor(criteria, analysis);
  for (const task of plan.tasks.filter(task => task.stage === "attribution")) {
    const result = attributionResult(true, "2+2=4", true, (task.data as TaskData).candidates.A.input_id);
    result.task_analysis = analysis;
    state.receipts[task.id] = receiptFor(task, result);
  }
  const result = comparisonResult(); result.task_analysis = analysis;
  state.receipts[source.id] = receiptFor(source, result);
  for (const task of plan.tasks) if (state.receipts[task.id]) state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  const run = path.join(fixture.directory, "optional-run");
  await new RunStore(run, state, plan.inputs, services).save();
  return { ...fixture, plan, state: await readRunState(run), source, result, run };
}

test("optional verification previews without mutation, freezes only audit work and reuses its paid task", async () => {
  const f = await setup();
  try {
    const checkpoint = await readFile(path.join(f.run, "state.json"), "utf8"), sourceData = structuredClone(f.source);
    const selection = { resultIds: [(f.source.data as TaskData).comparisonId!] };
    const preview = await prepareComparisonVerification(f.run, selection);
    assert.equal(preview.count, 1);
    assert.equal(preview.selected[0]!.verification_task_id, null);
    await assert.rejects(prepareComparisonVerification(f.run, { resultIds: ["missing"], apply: true }), /未知正式对比结果/);
    assert.equal(await readFile(path.join(f.run, "state.json"), "utf8"), checkpoint);
    const applied = await prepareComparisonVerification(f.run, { ...selection, apply: true });
    let prepared = await readRunState(f.run);
    const id = applied.selected[0]!.verification_task_id!, check = prepared.manifest.tasks.find(task => task.id === id)!;
    assert.notEqual(id, f.source.id);
    assert.equal((check.data as TaskData).verificationAudit, true);
    assert.deepEqual((check.data as TaskData).verificationOf, { taskId: f.source.id });
    assert.deepEqual(check.dependencies, { ...f.source.dependencies, draft: f.source.id });
    assert.deepEqual(prepared.manifest.executionScope, [id]);
    assert.deepEqual(prepared.manifest.tasks.find(task => task.id === f.source.id), f.state.manifest.tasks.find(task => task.id === f.source.id));
    assert.deepEqual(prepared.receipts, f.state.receipts);
    assert.deepEqual(f.source, sourceData);
    const failure = { attemptId: randomUUID(), contentSubmissions: 3, fileErrors: 1, repeatedErrors: 0, stopped: true,
      evidenceBank: [], errors: [] };
    prepared.manifest.states[id] = { status: "failed", attempts: 2, reason: "provider failure", failure };
    await writeRunState(f.run, prepared);
    const repeated = await prepareComparisonVerification(f.run, { ...selection, apply: true });
    assert.equal(repeated.selected[0]!.verification_task_id, id);
    prepared = await readRunState(f.run);
    assert.equal(prepared.manifest.states[id].attempts, 2);
    assert.deepEqual(prepared.manifest.states[id].failure, failure);
    assert.equal(prepared.manifest.states[id].status, "pending");
    assert.equal(prepared.manifest.tasks.filter(task => (task.data as TaskData).verificationAudit).length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("optional verification has its own durable envelope and strict source identity", async () => {
  const f = await setup();
  try {
    const applied = await prepareComparisonVerification(f.run, { apply: true });
    const state = await readRunState(f.run), id = applied.selected[0]!.verification_task_id!;
    const check = state.manifest.tasks.find(task => task.id === id)!;
    const before = structuredClone(state.receipts[f.source.id]);
    const unresolved = { ...structuredClone(f.result), status: "needs_review", ranking: [],
      decision_basis: { ...structuredClone(f.result.decision_basis), decisive_findings: [] },
      review_requests: [{ candidate: "A", criterion_ids: ["r1"], finding_indices: [], reason: "可选复核发现证据不足。" }] };
    state.receipts[id] = receiptFor(check, unresolved);
    state.manifest.states[id] = { status: "succeeded", attempts: 1 };
    for (const field of ["verificationAudit", "verificationOf"] as const) {
      const invalid = structuredClone(check);
      delete (invalid.data as TaskData)[field];
      const invalidState = { ...state, manifest: { ...state.manifest,
        tasks: state.manifest.tasks.map(task => task.id === id ? invalid : task) } };
      assert.throws(() => bindTask(invalid, f.plan.inputs, {}, { tasks: state.manifest.tasks }), /必须同时声明/);
      assert.throws(() => encodeResult(invalid, invalidState, f.plan.inputs), /必须同时声明/);
      assert.throws(() => comparisonCodec.encode(invalidState), /必须同时声明/);
    }
    const exported = encodeResult(check, state, f.plan.inputs);
    assert.equal(exported.id, id);
    assert.equal(exported.file, "comparison-verification.jsonl");
    assert.equal(exported.row.evaluation_type, "comparison_verification");
    assert.equal(exported.row.comparison_id, (f.source.data as TaskData).comparisonId);
    assert.equal(exported.row.source_task_id, f.source.id);
    assert.deepEqual(stageResult("comparison", exported.row), unresolved);
    assert.deepEqual(originalResultRow("comparison", { ...exported.row,
      result: { ...(exported.row.result as object), rewritten: { rewrites: [] } } }), exported.row);
    state.receipts[id].exported = exported;
    const checkpoint = comparisonCodec.encode(state);
    for (const field of ["verificationAudit", "verificationOf"] as const) {
      const invalid = structuredClone(checkpoint);
      delete invalid.tasks[id].data[field];
      assert.throws(() => comparisonCodec.decode(invalid, () => exported.row), /必须同时声明/);
    }
    assert.deepEqual(checkpoint.tasks[id].receipt!.exported, { taskId: id, file: "comparison-verification.jsonl" });
    assert.equal(checkpoint.tasks[id].receipt!.evaluation, undefined);
    const rows = new Map(Object.values(state.receipts).map(receipt => [receipt.exported!.file + ":" + receipt.exported!.id, receipt.exported!.row]));
    const restored = comparisonCodec.decode(checkpoint, ref => rows.get(ref.file + ":" + ref.id)!);
    assert.deepEqual(restored.receipts[id], state.receipts[id]);
    assert.deepEqual(restored.receipts[f.source.id], before);
    assert.deepEqual(encodeResult(check, restored, {}).row, exported.row);
    assert.throws(() => comparisonCodec.decode(checkpoint, ref => ref.id === id
      ? { ...exported.row, source_task_id: "wrong" } : rows.get(ref.file + ":" + ref.id)!), /可选复核来源身份/);
    checkpoint.tasks[id].receipt!.exported!.file = "comparison.jsonl";
    assert.throws(() => comparisonCodec.decode(checkpoint, ref => rows.get(ref.file + ":" + ref.id)!), /可选复核结果引用/);
    await new RunStore(f.run, state, f.plan.inputs, services).save();
    const restoredFromDisk = await readRunState(f.run);
    assert.deepEqual(restoredFromDisk.receipts[id], state.receipts[id]);
    assert.equal((await prepareComparisonVerification(f.run, { apply: true })).count, 0, "an accepted audit is retained instead of duplicated");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
