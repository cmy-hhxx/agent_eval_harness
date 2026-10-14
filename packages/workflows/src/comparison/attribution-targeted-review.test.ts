import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { attributionPilotFixture } from "../../../../tests/fixtures/attribution-pilot.js";
import { prepareAttributionTargetedReviews } from "./index.js";
import { attributionJobWorkflow, loadAttributionJobInputs } from "./attribution-job.js";
import { bindTask } from "./binding.js";
import { createResultWriter, readRunState, writeRunState } from "./run-data.js";
import type { AttributionResult, TaskData } from "./types.js";

const reasons = ["核验生成内容与采集内容的差异是否影响实际交付；若问题不成立，删除该发现。"];
async function setup(t: test.TestContext) {
  const fixture = await attributionPilotFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  return { ...fixture, source: fixture.chosen[0]! };
}

test("targeted attribution preview validates accepted selection without changing the checkpoint or results", async t => {
  const fixture = await setup(t), stateFile = path.join(fixture.run, "state.json"), resultsFile = path.join(fixture.run, "results", "attribution.jsonl");
  const before = await readFile(stateFile, "utf8"), results = await readFile(resultsFile, "utf8");
  const preview = await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons }] });
  assert.equal(preview.applied, false); assert.equal(preview.count, 1);
  assert.equal(preview.protected_accepted, Object.keys(fixture.state.receipts).length);
  assert.equal(preview.selected[0]!.source_task_id, fixture.source.id);
  assert.equal(preview.selected[0]!.review_task_id, null);
  assert.equal(preview.selected[0]!.round, 1); assert.deepEqual(preview.selected[0]!.reasons, reasons);
  const pending = fixture.state.manifest.tasks.find(task => task.stage === "attribution" && !fixture.state.receipts[task.id])!;
  for (const reviews of [[], [{ taskId: fixture.source.id, reasons: [] }], [{ taskId: fixture.source.id, reasons: [" "] }],
    [{ taskId: "unknown", reasons }], [{ taskId: fixture.source.dependencies.criteria, reasons }], [{ taskId: pending.id, reasons }],
    [{ taskId: fixture.source.id, reasons }, { taskId: fixture.source.id, reasons }]])
    await assert.rejects(prepareAttributionTargetedReviews(fixture.run, { reviews, apply: true }));
  assert.equal(await readFile(stateFile, "utf8"), before);
  assert.equal(await readFile(resultsFile, "utf8"), results);
});

test("targeted attribution appends one review and preserves accepted work, paid ledgers and the frozen answer scope", async t => {
  const fixture = await setup(t), before = await readRunState(fixture.run), resultsFile = path.join(fixture.run, "results", "attribution.jsonl");
  const results = await readFile(resultsFile, "utf8");
  const applied = await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons }], apply: true });
  const after = await readRunState(fixture.run), id = applied.selected[0]!.review_task_id!, review = after.manifest.tasks.find(task => task.id === id)!;
  assert.notEqual(id, fixture.source.id); assert.equal(review.stage, "attribution");
  assert.deepEqual(review.inputIds, fixture.source.inputIds); assert.deepEqual(review.dependencies, fixture.source.dependencies);
  assert.deepEqual((review.data as TaskData).candidates, (fixture.source.data as TaskData).candidates);
  assert.deepEqual((review.data as TaskData).reviewOf, { taskId: fixture.source.id, round: 1, reasons });
  assert.equal((review.data as TaskData).revision, 1);
  assert.deepEqual(after.manifest.tasks.filter(task => task.id !== id), before.manifest.tasks);
  assert.deepEqual(Object.fromEntries(Object.entries(after.manifest.states).filter(([taskId]) => taskId !== id)), before.manifest.states);
  assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.usage, before.usage);
  assert.equal(after.recordedAttempts, before.recordedAttempts);
  assert.deepEqual(after.manifest.config, before.manifest.config); assert.deepEqual(after.manifest.preflight, before.manifest.preflight);
  assert.deepEqual(after.manifest.executionScope, [...before.manifest.executionScope!, id]);
  assert.equal(await readFile(resultsFile, "utf8"), results);
  assert.equal(after.manifest.tasks.filter(task => task.stage === "comparison").length, 0);

  const reconciled = await attributionJobWorkflow.reconcile!(fixture.run, after, fixture.baseConfig);
  const binding = bindTask(review, reconciled.inputs, { criteria: after.receipts[review.dependencies.criteria]! }, { tasks: after.manifest.tasks });
  assert.deepEqual((binding.request.input as { review_context: unknown }).review_context, { reasons });
  const clean = structuredClone(after.receipts[fixture.source.id]!.evaluation as AttributionResult);
  clean.findings = [];
  const { exported: _exported, ...sourceReceipt } = after.receipts[fixture.source.id]!;
  after.receipts[id] = { ...structuredClone(sourceReceipt), taskId: id, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 2, evaluation: clean };
  after.manifest.states[id] = { status: "succeeded", attempts: 1, revision: 1 };
  await attributionJobWorkflow.reconcile!(fixture.run, after, fixture.baseConfig);
  const rewrites = after.manifest.tasks.filter(task => task.stage === "rewrite" && task.dependencies.source === id);
  assert(rewrites.length > 0, "review acceptance automatically plans its semantic Rewrite tasks");
  assert(rewrites.every(task => after.manifest.executionScope!.includes(task.id)));
  assert(rewrites.every(task => !(task.data as TaskData).rewriteSlotIds!.some(slot => slot.startsWith("findings."))),
    "a review can remove findings rather than only adding responsibility");
  assert(after.manifest.tasks.filter(task => task.stage === "attribution" && !before.manifest.executionScope!.includes(task.id) && task.id !== id)
    .every(task => !after.manifest.executionScope!.includes(task.id)), "unselected answers remain outside scope");
  assert.deepEqual(after.receipts[fixture.source.id], before.receipts[fixture.source.id]);
});

