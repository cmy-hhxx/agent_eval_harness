import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, ModelConfig } from "../../packages/contracts/src/index.js";
import { startWorker } from "../../packages/worker/src/server.js";
import { runEvaluation } from "../../apps/host/src/runner.js";
import { validateRun } from "../../apps/host/src/validate.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { pairwisePack } from "../../packages/pairwise-eval/src/index.js";
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
            message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } },
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
    assert.equal((await validateRun(path.join(config.outputDir, "first"))).valid, true);
    await runEvaluation({ ...options, resume: true });
    assert.equal(calls, 6);
    await runEvaluation({ ...options, runId: "second" });
    assert.equal(calls, 6, "successful cache must prevent model invocation");
    assert.equal((await validateRun(path.join(config.outputDir, "second"))).valid, true);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("agent ending without submit remains a failure instead of a tie", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession() {
      return { async run() {}, async abort() {}, async dispose() {} };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config),
      { correctness, pairwise, ...common } = config.judge;
    const summary = await runEvaluation({
      runId: "failure",
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
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("interrupted host resumes unfinished work from a new attempt while retaining committed results", async () => {
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
    resume = true;
    const complete = await runEvaluation({ ...options, resume: true });
    assert.equal(complete.completed_comparisons, 2);
    assert.deepEqual(Object.values(calls).sort(), [1, 2]);
    assert.equal((await validateRun(path.join(config.outputDir, "resume"))).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
