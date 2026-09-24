import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_POLICY,
  PROTOCOL_VERSION,
  emptyUsage,
  type AttemptSpec,
  type RunManifest,
  type Submission,
} from "../../packages/contracts/src/index.js";
import { digest, runLock } from "../../packages/contracts/src/io.js";
import { readRunState } from "../../packages/pairwise-eval/src/run-data.js";
import { pairwisePack } from "../../packages/pairwise-eval/src/index.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { RunStore } from "../../apps/host/src/store.js";
import { emptyAudit, fakeIdentity, fixtureConfig, pairResult, raw } from "./fixtures.js";

async function fixture() {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const plan = await buildPlan(config),
    task = plan.tasks[0];
  const run = path.join(directory, "run");
  const manifest: RunManifest = {
    format: "dual-agent-eval/4",
    debug: false,
    runId: "test",
    status: "running",
    fingerprint: "test",
    engine: fakeIdentity,
    config,
    tasks: plan.tasks,
    inputs: {},
    states: { [task.id]: { status: "pending", attempts: 0 } },
    preflight: plan.summary,
    startedAt: Date.now(),
  };
  const store = new RunStore(run, { manifest, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 }, plan.inputs, pairwisePack),
    prepared = pairwisePack.prepare(task, plan.inputs, {});
  const spec: AttemptSpec = {
    protocolVersion: PROTOCOL_VERSION,
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
    inputs: [],
    hostUrl: "http://127.0.0.1",
    deadline: Date.now() + 60000,
  };
  const evaluation = pairResult();
  const value: Submission = {
    taskId: task.id,
    attemptId: spec.attemptId,
    submissionId: digest([spec.attemptId, evaluation]),
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
    assert.deepEqual(await readdir(store.run), ["state.json"]);
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.pack);
    assert.deepEqual(await restored.accept(value), results[0], "state.json alone recovers the committed receipt");
    const changed = { ...value, evaluation: { ...pairResult(), unexpected: true } };
    await assert.rejects(store.accept(changed), /Invalid submission/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    const second = { ...value, attemptId: "second", submissionId: digest(["second", value.evaluation]) };
    store.manifest.states[spec.taskId].status = "cancelled";
    await assert.rejects(store.accept(second), /cancelled/);
    await store.activate({ ...spec, attemptId: "third", deadline: Date.now() - 1 });
    await assert.rejects(
      store.accept({ ...value, attemptId: "third", submissionId: digest(["third", value.evaluation]) }),
      /expired/,
    );
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
      store.accept({ ...value, evaluation: invalid, submissionId: digest([spec.attemptId, invalid]) }),
      /原文/,
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
