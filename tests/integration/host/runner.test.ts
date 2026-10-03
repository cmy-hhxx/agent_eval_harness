import { draftFor, invalidResult, taskResult } from "../../fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, AttemptRecord, JsonObject } from "@eval/contracts";
import { createFileLogger, exists, internalPath, readJson, readJsonl, writeJsonl } from "@eval/data";
import { loadRunInputs, readRunState, writeRunState } from "@eval/workflows/comparison";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { reportRun } from "@eval/workflows/comparison";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import type { TaskData } from "@eval/workflows/comparison";

test("two workers execute dependency graph, archive receipts and reuse only same-run results", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [raw()], [raw()], [raw()]]);
  config.comparisons = [
    ["a_fast", "b_fast"],
    ["a_expert", "b_expert"],
  ];
  const plan = await buildPlan(config);
  let calls = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          options.onEvent({
            type: "message_end",
            message: {
              role: "assistant",
              usage: {
                input: 10,
                output: 5,
                cacheRead: 30,
                cacheWrite: 10,
                totalTokens: 55,
              },
            },
          });
          const submitted = await options.execute(
            "submit_evaluation",
            draftFor(options.spec, taskResult(options.spec)),
          );
          assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          assert.equal(submitted.terminate, true);
          if ("decision_basis" in (options.spec.evaluation.outputSchema.properties as object)) {
            const file = path.join(
              config.output.path,
              options.spec.runId,
              "results",
              "comparison.jsonl",
            );
            const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
            const data = plan.tasks.find((task) => task.id === options.spec.taskId)!.data as TaskData;
            assert(rows.some((row) => row.comparison_id === data.comparisonId),
              "this result is durable before the worker receives a successful submission response");
          }
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all([
    startWorker(backend, path.join(directory, "w1")),
    startWorker(backend, path.join(directory, "w2")),
  ]);
  try {
    const options = {
      runId: "first",
      debug: true,
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      logger: createFileLogger({
        directory: path.join(directory, "log"),
        lockDirectory: path.join(directory, "locks"),
      }),
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    };
    await assert.rejects(runEvaluation({ ...options, evaluatorVersion: " " }), /evaluatorVersion/);
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 2);
    assert.equal(calls, 7);
    const businessLog = path.join(directory, "log/evaluation.log");
    const logged = (await readFile(businessLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(logged.length, 7);
    assert.equal(logged.filter((row) => row.stage === "criteria").length, 1);
    assert.equal(logged.filter((row) => row.stage === "attribution").length, 4);
    assert.equal(logged.filter((row) => row.stage === "comparison").length, 2);
    assert.equal(await readFile(path.join(directory, "log/runtime.log"), "utf8"), "");
    assert.deepEqual(summary.tokens, {
      input: 70,
      output: 35,
      cacheRead: 210,
      cacheWrite: 70,
      totalTokens: 385,
    });
    assert.deepEqual(summary.cache, {
      model_input: { hit_rate: 0.6 },
    });
    assert.deepEqual(summary.evaluator_versions, [fakeEvaluatorVersion]);
    assert.deepEqual(summary.judge_models, { criteria: ["fixture"], attribution: ["fixture"], comparison: ["fixture"] });
    const run = path.join(config.output.path, "first");
    assert.deepEqual(await readJson(path.join(run, "stats.json")), summary);
    const checkpoint = await readJson(path.join(run, "state.json"));
    assert.equal(checkpoint.manifest, undefined);
    assert.equal(checkpoint.receipts, undefined);
    for (const task of plan.tasks) {
      const stored = (checkpoint.tasks as Record<string, { receipt: Record<string, unknown> }>)[task.id]
        .receipt;
      assert(stored.exported);
      assert.equal(stored.evaluation, undefined, "formal verdicts are referenced, not copied into state");
      assert.equal(stored.judge, "fixture");
      assert.equal(stored.evaluatorVersion, fakeEvaluatorVersion);
    }
    assert(!JSON.stringify(summary).includes("case_ids"));
    assert.equal(summary.statistical_diagnostics, undefined, "consistent pair sources produce no conflict payload");
    assert(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 8000, "five-stage aggregate metrics stay compact without answer bodies");
    assert.deepEqual((await readdir(run)).sort(), [
      "_internal",
      "report.md",
      "results",
      "state.json",
      "stats.json",
      "task_summaries.md",
    ]);
    assert.equal(await exists(internalPath(run, "exports")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "attribution.jsonl")), false);
    assert.equal(
      (await readFile(path.join(run, "results", "attribution.jsonl"), "utf8")).trim().split("\n").length,
      4,
    );
    assert.deepEqual(await loadRunInputs((await readRunState(run)).manifest), plan.inputs);
    assert.equal(await exists(path.join(run, "inputs")), false);
    assert.equal(await exists(path.join(run, "preflight.json")), false);
    for (const task of plan.tasks) {
      const attempt = path.join(run, "_internal", "tasks", task.id, "attempt-001");
      assert.deepEqual((await readdir(attempt)).sort(), ["attempt.json", "events.jsonl.gz"]);
      const events = [];
      for await (const event of readJsonl(path.join(attempt, "events.jsonl.gz"))) events.push(event);
      assert.equal((events.at(-1) as { type: string }).type, "finished");
      assert.equal(await exists(path.join(attempt, "events.jsonl")), false);
    }
    assert.deepEqual(await readdir(path.join(directory, "w1")), []);
    assert.deepEqual(await readdir(path.join(directory, "w2")), []);
    assert.equal((await validateRun(run)).valid, true, "evidence reads the original source files");
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：通过/);
    await reportRun(run, { details: true });
    assert.equal(await exists(internalPath(run, "exports", "task_summaries.jsonl")), true);
    const summaries: JsonObject[] = [];
    for await (const row of readJsonl(internalPath(run, "exports", "task_summaries.jsonl"))) summaries.push(row as JsonObject);
    assert.equal(summaries.length, 2);
    assert(summaries.every((row) => row.evaluator_version === fakeEvaluatorVersion));
    assert.equal(await exists(internalPath(run, "exports", "task_outcomes.jsonl")), true);
    const comparisonFile = path.join(run, "results", "comparison.jsonl");
    const comparisonRows: JsonObject[] = [];
    for await (const row of readJsonl(comparisonFile)) comparisonRows.push(row as JsonObject);
    await writeJsonl(comparisonFile, [
      { ...comparisonRows[0], evaluator_version: "wrong" }, ...comparisonRows.slice(1),
    ]);
    await assert.rejects(readRunState(run), /结果评测器版本与收据不一致/);
    await writeJsonl(comparisonFile, comparisonRows);
    assert.equal((await readJson(path.join(run, "stats.json"))).validation, undefined);
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：尚未校验/);
    await runEvaluation(options);
    assert.equal(calls, 7, "same-run resume repeats none of the accepted five-stage tasks");
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 7);
    const cached = await runEvaluation({ ...options, runId: "second" });
    assert.equal(calls, 14, "a new run must evaluate independently");
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 14);
    assert.deepEqual(cached.cache, {
      model_input: { hit_rate: 0.6 },
    });
    assert.equal((cached.tokens as { totalTokens: number }).totalTokens, 385);
    assert.equal((await validateRun(path.join(config.output.path, "second"))).valid, true);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("different runs and batches evaluate independently", async () => {
  const days = ["2026-09-23", "2026-09-24"];
  const rows = days.map((batch_id) => ({ ...raw("q1", null), batch_id }));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  let calls = 0;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            calls++;
            const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
            assert.equal(result.isError, undefined);
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = {
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      policy: config.execution,
      modelForStage,
      concurrency: 1,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    for (const [index, day] of days.entries()) {
      config.inputs.batches = [day];
      const stats = await runEvaluation({
        ...options,
        runId: day,
        plan: await buildPlan(config),
      });
      assert.equal(stats.completed_comparisons, 1);
      assert.equal(calls, (index + 1) * 4, "another batch must invoke the evaluator even for the same question");
    }
    config.inputs.batches = days;
    const combined = await runEvaluation({
      ...options,
      runId: "combined",
      plan: await buildPlan(config),
    });
    assert.equal(calls, 16);
    assert.equal(combined.completed_comparisons, 2);
    assert.deepEqual(Object.keys(combined.by_batch as object), days);
    assert.equal((await validateRun(path.join(config.output.path, "combined"))).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const missingArtifact of [false, true])
  test(`failed attempt archives diagnostics and releases only complete copies (missing artifact: ${missingArtifact})`, async () => {
    const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
    const backend: AgentBackend = {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            if (options.spec.evaluation.id === "criteria") {
              const submitted = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
              assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
              return;
            }
            options.onEvent({
              type: "message_end",
              message: {
                role: "assistant",
                usage: { input: 6, output: 4, cacheRead: 9, totalTokens: 19 },
              },
            });
            await options.execute("execute_code", {
              language: "python",
              code: "print('failed attempt evidence')",
            });
            if (missingArtifact) {
              const artifacts = path.join(directory, "worker", options.spec.attemptId, "artifacts");
              await rm(path.join(artifacts, (await readdir(artifacts))[0]));
            }
            const invalid = invalidResult(options.spec) as any;
            invalid.findings[0].evidence[0].quote = "invented";
            assert.equal(
              (await options.execute("submit_evaluation", draftFor(options.spec, invalid))).isError,
              true,
            );
            throw new Error("Agent ended without an accepted submission", {
              cause: new Error("Original worker failure with diagnostic detail"),
            });
          },
          async abort() {},
          async dispose() {},
        };
      },
    };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    try {
      const plan = await buildPlan(config);
      const summary = await runEvaluation({
        runId: "failure",
        debug: true,
        output: config.output,
        engine: "pi",
        identity: fakeIdentity,
        evaluatorVersion: fakeEvaluatorVersion,
        config,
        ...services,
        logger: createFileLogger({
          directory: path.join(directory, "log"),
          lockDirectory: path.join(directory, "locks"),
        }),
        plan,
        policy: config.execution,
        modelForStage,
        concurrency: 1,
        retries: 0,
        retryDelaySeconds: 0,
        workerUrls: [worker.url],
      });
      assert.equal(summary.completed_comparisons, 0);
      assert.deepEqual(summary.task_statuses, { succeeded: 1, failed: 2, blocked: 1 });
      const runtimeLog = (await readFile(path.join(directory, "log/runtime.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failures = runtimeLog.filter((row) => row.event === "attempt_failed");
      assert.equal(failures.length, 4, "both attempts of both tasks are retained");
      const attributionTasks = plan.tasks.filter((task) => task.stage === "attribution");
      assert.deepEqual([...new Set(failures.map((row) => row.task_id))].sort(), attributionTasks.map((task) => task.id).sort());
      assert.equal(new Set(failures.map((row) => row.attempt_id)).size, 4);
      assert(failures.every((row) => row.errors.length > 0));
      assert(failures.every((row) => row.detail.includes("Original worker failure with diagnostic detail")));
      assert(failures.every((row) => row.detail.includes("at Object.run")));
      const accepted = (await readFile(path.join(directory, "log/evaluation.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(accepted.map((row) => row.stage), ["criteria"], "failed attributions must not produce accepted business results");
      assert.equal((summary.tokens as { totalTokens: number }).totalTokens, 76);
      const run = path.join(config.output.path, "failure");
      assert.equal(await exists(internalPath(run, "diagnostics", "attribution.jsonl")), false);
      assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), true);
      const record = await readJson<AttemptRecord>(
        internalPath(run, "tasks", attributionTasks[0]!.id, "attempt-001/attempt.json"),
      );
      assert.equal(record.status?.state, "failed");
      assert.match(record.error!, /without an accepted submission/);
      assert(record.pendingSubmission);
      assert(record.metrics!.audit.artifacts.length > 0);
      if (missingArtifact) {
        assert.match(record.artifactError!, /Artifact unavailable/);
        assert.equal((await readdir(path.join(directory, "worker"))).length, 4);
      } else {
        for (const artifact of record.metrics!.audit.artifacts)
          assert.equal(
            (await readFile(internalPath(run, "tasks", attributionTasks[0]!.id, "artifacts", artifact.id)))
              .byteLength,
            artifact.bytes,
          );
        assert.deepEqual(await readdir(path.join(directory, "worker")), []);
      }
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
test("one host routes tasks to both engines without sharing sessions or workspaces", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  config.comparisons = [
    ["a_fast", "b_fast"],
    ["a_expert", "b_expert"],
  ];
  const calls = { pi: 0, prime: 0 },
    workdirs = new Set<string>();
  const primeIdentity = { ...fakeIdentity, engine: "prime" as const };
  const backend = (engine: "pi" | "prime"): AgentBackend => ({
    identity: engine === "pi" ? fakeIdentity : primeIdentity,
    async createSession(options) {
      assert.equal(options.spec.engine.engine, engine);
      assert(!workdirs.has(options.workdir));
      workdirs.add(options.workdir);
      return {
        async run() {
          calls[engine]++;
          await options.execute(
            "submit_evaluation",
            draftFor(options.spec, taskResult(options.spec)),
          );
        },
        async abort() {},
        async dispose() {},
      };
    },
  });
  const workers = await Promise.all([
    startWorker(backend("pi"), path.join(directory, "pi")),
    startWorker(backend("prime"), path.join(directory, "prime")),
  ]);
  try {
    const summary = await runEvaluation({
      runId: "mixed",
      output: config.output,
      engine: "pi",
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      identities: { prime: primeIdentity },
      engineForTask: (task) =>
        Object.values((task.data as TaskData).candidates).some((c) => c.version.includes("expert"))
          ? "prime"
          : "pi",
      config,
      ...services,
      plan: await buildPlan(config),
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    });
    assert.equal(summary.completed_comparisons, 2);
    assert.deepEqual(calls, { pi: 3, prime: 4 });
    assert.equal(workdirs.size, 7);
    const run = path.join(config.output.path, "mixed");
    assert.deepEqual((await readdir(run)).sort(), [
      "report.md",
      "results",
      "state.json",
      "stats.json",
      "task_summaries.md",
    ]);
    assert.doesNotMatch(await readFile(path.join(run, "report.md"), "utf8"), /_internal/);
    assert.equal((await validateRun(run)).valid, true);
    await reportRun(run);
    await assert.rejects(reportRun(run, { details: true }), /--debug/);
    assert.equal(await exists(internalPath(run)), false);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("stopping concurrent attempts never trips the stage circuit and the same run resumes", async () => {
  const rows = [raw("one"), raw("two")];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController();
  let started = 0, resume = false;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      let release = () => {};
      return {
        async run() {
          if (!resume) {
            const stopped = new Promise<void>((resolve) => { release = resolve; });
            if (++started === 2) controller.abort();
            await stopped;
          } else {
            const submitted = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
            assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          }
        },
        async abort() { release(); },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all([0, 1].map((i) => startWorker(backend, path.join(directory, "worker-" + i))));
  try {
    const options = {
      ...services, runId: "stop-concurrent", output: config.output, config, plan: await buildPlan(config),
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 2, retries: 1, retryDelaySeconds: 0,
      failureGuard: { windowSize: 4, threshold: 2 }, workerUrls: workers.map((worker) => worker.url),
    };
    const stopped = await runEvaluation({ ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    assert.equal(stopped.status, "interrupted");
    assert.equal(started, 2);
    assert.deepEqual(stopped.paused_stages, [], "normal shutdown must not persist a circuit pause");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    assert.deepEqual(saved.manifest.pausedStages, []);
    assert(Object.values(saved.manifest.states).every((state) => state.status === "cancelled"));
    resume = true;
    const result = await runEvaluation({ ...options, signal: AbortSignal.timeout(15_000) });
    assert.equal(result.status, "finished");
    assert.equal(result.completed_comparisons, 2);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stop of [false, true]) test(`Host persists its actual retry deadline and clears it on ${stop ? "stop" : "retry"}`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const controller = new AbortController();
  let calls = 0, deadline = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      if (++calls === 1) options.onEvent({ type: "message_end", message: {
        role: "assistant", stopReason: "error", errorMessage: "Connection error.",
      } });
      else {
        const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "retry-deadline", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: .05, workerUrls: [worker.url],
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      repository: { ...services.repository, async writeRun(run, saved) {
        await services.repository.writeRun(run, saved);
        const retry = Object.values(saved.manifest.states).find((task) => task.nextRetryAt !== undefined);
        if (retry && !deadline) {
          deadline = retry.nextRetryAt!;
          assert(deadline > Date.now() - 1000);
          if (stop) controller.abort();
        }
      } },
    });
    assert(deadline, "the scheduled task retry must be visible on disk");
    const saved = await readRunState(path.join(config.output.path, "retry-deadline"));
    assert(Object.values(saved.manifest.states).every((task) => task.nextRetryAt === undefined));
    assert.equal(saved.manifest.status, stop ? "interrupted" : "finished");
    assert.equal(calls > 1, !stop);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const exhausted of [false, true]) test(`SDK malformed Responses arguments ${exhausted ? "stop at" : "recover within"} the configured retry budget`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, targetCalls = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    targetId ??= options.spec.taskId;
    return { async run() {
      if (options.spec.taskId === targetId && (++targetCalls === 1 || exhausted)) {
        options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
          errorMessage: "Invalid OpenAI Responses tool arguments: submit_evaluation (call_retry|fc_retry); expected complete JSON object" } });
        return;
      }
      const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const runId = exhausted ? "malformed-arguments-exhausted" : "malformed-arguments-recovered";
    const summary = await runEvaluation({ ...services, runId, output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url] });
    const saved = await readRunState(path.join(config.output.path, runId));
    assert.equal(targetCalls, 2, "one initial request and exactly one retry; no unbounded SDK fallback");
    assert.equal(saved.manifest.states[targetId!].attempts, 2);
    assert.equal(saved.manifest.states[targetId!].status, exhausted ? "failed" : "succeeded");
    assert.equal(summary.completed_comparisons, exhausted ? 0 : 1);
    if (exhausted) {
      assert.equal(saved.receipts[targetId!], undefined);
      assert.equal(saved.manifest.states[targetId!].failure?.errors[0].category, "transport");
      assert.equal(saved.manifest.states[targetId!].failure?.contentSubmissions, 0, "incomplete arguments never reach content validation");
    } else assert(saved.receipts[targetId!], "only the valid retry produces an accepted evaluation");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const reason of ["no-submission", "idle"] as const)
  for (const scenario of ["disabled", "recovered", "exhausted"] as const)
    test(`unsubmitted ${reason} interruptions ${scenario} respect the configured retry budget`, async () => {
      const { directory, config, modelForStage } = await fixtureConfig();
      let targetId: string | undefined, targetAttempts = 0, targetRuns = 0, retryAt: number | undefined;
      const starts: number[] = [];
      const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
        targetId ??= options.spec.taskId;
        const targeted = options.spec.taskId === targetId;
        const fail = targeted && (++targetAttempts === 1 || scenario === "exhausted");
        if (targeted) starts.push(Date.now());
        let release = () => {};
        return { async run() {
          if (targeted) targetRuns++;
          if (fail) {
            if (reason === "idle") await new Promise<void>((resolve) => { release = resolve; });
            return;
          }
          const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
          assert.equal(result.isError, undefined, JSON.stringify(result));
        }, async abort() { release(); }, async dispose() {} };
      } }, path.join(directory, "worker"));
      try {
        const runId = `${reason}-${scenario}`;
        const summary = await runEvaluation({ ...services, runId, output: config.output, config,
          plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
          policy: { ...config.execution, idleTimeoutSeconds: reason === "idle" ? 1 : 10 }, concurrency: 1,
          retries: scenario === "disabled" ? 0 : 1, retryDelaySeconds: .05, workerUrls: [worker.url],
          signal: AbortSignal.timeout(20_000),
          repository: { ...services.repository, async writeRun(run, saved) {
            await services.repository.writeRun(run, saved);
            if (targetId && retryAt === undefined) retryAt = saved.manifest.states[targetId]?.nextRetryAt;
          } },
        });
        const saved = await readRunState(path.join(config.output.path, runId));
        const state = saved.manifest.states[targetId!];
        const attempts = scenario === "disabled" ? 1 : 2;
        assert.equal(targetAttempts, attempts, "the configured budget bounds fresh attempts");
        assert.equal(state.attempts, attempts);
        assert.equal(state.nextRetryAt, undefined);
        if (scenario === "disabled") assert.equal(retryAt, undefined);
        else {
          assert(retryAt, "the existing retry delay is persisted before the replacement attempt");
          assert(starts[1] >= retryAt, "replacement attempts wait until the persisted retry deadline");
        }
        assert.equal(summary.completed_comparisons, scenario === "recovered" ? 1 : 0);
        if (scenario === "recovered") {
          assert.equal(state.status, "succeeded");
          assert(saved.receipts[targetId!]);
        } else {
          assert.equal(state.status, reason === "idle" ? "timed_out" : "failed");
          assert.equal(state.reason, reason === "idle" ? "Model/tool idle timeout" : "Agent ended without an accepted submission");
          assert.equal(state.failure?.errors[0]?.category, "interruption");
          assert.equal(state.failure?.contentSubmissions, 0);
          assert.equal(state.failure?.draft, undefined);
          assert.equal(saved.receipts[targetId!], undefined);
        }
        assert.equal(targetRuns, reason === "idle" ? attempts : scenario === "recovered" ? 3 : 2 * attempts,
          "only a normally stopped session receives one submission nudge");
      } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
    });

test("a repair attempt that makes no submission retains its draft and counters for explicit resume", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, attempts = 0, resumed = false;
  let draft: unknown;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (options.spec.evaluation.id === "attribution") targetId ??= options.spec.taskId;
    const targeted = options.spec.taskId === targetId;
    if (targeted) attempts++;
    return { async run() {
      if (targeted && !resumed) {
        if (attempts === 1) {
          draft = draftFor(options.spec, invalidResult(options.spec));
          assert.equal((await options.execute("submit_evaluation", draft)).isError, true);
        } else assert.deepEqual(await readJson(path.join(options.workdir, "evaluation-draft.json")), draft);
        return;
      }
      if (targeted) {
        assert.deepEqual(options.spec.recovery?.draft, draft);
        assert.equal(options.spec.recovery?.contentSubmissions, 1);
        assert.deepEqual(await readJson(path.join(options.workdir, "evaluation-draft.json")), draft);
      }
      const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const options = { ...services, runId: "unsubmitted-repair", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 2, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const failed = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(failed.completed_comparisons, 0);
    assert.equal(attempts, 2, "a business draft uses only the content repair budget");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    const state = saved.manifest.states[targetId!];
    assert.equal(state.status, "failed");
    assert.deepEqual(state.failure?.draft, draft);
    assert.equal(state.failure?.contentSubmissions, 1);
    assert.equal(state.failure?.errors[0]?.category, "interruption");
    assert(state.failure?.errors.some(({ category }) => category === "evidence" || category === "structure"));
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1);
    assert.equal(attempts, 3);
    assert.deepEqual((await readRunState(path.join(config.output.path, options.runId))).receipts[targetId!].submissionStats,
      { contentSubmissions: 2, fileErrors: 0 });
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a task deadline without a submission does not consume the automatic retry budget", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, attempts = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    targetId ??= options.spec.taskId;
    let release = () => {};
    return { async run() {
      if (options.spec.taskId === targetId) {
        attempts++;
        await new Promise<void>((resolve) => { release = resolve; });
      } else {
        const result = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }
    }, async abort() { release(); }, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "unsubmitted-deadline", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: { ...config.execution, timeoutSeconds: 1, idleTimeoutSeconds: 10 }, concurrency: 1,
      retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) });
    const saved = await readRunState(path.join(config.output.path, "unsubmitted-deadline"));
    assert.equal(attempts, 1);
    assert.equal(saved.manifest.states[targetId!].attempts, 1);
    assert.equal(saved.manifest.states[targetId!].status, "timed_out");
    assert.equal(saved.manifest.states[targetId!].reason, "Task deadline exceeded");
    assert.equal(saved.receipts[targetId!], undefined);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const debug of [false, true])
  test(`same run ID resumes with changed model, budget and build (debug: ${debug})`, async () => {
    const rows = ["2026-09-23", "2026-09-24"].map((batch_id) => ({
      ...raw("q1", null),
      batch_id,
    }));
    const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
    const controller = new AbortController();
    let resume = false;
    const calls: Record<string, number> = {};
    const backend: AgentBackend = {
      identity: fakeIdentity,
      async createSession(options) {
        const id = options.spec.taskId;
        let release: () => void = () => {};
        return {
          async run() {
            calls[id] = (calls[id] || 0) + 1;
            if (Object.keys(calls).length === 2 && !resume) {
              controller.abort();
              await new Promise<void>((r) => {
                release = r;
              });
            } else {
              const submitted = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
              assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
              assert.equal(submitted.terminate, true);
            }
          },
          async abort() {
            release();
          },
          async dispose() {},
        };
      },
    };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    try {
      const options = {
        runId: "resume",
        debug,
        output: config.output,
        engine: "pi" as const,
        identity: fakeIdentity,
        evaluatorVersion: fakeEvaluatorVersion,
        config,
        ...services,
        plan: await buildPlan(config),
        policy: config.execution,
        modelForStage,
        concurrency: 1,
        retries: 0,
        retryDelaySeconds: 0,
        workerUrls: [worker.url],
      };
      const stopped = await runEvaluation({
        ...options,
        signal: controller.signal,
      });
      assert.equal(stopped.status, "interrupted");
      assert.equal(stopped.completed_comparisons, 0);
      const failureFile = internalPath(
        path.join(config.output.path, "resume"),
        "diagnostics",
        "failures.jsonl",
      );
      assert.equal(await exists(failureFile), false, "interrupted tasks are not exported as execution failures");
      const run = path.join(config.output.path, "resume");
      assert.match(await readFile(path.join(run, "task_summaries.md"), "utf8"), /Interrupted/);
      const saved = await readRunState(run);
      assert.ok(Object.values(saved.receipts).length > 0, "the interrupted run keeps accepted work");
      assert.deepEqual(
        [...new Set(Object.values(saved.receipts).map((receipt) => receipt.evaluatorVersion))],
        [fakeEvaluatorVersion],
      );
      await writeRunState(run, saved);
      resume = true;
      const complete = await runEvaluation({
        ...options,
        evaluatorVersion: "fixture-2",
        config: {
          ...config,
          inputs: { ...config.inputs, batches: ["2026-09-23"] },
        },
        modelForStage: (stage) => ({
          ...modelForStage(stage),
          model: "changed-model",
        }),
        policy: {
          ...config.execution,
          maxToolCalls: config.execution.maxToolCalls + 1,
        },
      });
      assert.equal(complete.completed_comparisons, 2,
        JSON.stringify((await readRunState(run)).manifest.states));
      assert.deepEqual(complete.evaluator_versions, [fakeEvaluatorVersion, "fixture-2"].sort());
      assert.deepEqual(complete.judge_models, {
        criteria: ["changed-model", "fixture"], attribution: ["changed-model"], comparison: ["changed-model"],
      });
      assert.equal(await exists(failureFile), false, "a successful resume has no failure export");
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 1, 1, 2]);
      assert.equal((await validateRun(path.join(config.output.path, "resume"))).valid, true);
      assert.equal(await exists(internalPath(run)), debug);
      const completedState = await readRunState(run);
      assert.equal(completedState.manifest.evaluatorVersion, "fixture-2");
      assert.equal(
        [...new Set(Object.values(completedState.receipts).map((receipt) => receipt.evaluatorVersion))]
          .sort()
          .join("\u0000"),
        [fakeEvaluatorVersion, "fixture-2"].sort().join("\u0000"),
        "accepted receipts keep the version they were produced with",
      );
      for (const receipt of Object.values(completedState.receipts)) {
        assert.equal(receipt.exported?.row.evaluator_version, receipt.evaluatorVersion);
        assert.equal(receipt.judge, receipt.evaluatorVersion === fakeEvaluatorVersion ? "fixture" : "changed-model");
      }
      assert.deepEqual(
        completedState.manifest.tasks,
        saved.manifest.tasks,
        "resume preserves tasks and blind assignments",
      );
      for (const version of config.inputs.versions)
        await writeJsonl(
          version.sources[0].path,
          ["a_fast", "b_fast"].includes(version.id)
            ? [...rows, { ...raw("q1", null), batch_id: "2026-09-25" }]
            : [],
        );
      const appendedPlan = await buildPlan(config);
      assert.equal(appendedPlan.tasks.length, 12);
      const unchanged = await runEvaluation({ ...options, plan: appendedPlan });
      assert.equal(unchanged.completed_comparisons, 2);
      assert.equal((unchanged.planned as { cases: number }).cases, 2);
      assert.deepEqual(Object.keys(unchanged.by_batch as object), ["2026-09-23", "2026-09-24"]);
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 1, 1, 2]);
      const validation = await validateRun(run);
      assert.equal(validation.results.valid, true);
      assert.equal(
        validation.evidence.valid,
        true,
        "appended unrelated records do not invalidate accepted evidence",
      );
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
