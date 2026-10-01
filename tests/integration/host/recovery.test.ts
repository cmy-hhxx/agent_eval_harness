import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_POLICY,
  emptyUsage,
  type AttemptSpec,
  type RunManifest,
  type Submission,
  type PlannedTask,
} from "@eval/contracts";
import { createFileLogger, exists, readJson, runLock, writeJsonl } from "@eval/data";
import { readRunState, writeRunState, createResultWriter, type Checkpoint } from "@eval/workflows/comparison";
import { services, prepare } from "../../fixtures/services.js";
import { reportRun } from "@eval/workflows/comparison";
import { buildPlan } from "@eval/workflows/comparison";
import { RunStore } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import {
  attributionResult,
  draftFor,
  emptyAudit,
  fakeEvaluatorVersion,
  fakeIdentity,
  comparisonResult,
  fixtureConfig,
  raw,
  taskResult,
  criteriaResult,
  fakeJudge,
} from "../../fixtures/comparison.js";

async function fixture(rows = [raw("q", null)]) {
  const { directory, config } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config),
    task = plan.tasks.find((task) => task.stage === "attribution")!;
  const run = path.join(directory, "run");
  const manifest: RunManifest = {
    format: "evaluation-run",
    debug: false,
    runId: "test",
    status: "running",
    engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion,
    config,
    tasks: plan.tasks,
    inputs: {},
    states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary,
    startedAt: Date.now(),
  };
  const criteriaReceipts = Object.fromEntries(plan.tasks.filter((item) => item.stage === "criteria").map((criteria) => {
    manifest.states[criteria.id].status = "succeeded";
    return [criteria.id, { taskId: criteria.id, attemptId: "criteria", submissionId: randomUUID(),
      evaluation: criteriaResult(), evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge,
      audit: emptyAudit(), usage: emptyUsage(), status: "succeeded" as const, acceptedAt: 0 }];
  }));
  const initial = { manifest, receipts: criteriaReceipts, usage: emptyUsage(), recordedAttempts: 0 };
  await createResultWriter(run, plan.inputs)(initial);
  await writeRunState(run, initial);
  const store = new RunStore(
      run,
      initial,
      plan.inputs,
      services,
    ),
    prepared = prepare(task, plan.inputs, { criteria: criteriaReceipts[task.dependencies.criteria] });
  const spec: AttemptSpec = {
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
  const evaluation = draftFor(
    spec,
    task.stage === "attribution" ? attributionResult(true, "2+2=4") : comparisonResult(),
  );
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
test("only the current active attempt retains its spec and accepted submissions stay idempotent", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    assert.deepEqual([...store.attempts.keys()], [spec.attemptId]);
    await store.endAttempt(spec, "failed", "retry required");
    assert.equal(store.attempts.size, 0, "ended attempts must release their prompt and recovery materials");
    const next = { ...spec, attemptId: "next" }, current = { ...spec, attemptId: "current" };
    await store.activate(next);
    await store.activate(current);
    assert.deepEqual([...store.attempts.keys()], [current.attemptId], "superseded attempts are not active");
    await assert.rejects(store.accept({ ...value, attemptId: next.attemptId }), /superseded/);
    const submission = { ...value, attemptId: current.attemptId };
    const receipt = await store.accept(submission);
    assert.equal(store.attempts.size, 0, "committed receipts no longer need an active attempt spec");
    assert.deepEqual(await store.accept(submission), receipt, "resends are verified from the receipt, not a retained spec");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("queued checkpoints share a pending write without retaining a snapshot per caller", async (t) => {
  const { directory, store } = await fixture();
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = services.repository.writeRun;
  const writes = t.mock.method(services.repository, "writeRun", async (...args: Parameters<typeof write>) => {
    enter();
    await blocked;
    return write(...args);
  });
  const clones = t.mock.method(globalThis, "structuredClone");
  const pending = [store.save()];
  try {
    await entered;
    for (let concurrency = 1; concurrency <= 32; concurrency++) {
      store.manifest.concurrency = concurrency;
      pending.push(store.save());
    }
    assert.equal(clones.mock.callCount(), 1, "blocked IO must not retain one full state copy per caller");
    release();
    await Promise.all(pending);
    assert.equal(writes.mock.callCount(), 2, "the pending checkpoint persists all queued changes together");
    assert.equal((await readRunState(store.run)).manifest.concurrency, 32);
  } finally {
    release();
    await Promise.allSettled(pending);
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoints isolate changing progress without duplicating immutable accepted bodies", async (t) => {
  const { directory, store, spec, value } = await fixture();
  await store.activate(spec);
  await store.accept(value);
  store.manifest.concurrency = 1;
  const receipt = store.state.receipts[spec.taskId]!;
  const write = services.repository.writeRun;
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(services.repository, "writeRun", async (...[run, snapshot]: Parameters<typeof write>) => {
    assert.notEqual(snapshot.receipts, store.state.receipts);
    assert.notEqual(snapshot.receipts[spec.taskId], receipt, "writer metadata must stay isolated");
    assert.equal(snapshot.receipts[spec.taskId]!.evaluation, receipt.evaluation, "accepted bodies need no extra heap copy");
    assert.equal(snapshot.receipts[spec.taskId]!.exported!.row, receipt.exported!.row);
    enter();
    await blocked;
    assert.equal(snapshot.manifest.concurrency, 1, "later progress edits cannot change an in-flight checkpoint");
    return write(run, snapshot);
  });
  const pending = store.save();
  try {
    await entered;
    store.manifest.concurrency = 2;
    release();
    await pending;
    const saved = await readRunState(store.run);
    assert.equal(saved.manifest.concurrency, 1);
    assert.deepEqual(saved.receipts[spec.taskId]!.evaluation, receipt.evaluation);
    assert.deepEqual(saved.receipts[spec.taskId]!.exported, receipt.exported);
  } finally {
    release();
    await pending.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt reads do not wait for unrelated checkpoint writes", async (t) => {
  const { directory, store, spec, value } = await fixture();
  await store.activate(spec);
  const accepted = await store.accept(value);
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = services.repository.writeRun;
  t.mock.method(services.repository, "writeRun", async (...args: Parameters<typeof write>) => {
    enter();
    await blocked;
    return write(...args);
  });
  const pending = store.save();
  try {
    await entered;
    const available = await Promise.race([
      Promise.all([store.receipt(spec.taskId), store.receipt(store.manifest.tasks.find((task) => task.stage === "attribution" && task.id !== spec.taskId)!.id)]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    assert.deepEqual(available, [accepted, undefined]);
  } finally {
    release();
    await pending;
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent task activations share a checkpoint instead of waiting for each other's disk writes", async (t) => {
  const { directory, store, spec } = await fixture([raw("one", null), raw("two", null)]);
  const tasks = store.manifest.tasks.filter((task) => task.stage === "attribution");
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const write = services.repository.writeRun;
  const writes = t.mock.method(services.repository, "writeRun", async (...args: Parameters<typeof write>) => {
    await blocked;
    return write(...args);
  });
  const pending = tasks.map((task, index) => store.activate({ ...spec, taskId: task.id, attemptId: `attempt-${index}` }));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tasks.filter((task) => store.manifest.states[task.id].status === "running").length, tasks.length);
    release();
    await Promise.all(pending);
    assert(writes.mock.callCount() <= 2, "independent activations must batch their durable checkpoint");
    const restored = await readRunState(store.run);
    assert(tasks.every((task) => restored.manifest.states[task.id].attempts === 1));
  } finally {
    release();
    await Promise.allSettled(pending);
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate submissions commit once and return the same receipt", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const results = await Promise.all([store.accept(value), store.accept(value), store.accept(value)]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.deepEqual(await store.findSubmission(value.submissionId), results[0]);
    assert.deepEqual(await readdir(store.run), ["results", "state.json"]);
    const file = path.join(store.run, "results/attribution.jsonl");
    const text = await readFile(file, "utf8");
    assert.equal(text.trim().split("\n").length, 1);
    assert.deepEqual(Object.keys(JSON.parse(text)).slice(0, 2), ["evaluation_type", "evaluator_version"]);
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.services);
    await restored.save();
    assert.equal(await readFile(file, "utf8"), text, "compact checkpoints preserve durable exports");
    assert.deepEqual(
      await restored.accept(value),
      results[0],
      "state references recover the exact committed receipt",
    );
    await rm(file);
    await assert.rejects(readRunState(store.run), /结果文件缺失/);
    const changed = {
      ...value,
      evaluation: { ...attributionResult(), unexpected: true },
    };
    await assert.rejects(store.accept(changed), /committed receipt/);
    await assert.rejects(
      store.accept({ ...value, usage: { ...value.usage, totalTokens: 5 } }),
      /committed receipt/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent tasks cannot reserve the same submission ID", async () => {
  const { directory, store, spec, value } = await fixture();
  const tasks = store.manifest.tasks.filter((task) => task.stage === "attribution");
  try {
    await Promise.all(tasks.map((task, index) => store.activate({ ...spec, taskId: task.id, attemptId: `attempt-${index}` })));
    const results = await Promise.allSettled(tasks.map((task, index) => store.accept({
      ...value, taskId: task.id, attemptId: `attempt-${index}`,
    })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(Object.keys((await readRunState(store.run)).receipts).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed follow-up commits roll back task changes and preserve a queued independent receipt", async () => {
  const setup = await fixture();
  const { directory, spec, value } = setup;
  const original = setup.store.manifest.tasks.find((task) => task.stage === "comparison")!;
  const other = setup.store.manifest.tasks.find((task) => task.stage === "attribution" && task.id !== spec.taskId)!;
  const added: PlannedTask = { ...original, id: randomUUID(), dependencies: { source: spec.taskId } };
  let enter = () => {}, release = () => {}, fail = true;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const store = new RunStore(setup.store.run, setup.store.state, setup.store.inputs, {
    ...services,
    repository: { ...services.repository, async writeRun(run, snapshot) {
      if (fail && snapshot.receipts[spec.taskId]) {
        enter();
        await blocked;
        fail = false;
        throw new Error("follow-up checkpoint unavailable");
      }
      await services.repository.writeRun(run, snapshot);
    } },
    taskSource: { ...services.taskSource, advance(task) {
      return task.id === spec.taskId ? { tasks: [added], blocked: [original.id],
        replace: [{ ...original, dependencies: { ...original.dependencies, A: added.id } }] } : { tasks: [] };
    } },
  });
  store.manifest.executionScope = [spec.taskId];
  const secondSpec = { ...spec, taskId: other.id, attemptId: "independent", inputs: Object.entries(other.inputIds).map(([name, id]) => ({ name, id })) };
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
  try {
    await store.activate(spec);
    await store.activate(secondSpec);
    first = store.accept(value);
    // Attach the rejection observer before releasing the deliberate IO failure.
    const firstOutcome = first.then(() => "accepted", (error: Error) => error.message);
    await entered;
    second = store.accept({ ...value, taskId: other.id, attemptId: secondSpec.attemptId, submissionId: randomUUID() });
    release();
    assert.equal(await firstOutcome, "follow-up checkpoint unavailable");
    const accepted = await second;
    assert.equal(store.state.receipts[spec.taskId], undefined);
    assert.equal(store.manifest.states[spec.taskId].status, "running");
    assert.equal(store.manifest.states[original.id].status, "pending");
    assert.deepEqual(store.manifest.tasks.find((task) => task.id === original.id), original);
    assert.equal(store.manifest.tasks.some((task) => task.id === added.id), false);
    assert.equal(store.manifest.states[added.id], undefined);
    assert.deepEqual(store.manifest.executionScope, [spec.taskId]);
    assert.deepEqual(store.state.receipts[other.id], accepted);
    const restored = await readRunState(store.run);
    assert.deepEqual(restored.receipts[other.id], accepted);
    assert.equal(restored.receipts[spec.taskId], undefined);
    assert.equal(restored.manifest.tasks.some((task) => task.id === added.id), false);
  } finally {
    release();
    await Promise.allSettled([first, second]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("business logs contain durable accepted rows once, recover omissions and ignore rejected submissions", async () => {
  const fixtureValue = await fixture();
  const { directory, spec, value } = fixtureValue;
  const logger = createFileLogger({
    directory: path.join(directory, "log"),
    lockDirectory: path.join(directory, "locks"),
  });
  const store = new RunStore(fixtureValue.store.run, fixtureValue.store.state, fixtureValue.store.inputs, {
    ...services,
    logger,
  });
  const file = path.join(directory, "log/evaluation.log");
  try {
    await logger.initialize();
    await store.activate(spec);
    const baseline = await readFile(file, "utf8");
    await assert.rejects(store.accept({ ...value, evaluation: {} }));
    assert.equal(await readFile(file, "utf8"), baseline);
    await store.accept(value);
    await store.accept(value);
    const rows = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    const attribution = rows.find((row) => row.stage === "attribution")!;
    assert.equal(attribution.run_id, "test");
    assert.equal(attribution.submission_id, value.submissionId);
    assert.deepEqual(
      attribution.result,
      JSON.parse(await readFile(path.join(store.run, "results/attribution.jsonl"), "utf8")),
    );
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, {
      ...services,
      logger,
    });
    await restored.save();
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2);
    await rm(file);
    const replay = new RunStore(store.run, await readRunState(store.run), store.inputs, {
      ...services,
      logger: createFileLogger({
        directory: path.join(directory, "log"),
        lockDirectory: path.join(directory, "locks"),
      }),
    });
    await replay.save();
    assert.deepEqual((await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line)), rows);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("correctness receipts are durable references and preserve exact duplicate checks after recovery", async () => {
  const { directory, store, spec, value } = await fixture([raw("q", "4")]);
  try {
    await store.activate(spec);
    await store.checkpoint(spec.taskId, {
      draft: value.evaluation,
      errors: [],
      contentSubmissions: 3,
      fileErrors: 1,
      repeatedErrors: 2,
      stopped: false,
      attemptId: spec.attemptId,
    });
    value.submissionStats = { contentSubmissions: 3, fileErrors: 1 };
    const accepted = await store.accept(value);
    const file = path.join(store.run, "results/attribution.jsonl"),
      text = await readFile(file, "utf8");
    const row = JSON.parse(text);
    assert.equal(row.task_id, spec.taskId);
    assert.equal(row.submission_id, value.submissionId);
    assert.deepEqual(row.evaluation, accepted.evaluation);
    const checkpoint = await readJson<Checkpoint>(path.join(store.run, "state.json"));
    const saved = checkpoint.tasks[spec.taskId];
    assert(saved.receipt);
    assert.equal(saved.receipt.evaluation, undefined);
    assert.equal(saved.receipt.evaluationPatch, undefined);
    assert.deepEqual(saved.receipt.exported, {
      taskId: spec.taskId,
      file: "attribution.jsonl",
    });
    assert.equal(saved.receipt.evaluatorVersion, fakeEvaluatorVersion);
    assert.equal(saved.receipt.judge, "mock");
    assert(!JSON.stringify(saved.receipt).includes(spec.model.baseUrl), "endpoint configuration stays out of state");
    assert.equal(saved.failure, undefined);
    assert.equal(saved.repeatedErrors, 2);
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.services);
    assert.deepEqual(await restored.accept(value), accepted);
    const dependent = {
      ...store.manifest.tasks.find((t) => t.stage === "comparison")!,
      dependencies: { A: spec.taskId },
    };
    assert.deepEqual((await restored.dependencies(dependent)).A.evaluation, accepted.evaluation);
    for (const change of [
      {
        evaluation: {
          ...(value.evaluation as object),
          correctness_reason: "different",
        },
      },
      { usage: { ...value.usage, totalTokens: 1 } },
      { audit: { ...value.audit, calls: 1 } },
      { submissionStats: { contentSubmissions: 4, fileErrors: 1 } },
    ])
      await assert.rejects(restored.accept({ ...value, ...change }), /committed receipt/);
    await appendFile(file, text + '{"task_id":"unfinished');
    const recovered = new RunStore(store.run, await readRunState(store.run), store.inputs, store.services);
    await recovered.save();
    assert.equal(await readFile(file, "utf8"), text);
    const summary = await reportRun(store.run);
    assert.equal((summary.quality as { repeated_error_tasks: number }).repeated_error_tasks, 1);
    assert.equal(await readFile(file, "utf8"), text, "report rebuild retains formal correctness evidence");
    const validation = await validateRun(store.run);
    assert.equal(validation.results.valid, true);
    assert.equal(validation.evidence.valid, true);
    assert.equal(validation.delivery.valid, false, "accepted attribution alone is not a completed comparison delivery");
    assert.equal(validation.completed_comparisons, 0, "correctness rows are not comparisons");
    await writeJsonl(file, [{ ...row, evaluator_version: "wrong" }]);
    await assert.rejects(readRunState(store.run), /结果评测器版本与收据不一致/);
    await writeJsonl(file, [row]);
    await appendFile(
      file,
      JSON.stringify({
        ...row,
        evaluation: { ...row.evaluation, is_correct: false },
      }) + "\n",
    );
    await assert.rejects(readRunState(store.run), /冲突结果/);
    await writeJsonl(file, [{ ...row, input_id: "wrong-input" }]);
    await assert.rejects(readRunState(store.run), /身份不一致/);
    await rm(file);
    await assert.rejects(readRunState(store.run), /结果文件缺失/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const window of ["append", "compaction"] as const)
  test(`correctness recovers a failure during ${window}`, async () => {
    const { directory, store, spec, value } = await fixture([raw("q", "4")]);
    try {
      await store.activate(spec);
      const file = path.join(store.run, "results/attribution.jsonl");
      if (window === "append") {
        await mkdir(file);
        await assert.rejects(store.accept(value));
        await assert.rejects(store.findSubmission(value.submissionId), /not accepted/);
        await rm(file, { recursive: true });
      } else {
        const custom = {
          ...store.services,
          repository: {
            ...store.services.repository,
            async writeRun(run: string, state: Parameters<typeof store.services.repository.writeRun>[1]) {
              if (state.receipts[spec.taskId]?.exported) throw new Error("compaction interrupted");
              await store.services.repository.writeRun(run, state);
            },
          },
        };
        const failing = new RunStore(store.run, store.state, store.inputs, custom);
        await failing.activate(spec);
        assert.equal((await failing.accept(value)).submissionId, value.submissionId);
      }
      const saved = await readRunState(store.run);
      assert.equal(
        saved.receipts[spec.taskId].exported,
        undefined,
        "full checkpoint remains until compaction succeeds",
      );
      assert.deepEqual(saved.receipts[spec.taskId].submitted, value.evaluation);
      const recovered = new RunStore(store.run, saved, store.inputs, store.services);
      await recovered.save();
      assert.equal((await recovered.accept(value)).submissionId, value.submissionId);
      assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
      assert.equal((await readRunState(store.run)).receipts[spec.taskId].exported?.id, spec.taskId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("successful submissions append immediately without replacing earlier lines", async () => {
  const { directory, store, spec, value } = await fixture([
    raw("q1", null),
    raw("q2", null),
    raw("q3", null),
  ]);
  try {
    const submissions = store.manifest.tasks
      .filter((task) => task.stage === "attribution")
      .map((task, i) => {
      const attemptId = `attempt-${i}`;
      const prepared = prepare(task, store.inputs, {});
      const taskSpec = {
        ...spec,
        ...prepared,
        inputs: Object.entries(task.inputIds).map(([name, id]) => ({
          name,
          id,
        })),
      };
      return {
        ...value,
        evaluation: draftFor(taskSpec, taskResult(taskSpec)),
        taskId: task.id,
        attemptId,
        submissionId: randomUUID(),
      };
    });
    for (const submission of submissions)
      await store.activate({
        ...spec,
        taskId: submission.taskId,
        attemptId: submission.attemptId,
      });
    const file = path.join(store.run, "results/attribution.jsonl");
    assert.equal(await exists(file), false);
    await store.accept(submissions[0]);
    const first = await readFile(file, "utf8"),
      inode = (await stat(file)).ino;
    assert.equal(store.manifest.status, "running");
    await Promise.all([
      store.accept(submissions[1]),
      store.accept(submissions[2]),
      store.accept(submissions[1]),
    ]);
    const text = await readFile(file, "utf8"),
      rows = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.equal((await stat(file)).ino, inode, "live output must append to the same file");
    assert(text.startsWith(first));
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.task_id)).size, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("an export failure withholds acknowledgement but the saved receipt can recover", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    const file = path.join(store.run, "results/attribution.jsonl");
    await mkdir(file);
    await assert.rejects(store.accept(value));
    await assert.rejects(store.findSubmission(value.submissionId), /not accepted/);
    const saved = await readRunState(store.run);
    assert.equal(saved.receipts[spec.taskId].submissionId, value.submissionId);
    await rm(file, { recursive: true });
    const restored = new RunStore(store.run, saved, store.inputs, store.services);
    await restored.save();
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
    assert.equal((await restored.accept(value)).submissionId, value.submissionId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("recovery removes duplicate and partial trailing rows without losing committed results", async () => {
  const { directory, store, spec, value } = await fixture();
  try {
    await store.activate(spec);
    await store.accept(value);
    await reportRun(store.run);
    const file = path.join(store.run, "results/attribution.jsonl");
    const text = await readFile(file, "utf8");
    await appendFile(file, text + '{"request_time":"unfinished');
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, store.services);
    await restored.save();
    assert.equal(await readFile(file, "utf8"), text);
    assert.equal((await restored.accept(value)).submissionId, value.submissionId);
    assert.equal(await readFile(file, "utf8"), text);
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
    const second = {
      ...value,
      attemptId: "second",
      submissionId: randomUUID(),
    };
    store.manifest.states[spec.taskId].status = "cancelled";
    await assert.rejects(store.accept(second), /cancelled/);
    await store.activate({
      ...spec,
      attemptId: "third",
      deadline: Date.now() - 1,
    });
    await assert.rejects(
      store.accept({
        ...value,
        attemptId: "third",
        submissionId: randomUUID(),
      }),
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
    const invalid = taskResult(spec) as {
      findings?: { evidence: { quote: string }[] }[];
      evaluations?: { A: { findings: { evidence: { quote: string }[] }[] } };
    };
    const findings = invalid.findings ?? invalid.evaluations!.A.findings;
    findings[0].evidence[0].quote = "invented";
    await assert.rejects(
      store.accept({
        ...value,
        evaluation: draftFor(spec, invalid),
        submissionId: randomUUID(),
      }),
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
