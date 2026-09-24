import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, AttemptRecord, ModelConfig } from "../../packages/contracts/src/index.js";
import { exists, internalPath, readInputs, readJson, readJsonl, sha256 } from "../../packages/contracts/src/io.js";
import { readRunState, writeRunState } from "../../packages/pairwise-eval/src/run-data.js";
import { startWorker } from "../../packages/worker/src/server.js";
import { runEvaluation } from "../../apps/host/src/runner.js";
import { validateRun } from "../../apps/host/src/validate.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { pairwisePack } from "../../packages/pairwise-eval/src/index.js";
import { reportRun } from "../../packages/pairwise-eval/src/report.js";
import { fakeIdentity, fixtureConfig, pairResult, raw } from "./fixtures.js";
import type { TaskData } from "../../packages/pairwise-eval/src/types.js";

test("two workers execute dependency graph, archive receipts, resume and reuse cache", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [raw()], [raw()], [raw()]]);
  let calls = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          options.onEvent({
            type: "message_end",
            message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 30, cacheWrite: 10, totalTokens: 55 } },
          });
          const correctness = "is_correct" in (options.spec.evaluation.outputSchema.properties as object);
          const result = correctness
            ? {
                is_correct: true,
                correctness_reason: "结果与标准答案一致。",
                evidence: [{ message_index: 1, quote: "2+2=4" }],
              }
            : pairResult();
          const submitted = await options.execute("submit_evaluation", result);
          assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          assert.equal(submitted.terminate, true);
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
    const plan = await buildPlan(config),
      { correctness, pairwise, ...common } = config.judge;
    const options = {
      runId: "first",
      debug: true,
      outputDir: config.outputDir,
      cacheDir: config.cacheDir,
      engine: "pi" as const,
      identity: fakeIdentity,
      config,
      pack: pairwisePack,
      plan,
      policy: config.execution,
      modelForStage: (stage: string) =>
        ({ ...common, ...(stage === "correctness" ? correctness : pairwise) }) as ModelConfig,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    };
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 2);
    assert.equal(calls, 6);
    assert.deepEqual(summary.tokens, { input: 60, output: 30, cacheRead: 180, cacheWrite: 60, totalTokens: 330 });
    assert.deepEqual(summary.cache, {
      task_results: { hits: 0, accepted_receipts: 6, hit_rate: 0 },
      model_input: { hit_rate: 0.6 },
    });
    const run = path.join(config.outputDir, "first");
    assert.deepEqual(await readJson(path.join(run, "stats.json")), summary);
    const checkpoint = await readJson(path.join(run, "state.json"));
    assert.equal(checkpoint.manifest, undefined);
    assert.equal(checkpoint.receipts, undefined);
    for (const task of plan.tasks.filter((task) => task.stage === "pairwise")) {
      const stored = (checkpoint.tasks as Record<string, { receipt: Record<string, unknown> }>)[task.id].receipt;
      assert(stored.exported);
      assert.equal(stored.evaluation, undefined, "completed evaluations belong only in result files");
    }
    assert(!JSON.stringify(summary).includes("case_ids"));
    assert(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 5000);
    assert.deepEqual((await readdir(run)).sort(), ["_internal", "report.md", "results", "state.json", "stats.json", "task_summaries.md"]);
    assert.equal(await exists(internalPath(run, "exports")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "correctness.jsonl")), true);
    assert.deepEqual(await readInputs(run), plan.inputs);
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
    for (const version of config.inputs.versions) await rm(version.path);
    assert.equal((await validateRun(run)).valid, true, "archived evidence is independent of source files");
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：通过/);
    await reportRun(run, { details: true });
    assert.equal(await exists(internalPath(run, "exports", "task_summaries.jsonl")), true);
    assert.equal(await exists(internalPath(run, "exports", "task_outcomes.jsonl")), true);
    assert.equal((await readJson(path.join(run, "stats.json"))).validation, undefined);
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：尚未校验/);
    await runEvaluation(options);
    assert.equal(calls, 6);
    const cached = await runEvaluation({ ...options, runId: "second" });
    assert.equal(calls, 6, "successful cache must prevent model invocation");
    assert.deepEqual(cached.cache, {
      task_results: { hits: 6, accepted_receipts: 6, hit_rate: 1 },
      model_input: { hit_rate: null },
    });
    assert.equal((cached.tokens as { totalTokens: number }).totalTokens, 0);
    assert.equal((await validateRun(path.join(config.outputDir, "second"))).valid, true);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
