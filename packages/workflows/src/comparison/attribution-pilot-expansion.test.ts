import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { attributionPilotFixture } from "../../../../tests/fixtures/attribution-pilot.js";
import { attributionResult } from "../../../../tests/fixtures/comparison.js";
import { prepareAttributionPilotExpansion } from "./attribution-pilot-expansion.js";
import { readRunState, writeRunState, createResultWriter } from "./run-data.js";
import { attributionRewritePlaceholder } from "./attribution-rewrite-planning.js";
import { attributionSlots } from "./commentary.js";
import type { TaskData } from "./types.js";

test("pilot expansion previews exact per-model quotas without changing the saved plan or results", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.run, "state.json"), before = await readFile(file, "utf8");
  const result = await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3 });
  assert.equal(result.applied, false); assert.equal(result.pilot_answers, 12); assert.equal(result.added_answers, 10);
  assert(Object.values(result.models).every(model => model.selected === 3));
  assert.equal(new Set(result.selected_answers.map(answer => answer.input_id)).size, 12);
  assert.deepEqual(result.selected_answers.slice(0, 2).map(answer => answer.task_id), fixture.chosen.map(task => task.id));
  assert.equal(await readFile(file, "utf8"), before);
});

test("applied expansion retains task UUIDs, attempts, receipts and results while freezing only selected dependencies", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const before = await readRunState(fixture.run), attributionFile = path.join(fixture.run, "results", "attribution.jsonl"), resultBefore = await readFile(attributionFile, "utf8");
  const result = await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3, apply: true }), after = await readRunState(fixture.run);
  assert.deepEqual(after.manifest.tasks, before.manifest.tasks);
  assert.deepEqual(after.manifest.states, before.manifest.states);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.recordedAttempts, before.recordedAttempts);
  assert.deepEqual(after.usage, before.usage); assert.deepEqual(after.manifest.config, before.manifest.config);
  assert.equal(await readFile(attributionFile, "utf8"), resultBefore);
  const sourceIds = new Set(result.selected_answers.map(answer => answer.task_id)), scope = new Set(after.manifest.executionScope);
  assert.equal(after.manifest.tasks.filter(task => task.stage === "attribution" && scope.has(task.id)).length, 12);
  for (const task of after.manifest.tasks) {
    if (task.stage === "attribution") assert.equal(scope.has(task.id), sourceIds.has(task.id));
    if (task.stage === "rewrite") assert.equal(scope.has(task.id), sourceIds.has(task.dependencies.source));
  }
  for (const id of sourceIds) assert(scope.has(after.manifest.tasks.find(task => task.id === id)!.dependencies.criteria));
  assert.equal(after.manifest.preflight.pilot_answers, 12);
  assert.equal((after.manifest.preflight.selected_answers as unknown[]).length, 12);
  const repeated = await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3 });
  assert.equal(repeated.added_answers, 0); assert.deepEqual(repeated.selected_answers, result.selected_answers);
});

test("a model's shortfall and shrinking existing selection fail before any checkpoint change", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.run, "state.json"), before = await readFile(file, "utf8");
  await assert.rejects(prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 7, apply: true }), /不足 7 份回答/);
  assert.equal(await readFile(file, "utf8"), before);
  await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3, apply: true });
  await assert.rejects(prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 2, apply: true }), /不能收缩/);
  await assert.rejects(prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 0 }), /正整数/);
});

test("accepted replacement and active reviews retain their rewrite work without rerunning a replaced failed primary", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const state = fixture.state, primary = state.manifest.tasks.filter(task => task.stage === "attribution")[2], data = primary.data as TaskData;
  state.manifest.states[primary.id] = { status: "failed", attempts: 4 };
  const accepted = { ...primary, id: randomUUID(), data: { ...data, reviewOf: { taskId: primary.id, round: 1, reasons: ["恢复复核"] } } };
  const active = { ...primary, id: randomUUID(), data: { ...data, reviewOf: { taskId: accepted.id, round: 2, reasons: ["定向复核"] } } };
  const rewrite = attributionRewritePlaceholder(accepted.id, { rewriteNames: { A: data.candidates.A.name },
    case: { batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id, question: data.candidates.A.question } });
  const activeRewrite = attributionRewritePlaceholder(active.id, (rewrite.data as TaskData));
  state.manifest.tasks.push(accepted, rewrite, active, activeRewrite);
  const template = state.receipts[fixture.chosen[0].id];
  const evaluation = attributionResult(true, "2+2=4", true, primary.inputIds.answer);
  state.receipts[accepted.id] = { ...structuredClone(template), taskId: accepted.id, submissionId: randomUUID(), acceptedAt: 2, evaluation };
  state.receipts[rewrite.id] = { ...structuredClone(template), taskId: rewrite.id, submissionId: randomUUID(), acceptedAt: 3,
    evaluation: { rewrites: attributionSlots(evaluation).map(slot => ({ id: slot.id, text: "保留点评" })) } };
  delete state.receipts[accepted.id].exported;
  delete state.receipts[rewrite.id].exported;
  state.manifest.states[accepted.id] = { status: "succeeded", attempts: 2 };
  state.manifest.states[rewrite.id] = { status: "succeeded", attempts: 2 };
  state.manifest.states[active.id] = { status: "pending", attempts: 0 };
  state.manifest.states[activeRewrite.id] = { status: "pending", attempts: 0 };
  state.manifest.executionScope!.push(primary.id, accepted.id, rewrite.id, active.id, activeRewrite.id);
  (state.manifest.preflight.selected_answers as unknown[]).push({ task_id: primary.id, input_id: data.candidates.A.input_id,
    version: data.candidates.A.version, batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id });
  await createResultWriter(fixture.run, fixture.inputs)(state); await writeRunState(fixture.run, state);
  const before = await readRunState(fixture.run), result = await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3, apply: true });
  const after = await readRunState(fixture.run), scope = new Set(after.manifest.executionScope);
  assert(!scope.has(primary.id));
  for (const task of [accepted, rewrite, active, activeRewrite]) assert(scope.has(task.id));
  assert.equal(result.selected_answers.find(item => item.input_id === data.candidates.A.input_id)!.task_id, accepted.id);
  assert.deepEqual(after.manifest.states, before.manifest.states); assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.manifest.states[primary.id].attempts, 4);
  assert.equal(result.pilot_answers, 12);
  const repeated = await prepareAttributionPilotExpansion(fixture.run, { answersPerModel: 3 });
  assert.equal(repeated.added_answers, 0);
});
