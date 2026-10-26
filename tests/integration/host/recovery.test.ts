import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_POLICY,
  emptyUsage,
  type AttemptSpec,
  type RunManifest,
  type RunState,
  type Submission,
} from "@eval/contracts";
import {
  applyRunJournalDelta,
  exists,
  readProgressJournal,
  RunHotStore,
  runJournalIdentity,
} from "@eval/data";
import { buildPlan, createResultWriter, readRunState, writeRunState } from "@eval/workflows/comparison";
import { RunStore } from "@eval/host";
import { prepare, services } from "../../fixtures/services.js";
import {
  attributionResult,
  criteriaResultForTask,
  draftFor,
  emptyAudit,
  fakeEvaluatorVersion,
  fakeIdentity,
  fakeJudge,
  fixtureConfig,
  raw,
  taskResult,
} from "../../fixtures/comparison.js";

async function fixture(rows = [raw("q", null)]) {
  const { directory, config } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config), task = plan.tasks.find(item => item.stage === "attribution")!;
  const run = path.join(directory, "run");
  const manifest: RunManifest = {
    format: "evaluation-run", debug: false, runId: "test", status: "running", engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputs: {},
    states: Object.fromEntries(plan.tasks.map(item => [item.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: Date.now(),
  };
  const criteriaReceipts = Object.fromEntries(plan.tasks.filter(item => item.stage === "criteria").map(criteria => {
    manifest.states[criteria.id].status = "succeeded";
    return [criteria.id, { taskId: criteria.id, attemptId: "criteria", submissionId: randomUUID(),
      evaluation: criteriaResultForTask(criteria, plan.inputs), evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge,
      audit: emptyAudit(), usage: emptyUsage(), status: "succeeded" as const, acceptedAt: 0 }];
  }));
  const initial: RunState = { manifest, receipts: criteriaReceipts, usage: emptyUsage(), recordedAttempts: 0 };
  await createResultWriter(run, plan.inputs)(initial);
  await writeRunState(run, initial);
  const prepared = prepare(task, plan.inputs, { criteria: criteriaReceipts[task.dependencies.criteria] });
  prepared.evaluation = { ...prepared.evaluation, completionReview: undefined };
  const spec: AttemptSpec = {
    inputRevision: 1, runId: "test", taskId: task.id, attemptId: "first", engine: fakeIdentity,
    evidenceBank: [...prepared.evidenceBank], evaluation: prepared.evaluation,
    model: { provider: "mock", baseUrl: "http://127.0.0.1", api: "openai-completions",
      apiKeyEnv: "MOCK_KEY", model: "mock", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 },
    policy: DEFAULT_POLICY, prompt: prepared.prompt,
    inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })),
    hostUrl: "http://127.0.0.1", deadline: Date.now() + 60000,
  };
  const draft = draftFor(spec, attributionResult(true, "2+2=4", false, task.inputIds.answer)) as Record<string, unknown>;
  delete draft.is_correct;
  delete draft.correct_reason;
  const value: Submission = { taskId: task.id, attemptId: spec.attemptId, submissionId: randomUUID(), evaluation: draft,
    audit: { ...emptyAudit(), evidenceBank: [...spec.evidenceBank] }, usage: emptyUsage() };
  return { directory, run, initial, plan, spec, value };
}

function specForTask(store: RunStore, base: AttemptSpec, taskId: string, attemptId: string): AttemptSpec {
  const task = store.manifest.tasks.find(item => item.id === taskId)!;
  const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([key, id]) => [key, store.state.receipts[id]]));
  const prepared = prepare(task, store.inputs, dependencies);
  prepared.evaluation = { ...prepared.evaluation, completionReview: undefined };
  return { ...base, ...prepared, evidenceBank: [...prepared.evidenceBank], taskId, attemptId,
    inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })) };
}

async function productionStore(f: Awaited<ReturnType<typeof fixture>>) {
  const file = path.join(f.directory, "hot.sqlite");
  const hot = new RunHotStore(file, runJournalIdentity(f.initial));
  return { store: new RunStore(f.run, f.initial, f.plan.inputs, services, undefined, hot), file };
}