for (const missingArtifact of [false, true])
test(`failed attempt archives diagnostics and releases only complete copies (missing artifact: ${missingArtifact})`, async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          options.onEvent({ type: "message_end", message: { role: "assistant", usage: { input: 6, output: 4, cacheRead: 9, totalTokens: 19 } } });
          await options.execute("execute_code", { language: "python", code: "print('failed attempt evidence')" });
          if (missingArtifact) {
            const artifacts = path.join(directory, "worker", options.spec.attemptId, "artifacts");
            await rm(path.join(artifacts, (await readdir(artifacts))[0]));
          }
          const invalid = pairResult();
          invalid.evaluations.A.findings[0].evidence[0].quote = "invented";
          assert.equal((await options.execute("submit_evaluation", invalid)).isError, true);
        },
        async abort() {}, async dispose() {},
      };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config),
      { correctness, pairwise, ...common } = config.judge;
    const summary = await runEvaluation({
      runId: "failure",
      debug: true,
      outputDir: config.outputDir,
      cacheDir: config.cacheDir,
      engine: "pi",
      identity: fakeIdentity,
      config,
      pack: pairwisePack,
      plan,
      policy: config.execution,
      modelForStage: () => ({ ...common, ...pairwise }),
      concurrency: 1,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    });
    assert.equal(summary.completed_comparisons, 0);
    assert.deepEqual(summary.task_statuses, { failed: 1 });
    assert.equal((summary.tokens as { totalTokens: number }).totalTokens, 19);
    const run = path.join(config.outputDir, "failure");
    assert.equal(await exists(internalPath(run, "diagnostics", "correctness.jsonl")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), true);
    const record = await readJson<AttemptRecord>(internalPath(run, "tasks", plan.tasks[0].id, "attempt-001/attempt.json"));
    assert.equal(record.status?.state, "failed");
    assert.match(record.error!, /without an accepted submission/);
    assert(record.pendingSubmission);
    assert(record.metrics!.audit.artifacts.length > 0);
    if (missingArtifact) {
      assert.match(record.artifactError!, /Artifact unavailable/);
      assert.equal((await readdir(path.join(directory, "worker"))).length, 1);
    } else {
      for (const artifact of record.metrics!.audit.artifacts)
        assert.equal(sha256(await readFile(internalPath(run, "tasks", plan.tasks[0].id, "artifacts", artifact.id))), artifact.digest);
      assert.deepEqual(await readdir(path.join(directory, "worker")), []);
    }
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("one host routes tasks to both engines without sharing sessions or workspaces", async () => {
  const { directory, config } = await fixtureConfig();
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
            "is_correct" in (options.spec.evaluation.outputSchema.properties as object)
              ? {
                  is_correct: true,
                  correctness_reason: "匹配。",
                  evidence: [{ message_index: 1, quote: "2+2=4" }],
                }
              : pairResult(),
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
    const { correctness, pairwise, ...common } = config.judge;
    const summary = await runEvaluation({
      runId: "mixed",
      outputDir: config.outputDir,
      cacheDir: config.cacheDir,
      engine: "pi",
      identity: fakeIdentity,
      identities: { prime: primeIdentity },
      engineForTask: (task) =>
        Object.values((task.data as TaskData).candidates).some((c) => c.version.includes("expert"))
          ? "prime"
          : "pi",
      config,
      pack: pairwisePack,
      plan: await buildPlan(config),
      policy: config.execution,
      modelForStage: (stage) => ({ ...common, ...(stage === "correctness" ? correctness : pairwise) }),
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    });
    assert.equal(summary.completed_comparisons, 2);
    assert.deepEqual(calls, { pi: 3, prime: 3 });
    assert.equal(workdirs.size, 6);
    const run = path.join(config.outputDir, "mixed");
    assert.deepEqual((await readdir(run)).sort(), ["report.md", "results", "state.json", "stats.json", "task_summaries.md"]);
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
test(`same run ID resumes with changed model, budget and fingerprint (debug: ${debug})`, async () => {
  const { directory, config } = await fixtureConfig([
    [raw("q1", null), raw("q2", null)],
    [],
    [raw("q1", null), raw("q2", null)],
    [],
  ]);
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
          } else await options.execute("submit_evaluation", pairResult());
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
    const { correctness, pairwise, ...common } = config.judge;
    const options = {
      runId: "resume",
      debug,
      outputDir: config.outputDir,
      cacheDir: config.cacheDir,
      engine: "pi" as const,
      identity: fakeIdentity,
      config,
      pack: pairwisePack,
      plan: await buildPlan(config),
      policy: config.execution,
      modelForStage: () => ({ ...common, ...pairwise }),
      concurrency: 1,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    const stopped = await runEvaluation({ ...options, signal: controller.signal });
    assert.equal(stopped.status, "interrupted");
    assert.equal(stopped.completed_comparisons, 1);
    const failureFile = internalPath(path.join(config.outputDir, "resume"), "diagnostics", "failures.jsonl");
    assert.equal(await exists(failureFile), debug);
    const run = path.join(config.outputDir, "resume");
    assert.match(await readFile(path.join(run, "task_summaries.md"), "utf8"), /Interrupted/);
    const saved = await readRunState(run);
    saved.manifest.fingerprint = "previous-code-version";
    await writeRunState(run, saved);
    resume = true;
    const complete = await runEvaluation({ ...options,
      modelForStage: () => ({ ...common, ...pairwise, model: "changed-model" }),
      policy: { ...config.execution, maxToolCalls: config.execution.maxToolCalls + 1 },
    });
    assert.equal(complete.completed_comparisons, 2);
    assert.equal(await exists(failureFile), false, "resume must remove stale failure exports");
    assert.deepEqual(Object.values(calls).sort(), [1, 2]);
    assert.equal((await validateRun(path.join(config.outputDir, "resume"))).valid, true);
    assert.equal(await exists(internalPath(run)), debug);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
