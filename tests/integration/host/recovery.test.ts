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
} from "@eval/contracts";
import { createFileLogger, exists, readJson, runLock, writeJsonl } from "@eval/data";
import { readRunState, type Checkpoint } from "@eval/workflows/comparison";
import { services, prepare } from "../../fixtures/services.js";
import { reportRun } from "@eval/workflows/comparison";
import { buildPlan } from "@eval/workflows/comparison";
import { RunStore } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import {
  attributionResult,
  draftFor,
  emptyAudit,
  fakeIdentity,
  fixtureConfig,
  pairResult,
  raw,
  taskResult,
} from "../../fixtures/comparison.js";

async function fixture(rows = [raw("q", null)]) {
  const { directory, config } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config),
    task = plan.tasks[0];
  const run = path.join(directory, "run");
  const manifest: RunManifest = {
    format: "evaluation-run",
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
  const store = new RunStore(
      run,
      { manifest, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 },
      plan.inputs,
      services,
    ),
    prepared = prepare(task, plan.inputs, {});
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
    task.stage === "attribution" ? attributionResult(true, "2+2=4") : pairResult(),
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
    assert.deepEqual(Object.keys(JSON.parse(text)).slice(0, 2), ["evaluation_type", "task_id"]);
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
    await assert.rejects(store.accept({ ...value, evaluation: {} }));
    assert.equal(await readFile(file, "utf8"), "");
    await store.accept(value);
    await store.accept(value);
    const rows = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_id, "test");
    assert.equal(rows[0].stage, "attribution");
    assert.equal(rows[0].submission_id, value.submissionId);
    assert.deepEqual(
      rows[0].result,
      JSON.parse(await readFile(path.join(store.run, "results/attribution.jsonl"), "utf8")),
    );
    const restored = new RunStore(store.run, await readRunState(store.run), store.inputs, {
      ...services,
      logger,
    });
    await restored.save();
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 1);
    await rm(file);
    const replay = new RunStore(store.run, await readRunState(store.run), store.inputs, {
      ...services,
      logger: createFileLogger({
        directory: path.join(directory, "log"),
        lockDirectory: path.join(directory, "locks"),
      }),
    });
    await replay.save();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), rows[0]);
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
    assert.equal(validation.valid, true);
    assert.equal(validation.completed_comparisons, 0, "correctness rows are not comparisons");
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
