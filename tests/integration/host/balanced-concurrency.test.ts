import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { createBalancedModels } from "@eval/host-app/config";
import { draftFor, submitFor, taskResult, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("healthy balanced channels execute different tasks concurrently and accept one submission each", async () => {
  const previousKey = process.env.BALANCED_CONCURRENCY_TEST_KEY;
  const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
  models.channels["evaluation-gateway"].trafficWeight = 1;
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_CONCURRENCY_TEST_KEY" };
  process.env.BALANCED_CONCURRENCY_TEST_KEY = "balanced-concurrency-test-secret";
  const plan = await buildPlan(config), routing = createBalancedModels(models);
  const active = new Map<string, string>(), submissions = new Map<string, number>();
  let simultaneous: [string, string][] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Both healthy channels must reach the attribution barrier concurrently"));
    release();
  }, 10_000);
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const spec = options.spec;
      if (spec.evaluation.id === "attribution") {
        active.set(spec.taskId, spec.model.provider);
        if (active.size === 2) {
          simultaneous = [...active];
          assert.deepEqual(new Set(active.values()), new Set(["evaluation-gateway", "openai"]));
          release();
        }
        await barrier;
      }
      try {
        if (controller.signal.aborted) return;
        const task = plan.tasks.find(task => task.id === spec.taskId)!;
        assert.equal(routing.modelForTask(task).provider, spec.model.provider, "reselecting a running task preserves its channel");
        submissions.set(spec.taskId, (submissions.get(spec.taskId) ?? 0) + 1);
        assert.equal((await submitFor(options, draftFor(spec, taskResult(spec)))).terminate, true);
      } finally {
        active.delete(spec.taskId);
      }
    }, async abort() { release(); }, async dispose() {},
  }; } };
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  try {
    for (const index of [0, 1]) workers.push(await startWorker(backend, path.join(directory, `worker-${index}`)));
    const runId = "balanced-concurrency";
    const result = await runEvaluation({ ...services, ...routing, runId, output: config.output, config, plan,
      engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
      concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url),
      signal: controller.signal });
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(result.paused_stages, []);
    const attributionTasks = plan.tasks.filter(task => task.stage === "attribution");
    assert.equal(attributionTasks.length, 2);
    assert.deepEqual(new Set(simultaneous.map(([id]) => id)), new Set(attributionTasks.map(task => task.id)),
      "both attribution sessions must be active before either submits");
    const saved = await readRunState(path.join(config.output.path, runId));
    for (const task of plan.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded");
      assert.equal(saved.manifest.states[task.id].attempts, 1);
      assert.equal(submissions.get(task.id), 1);
      assert.equal(saved.receipts[task.id].submissionStats?.contentSubmissions, 1);
    }
  } finally {
    clearTimeout(timeout);
    release();
    if (previousKey === undefined) delete process.env.BALANCED_CONCURRENCY_TEST_KEY;
    else process.env.BALANCED_CONCURRENCY_TEST_KEY = previousKey;
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