test("a selected historical attribution reviews the latest accepted source and advances its existing review round", async t => {
  const fixture = await setup(t), first = await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons }], apply: true });
  const state = await readRunState(fixture.run), firstId = first.selected[0]!.review_task_id!, review = state.manifest.tasks.find(task => task.id === firstId)!;
  const { exported: _exported, ...sourceReceipt } = state.receipts[fixture.source.id]!;
  state.receipts[firstId] = { ...structuredClone(sourceReceipt), taskId: firstId, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 2 };
  state.manifest.states[firstId] = { status: "succeeded", attempts: 2, revision: 1 };
  const inputs = await loadAttributionJobInputs(state.manifest, new Set([firstId]));
  await createResultWriter(fixture.run, inputs)(state); await writeRunState(fixture.run, state);
  const before = await readRunState(fixture.run);
  const second = await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons: ["独立核验另一处证据疑点。"] }], apply: true });
  assert.equal(second.selected[0]!.source_task_id, review.id); assert.equal(second.selected[0]!.round, 2);
  const after = await readRunState(fixture.run), secondId = second.selected[0]!.review_task_id!, next = after.manifest.tasks.find(task => task.id === secondId)!;
  assert.deepEqual(next.inputIds, review.inputIds); assert.deepEqual(next.dependencies, review.dependencies);
  assert.equal((next.data as TaskData).reviewOf!.taskId, review.id);
  assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(after.manifest.executionScope, [...before.manifest.executionScope!, secondId]);
});

test("repeated preparation reuses identical unfinished review without resetting its paid failure ledger", async t => {
  const fixture = await setup(t), selection = { reviews: [{ taskId: fixture.source.id, reasons }], apply: true };
  const first = await prepareAttributionTargetedReviews(fixture.run, selection), state = await readRunState(fixture.run), id = first.selected[0]!.review_task_id!;
  state.manifest.states[id] = { status: "failed", attempts: 3, revision: 1,
    failure: { errors: [], repeatedErrors: 0, stopped: false, contentSubmissions: 2, fileErrors: 1, attemptId: "paid-review" } };
  await writeRunState(fixture.run, state);
  const before = await readRunState(fixture.run), repeated = await prepareAttributionTargetedReviews(fixture.run, selection), after = await readRunState(fixture.run);
  assert.equal(repeated.selected[0]!.review_task_id, id); assert.equal(repeated.selected[0]!.status, "failed");
  assert.deepEqual(after.manifest.tasks, before.manifest.tasks); assert.deepEqual(after.manifest.states, before.manifest.states);
  assert.deepEqual(after.receipts, before.receipts); assert.equal(after.recordedAttempts, before.recordedAttempts);
  assert.deepEqual(after.manifest.executionScope, before.manifest.executionScope);
  const bytes = await readFile(path.join(fixture.run, "state.json"), "utf8");
  await assert.rejects(prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons: ["另一处疑点。"] }], apply: true }), /已有其他未完成/u);
  assert.equal(await readFile(path.join(fixture.run, "state.json"), "utf8"), bytes);
});

test("targeted review rejects comparison runs and keeps an unrestricted attribution run unrestricted", async t => {
  const fixture = await setup(t), state = await readRunState(fixture.run);
  delete state.manifest.executionScope;
  await writeRunState(fixture.run, state);
  await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons }], apply: true });
  const after = await readRunState(fixture.run);
  assert.equal(after.manifest.executionScope, undefined);
  after.manifest.config = fixture.baseConfig;
  await writeRunState(fixture.run, after);
  const bytes = await readFile(path.join(fixture.run, "state.json"), "utf8");
  await assert.rejects(prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: fixture.source.id, reasons }], apply: true }), /独立归因/u);
  assert.equal(await readFile(path.join(fixture.run, "state.json"), "utf8"), bytes);
});
