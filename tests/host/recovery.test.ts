import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_POLICY,
  PROTOCOL_VERSION,
  emptyUsage,
  type AttemptSpec,
  type RunManifest,
  type Submission,
} from "../../packages/contracts/src/index.js";
import { exists, runLock } from "../../packages/contracts/src/io.js";
import { readRunState } from "../../packages/pairwise-eval/src/run-data.js";
import { pairwisePack } from "../../packages/pairwise-eval/src/index.js";
import { reportRun } from "../../packages/pairwise-eval/src/report.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { RunStore } from "../../apps/host/src/store.js";
import { draftFor, emptyAudit, fakeIdentity, fixtureConfig, pairResult, raw } from "./fixtures.js";

async function fixture(rows = [raw("q", null)]) {
  const { directory, config } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config),
    task = plan.tasks[0];
  const run = path.join(directory, "run");
  const manifest: RunManifest = {
    format: "dual-agent-eval/6",
    debug: false,
    runId: "test",
    status: "running",
    engine: fakeIdentity,
    config,
    tasks: plan.tasks,
    inputs: {},
    states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary,
    startedAt: Date.now(),
  };
  const store = new RunStore(run, { manifest, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 }, plan.inputs, pairwisePack),
    prepared = pairwisePack.prepare(task, plan.inputs, {});
  const spec: AttemptSpec = {
    protocolVersion: PROTOCOL_VERSION,
    inputRevision: 1,
    runId: "test",
    taskId: task.id,
    attemptId: "first",
    engine: fakeIdentity,
    evaluation: prepared.evaluation,
    model: {
      provider: "mock",
      baseUrl: "http://127.0.0.1",
      api: "openai-completions",
      apiKeyEnv: "MOCK_KEY",
      model: "mock",
      thinking: "off",
      contextWindow: 10000,
      maxOutputTokens: 1000,
    },
    policy: DEFAULT_POLICY,
    prompt: prepared.prompt,
    inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })),
    hostUrl: "http://127.0.0.1",
    deadline: Date.now() + 60000,
  };
  const evaluation = draftFor(spec, pairResult());
  const value: Submission = {
    taskId: task.id,
    attemptId: spec.attemptId,
    submissionId: randomUUID(),
    evaluation,
    audit: emptyAudit(),
    usage: emptyUsage(),
  };
  return { directory, store, spec, value };
}
test("duplicate submissions commit once and return the same receipt", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const results = await Promise.all([store.accept(value), store.accept(value), store.accept(value)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.deepEqual(await store.findSubmission(value.submissionId), results[0]);
    assert.deepEqual(await readdir(store.run), ["results", "state.json"]);
    const file = path.join(store.run, "results/a_fast__vs__aa_fast.jsonl");
    const text = await readFile(file, "utf8");
    assert.equal(text.trim().split("\n").length, 1);
    assert.deepEqual(Object.keys(JSON.parse(text)).slice(0, 2), ["request_time", "has_standard_answer"]);
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.pack);
    await restored.save();
    assert.equal(await readFile(file, "utf8"), text, "compact checkpoints preserve durable exports");
    assert.deepEqual(await restored.accept(value), results[0], "state references recover the exact committed receipt");
    await rm(file);
    await assert.rejects(readRunState(store.run), /结果文件缺失/);
    const changed = { ...value, evaluation: { ...pairResult(), unexpected: true } };
    await assert.rejects(store.accept(changed), /committed receipt/);
    await assert.rejects(store.accept({ ...value, usage: { ...value.usage, totalTokens: 5 } }), /committed receipt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("successful submissions append immediately without replacing earlier lines", async () => {
  const { directory, store, spec, value } = await fixture([raw("q1", null), raw("q2", null), raw("q3", null)]);
  try {
    const submissions = store.manifest.tasks.map((task, i) => {
      const attemptId = `attempt-${i}`;
      const prepared = pairwisePack.prepare(task, store.inputs, {});
      const taskSpec = { ...spec, ...prepared, inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })) };
      return { ...value, evaluation: draftFor(taskSpec, pairResult()), taskId: task.id, attemptId, submissionId: randomUUID() };
    });
    for (const submission of submissions)
      await store.activate({ ...spec, taskId: submission.taskId, attemptId: submission.attemptId });
    const file = path.join(store.run, "results/a_fast__vs__aa_fast.jsonl");
    assert.equal(await exists(file), false);
    await store.accept(submissions[0]);
    const first = await readFile(file, "utf8"), inode = (await stat(file)).ino;
    assert.equal(store.manifest.status, "running");
    await Promise.all([store.accept(submissions[1]), store.accept(submissions[2]), store.accept(submissions[1])]);
    const text = await readFile(file, "utf8"), rows = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal((await stat(file)).ino, inode, "live output must append to the same file");
    assert(text.startsWith(first));
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.comparison_id)).size, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("an export failure withholds acknowledgement but the saved receipt can recover", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const file = path.join(store.run, "results/a_fast__vs__aa_fast.jsonl");
    await mkdir(file);
    await assert.rejects(store.accept(value));
    await assert.rejects(store.findSubmission(value.submissionId), /not accepted/);
    const saved = await readRunState(store.run);
    assert.equal(saved.receipts[spec.taskId].submissionId, value.submissionId);
    await rm(file, { recursive: true });
    const restored = new RunStore(store.run, saved, store.inputs, store.pack);
    await restored.save();
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
    assert.equal((await restored.accept(value)).submissionId, value.submissionId);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("not-comparable submissions stream only to their separate result file", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const evaluation = pairResult();
    evaluation.verdict.result = "not_comparable";
    await store.accept({ ...value, evaluation: draftFor(spec, evaluation), submissionId: randomUUID() });
    const file = path.join(store.run, "results/not_comparable.jsonl");
    assert.equal(JSON.parse(await readFile(file, "utf8")).verdict.result, "not_comparable");
    assert.equal(await exists(path.join(store.run, "results/a_fast__vs__aa_fast.jsonl")), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("recovery removes duplicate and partial trailing rows without losing committed results", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    await store.accept(value);
    await reportRun(store.run);
    const file = path.join(store.run, "results/a_fast__vs__aa_fast.jsonl");
    const text = await readFile(file, "utf8");
    await appendFile(file, text + '{"request_time":"unfinished');
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.pack);
    await restored.save();
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal((await restored.accept(value)).submissionId, value.submissionId);
    assert.equal(await readFile(file, "utf8"), text);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("a failed state write cannot acknowledge or expose an uncommitted receipt", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const file = path.join(store.run, "state.json");
    await rm(file);
    await mkdir(file);
    await assert.rejects(store.accept(value));
    assert.equal(await store.receipt(spec.taskId), undefined);
    await assert.rejects(store.findSubmission(value.submissionId), /not accepted/);
    await rm(file, { recursive: true });
    const receipt = await store.accept(value);
    assert.deepEqual((await readRunState(store.run)).receipts[spec.taskId], receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("superseded, cancelled and expired attempts cannot commit", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    await store.activate({ ...spec, attemptId: "second" });
    await assert.rejects(store.accept(value), /superseded/);
    const second = { ...value, attemptId: "second", submissionId: randomUUID() };
    store.manifest.states[spec.taskId].status = "cancelled";
    await assert.rejects(store.accept(second), /cancelled/);
    await store.activate({ ...spec, attemptId: "third", deadline: Date.now() - 1 });
    await assert.rejects(
      store.accept({ ...value, attemptId: "third", submissionId: randomUUID() }),
      /expired/,
    );
    store.manifest.states[spec.taskId].revision = 2;
    await assert.rejects(store.activate(spec), /revision superseded/);
    await assert.rejects(store.accept(value), /superseded/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("invalid evidence is rejected without producing a formal receipt", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const invalid = pairResult();
    invalid.evaluations.A.findings[0].evidence[0].quote = "invented";
    await assert.rejects(
      store.accept({ ...value, evaluation: draftFor(spec, invalid), submissionId: randomUUID() }),
      /原文|证据/,
    );
    assert.equal(await store.receipt(spec.taskId), undefined);
    assert.equal(store.manifest.states[spec.taskId].status, "running");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("run lock excludes a second host and is released by its owner", async () => {
  const { directory } = await fixtureConfig();
  try {
    const release = await runLock(directory);
    await assert.rejects(runLock(directory), /owned/);
    await release();
    await (await runLock(directory))();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