test("accepted receipts survive hot-journal replay without waiting for checkpoint projection", async () => {
  const f = await fixture();
  try {
    const { store, file } = await productionStore(f);
    await store.activate(f.spec);
    assert.equal((await store.accept(f.value)).submissionId, f.value.submissionId);
    assert.equal(await exists(path.join(f.run, "results/attribution.jsonl")), false);
    const replay = new RunHotStore(file, runJournalIdentity(f.initial));
    const baseline = await readRunState(f.run);
    for (const event of replay.eventsAfter(baseline.manifest.journalSequence ?? 0)) applyRunJournalDelta(baseline, event.event);
    replay.close();
    assert.equal(baseline.receipts[f.spec.taskId]!.submissionId, f.value.submissionId);
    assert.equal(baseline.manifest.states[f.spec.taskId].status, "succeeded");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("outbox exports immutable rows once and repeats idempotently", async () => {
  const f = await fixture();
  try {
    const { store } = await productionStore(f);
    await store.activate(f.spec);
    await store.accept(f.value);
    await store.flushOutbox(true);
    const result = path.join(f.run, "results/attribution.jsonl"), first = await readFile(result, "utf8");
    assert.equal(first.trim().split("\n").length, 1);
    assert((await readProgressJournal(f.run)).some(event => Object.hasOwn(event.event.receipts ?? {}, f.spec.taskId)));
    await store.flushOutbox(true);
    assert.equal(await readFile(result, "utf8"), first);
    const restored = await readRunState(f.run);
    assert.equal(restored.receipts[f.spec.taskId]!.submissionId, f.value.submissionId);
    assert.equal(restored.receipts[f.spec.taskId]!.exported?.file, "attribution.jsonl");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("duplicate submissions are idempotent and one submission id cannot span tasks", async () => {
  const f = await fixture([raw("q1", null), raw("q2", null)]);
  try {
    const { store } = await productionStore(f);
    await store.activate(f.spec);
    const results = await Promise.all([store.accept(f.value), store.accept(f.value), store.accept(f.value)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    const other = store.manifest.tasks.find(task => task.stage === "attribution" && task.id !== f.spec.taskId)!;
    const attempt = specForTask(store, f.spec, other.id, "other-attempt");
    await store.activate(attempt);
    await assert.rejects(store.accept({ ...f.value, taskId: other.id, attemptId: attempt.attemptId,
      evaluation: draftFor(attempt, taskResult(attempt)), audit: { ...emptyAudit(), evidenceBank: attempt.evidenceBank } }), /Submission ID/);
    await store.flushOutbox(true);
    await store.persistCheckpoint();
    const persisted = (await readRunState(f.run)).receipts;
    assert.equal(Object.hasOwn(persisted, f.spec.taskId), true);
    assert.equal(Object.hasOwn(persisted, other.id), false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("projection failure does not revoke an accepted receipt and retries on the next drain", async () => {
  const f = await fixture();
  try {
    let fail = true;
    const repository = { ...services.repository, createResultWriter() {
      return async () => { if (fail) { fail = false; throw new Error("temporary result failure"); } };
    } };
    const hot = new RunHotStore(":memory:", runJournalIdentity(f.initial));
    const store = new RunStore(f.run, f.initial, f.plan.inputs, { ...services, repository }, undefined, hot);
    await store.activate(f.spec);
    assert.equal((await store.accept(f.value)).submissionId, f.value.submissionId);
    await store.flushOutbox(true);
    assert.equal(store.outboxStatus().failures, 1);
    assert.equal((await store.findSubmission(f.value.submissionId)).submissionId, f.value.submissionId);
    await store.flushOutbox(true);
    assert.equal(store.outboxStatus().count, 0);
    assert((await readProgressJournal(f.run)).some(event => Object.hasOwn(event.event.receipts ?? {}, f.spec.taskId)));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("invalid evidence is rejected without creating a receipt", async () => {
  const f = await fixture();
  try {
    const { store } = await productionStore(f);
    await store.activate(f.spec);
    await assert.rejects(store.accept({ ...f.value, audit: { ...f.value.audit, evidenceBank: ["ev_missing"] } }), /证据|evidence|提交/);
    assert.equal(await store.receipt(f.spec.taskId), undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
