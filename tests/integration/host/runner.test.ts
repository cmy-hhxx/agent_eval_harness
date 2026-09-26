import { draftFor, invalidResult, taskResult } from "../../fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, AttemptRecord } from "@eval/contracts";
import { createFileLogger, exists, internalPath, readJson, readJsonl, writeJsonl } from "@eval/data";
import { loadRunInputs, readRunState, writeRunState } from "@eval/workflows/comparison";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { reportRun } from "@eval/workflows/comparison";
import { fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import type { TaskData } from "@eval/workflows/comparison";

test("two workers execute dependency graph, archive receipts and reuse only same-run results", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [raw()], [raw()], [raw()]]);
  config.comparisons = [
    ["a_fast", "aa_fast"],
    ["a_expert", "aa_expert"],
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
          const attribution =
            "has_standard_answer" in (options.spec.evaluation.outputSchema.properties as object);
          const submitted = await options.execute(
            "submit_evaluation",
            draftFor(options.spec, taskResult(options.spec)),
          );
          assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          assert.equal(submitted.terminate, true);
          if (!attribution) {
            const file = path.join(
              config.output.path,
              options.spec.runId,
              "results",
              "comparison.jsonl",
            );
            assert.equal(
              (await readFile(file, "utf8")).trim().split("\n").length,
              1,
              "the result is durable before the worker receives a successful submission response",
            );
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
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 2);
    assert.equal(calls, 6);
    const businessLog = path.join(directory, "log/evaluation.log");
    const logged = (await readFile(businessLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(logged.length, 6);
    assert.equal(logged.filter((row) => row.stage === "attribution").length, 4);
    assert.equal(logged.filter((row) => row.stage === "comparison").length, 2);
    assert.equal(await readFile(path.join(directory, "log/runtime.log"), "utf8"), "");
    assert.deepEqual(summary.tokens, {
      input: 60,
      output: 30,
      cacheRead: 180,
      cacheWrite: 60,
      totalTokens: 330,
    });
    assert.deepEqual(summary.cache, {
      model_input: { hit_rate: 0.6 },
    });
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
    }
    assert(!JSON.stringify(summary).includes("case_ids"));
    assert(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 5000);
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
    assert.equal(await exists(internalPath(run, "exports", "task_outcomes.jsonl")), true);
    assert.equal((await readJson(path.join(run, "stats.json"))).validation, undefined);
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：尚未校验/);
    await runEvaluation(options);
    assert.equal(calls, 6);
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 6);
    const cached = await runEvaluation({ ...options, runId: "second" });
    assert.equal(calls, 12, "a new run must evaluate independently");
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 12);
    assert.deepEqual(cached.cache, {
      model_input: { hit_rate: 0.6 },
    });
    assert.equal((cached.tokens as { totalTokens: number }).totalTokens, 330);
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
      assert.equal(calls, (index + 1) * 3, "another batch must invoke the evaluator even for the same question");
    }
    config.inputs.batches = days;
    const combined = await runEvaluation({
      ...options,
      runId: "combined",
      plan: await buildPlan(config),
    });
    assert.equal(calls, 12);
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
      assert.deepEqual(summary.task_statuses, { failed: 2, blocked: 1 });
      const runtimeLog = (await readFile(path.join(directory, "log/runtime.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(runtimeLog.filter((row) => row.event === "task_failed").length, 1);
      assert.equal(runtimeLog.find((row) => row.event === "task_failed").task_id, plan.tasks[0].id);
      assert.equal(await readFile(path.join(directory, "log/evaluation.log"), "utf8"), "");
      assert.equal((summary.tokens as { totalTokens: number }).totalTokens, 76);
      const run = path.join(config.output.path, "failure");
      assert.equal(await exists(internalPath(run, "diagnostics", "attribution.jsonl")), false);
      assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), true);
      const record = await readJson<AttemptRecord>(
        internalPath(run, "tasks", plan.tasks[0].id, "attempt-001/attempt.json"),
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
            (await readFile(internalPath(run, "tasks", plan.tasks[0].id, "artifacts", artifact.id)))
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
    ["a_fast", "aa_fast"],
    ["a_expert", "aa_expert"],
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
    assert.deepEqual(calls, { pi: 3, prime: 3 });
    assert.equal(workdirs.size, 6);
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
            } else await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
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
      assert.equal(await exists(failureFile), debug);
      const run = path.join(config.output.path, "resume");
      assert.match(await readFile(path.join(run, "task_summaries.md"), "utf8"), /Interrupted/);
      const saved = await readRunState(run);
      await writeRunState(run, saved);
      resume = true;
      const complete = await runEvaluation({
        ...options,
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
      assert.equal(complete.completed_comparisons, 2);
      assert.equal(await exists(failureFile), false, "resume must remove stale failure exports");
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 2]);
      assert.equal((await validateRun(path.join(config.output.path, "resume"))).valid, true);
      assert.equal(await exists(internalPath(run)), debug);
      const completedState = await readRunState(run);
      assert.deepEqual(
        completedState.manifest.tasks,
        saved.manifest.tasks,
        "resume preserves tasks and blind assignments",
      );
      for (const version of config.inputs.versions)
        await writeJsonl(
          version.sources[0].path,
          ["a_fast", "aa_fast"].includes(version.id)
            ? [...rows, { ...raw("q1", null), batch_id: "2026-09-25" }]
            : [],
        );
      const appendedPlan = await buildPlan(config);
      assert.equal(appendedPlan.tasks.length, 9);
      const unchanged = await runEvaluation({ ...options, plan: appendedPlan });
      assert.equal(unchanged.completed_comparisons, 2);
      assert.equal((unchanged.planned as { cases: number }).cases, 2);
      assert.deepEqual(Object.keys(unchanged.by_batch as object), ["2026-09-23", "2026-09-24"]);
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 2]);
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
