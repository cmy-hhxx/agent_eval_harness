import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend, PlannedTask } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { createBalancedModels } from "@eval/host-app/config";
import { draftFor, submitFor, taskResult, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("healthy channels dispatch six original and four OpenAI tasks per ten, preserving retry routes", async () => {
  const { directory, models } = await fixtureConfig();
  models.channels["evaluation-gateway"].trafficWeight = 6;
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_TEST_KEY", trafficWeight: 4 };
  process.env.BALANCED_TEST_KEY = "balanced-test-secret";
  try {
    const routing = createBalancedModels(models), counts = new Map<string, number>();
    for (let index = 0; index < 100; index++) {
      const task = { id: `weighted-${index}`, stage: "attribution" } as PlannedTask;
      const model = routing.modelForTask(task);
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
      for (let retry = 0; retry < 4; retry++) assert.equal(routing.modelForTask(task).provider, model.provider);
      if ((index + 1) % 10 === 0) {
        assert.equal(counts.get("evaluation-gateway"), (index + 1) * 0.6);
        assert.equal(counts.get("openai"), (index + 1) * 0.4);
      }
    }
  } finally {
    delete process.env.BALANCED_TEST_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});

test("balanced tasks keep their channel and stage parameters, and quota exhaustion reroutes without refunding work", async () => {
  const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_TEST_KEY" };
  process.env.BALANCED_TEST_KEY = "balanced-test-secret";
  models.bindings.attribution.thinking = "high";
  const plan = await buildPlan(config);
  const routing = createBalancedModels(models);
  const seen: { task: string; stage: string; channel: string }[] = [];
  const failed = new Set<string>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const spec = options.spec;
      seen.push({ task: spec.taskId, stage: spec.evaluation.id, channel: spec.model.provider });
      if (spec.evaluation.id === "attribution") assert.equal(spec.model.thinking, "high");
      if (spec.model.provider === "openai" && !failed.size) {
        failed.add(spec.taskId);
        options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
          errorMessage: "429 insufficient_quota: balance exhausted" } });
        return;
      }
      assert.equal((await submitFor(options, draftFor(spec, taskResult(spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const a = { id: "route-a", stage: "attribution" } as PlannedTask;
    const b = { id: "route-b", stage: "attribution" } as PlannedTask;
    const check = createBalancedModels(models);
    assert.notEqual(check.modelForTask(a).provider, check.modelForTask(b).provider);
    assert.equal(check.modelForTask(a).provider, check.modelForTask(a).provider);
    assert.equal(check.modelForTask(a).thinking, "high");
    const options = { ...services, ...routing, runId: "balanced", output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const result = await runEvaluation(options);
    assert.deepEqual(result.paused_stages, []);
    assert.equal(failed.size, 1);
    assert.deepEqual(new Set(seen.map(item => item.channel)), new Set(["evaluation-gateway", "openai"]));
    const saved = await readRunState(path.join(config.output.path, options.runId));
    for (const task of plan.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded");
      assert.equal(saved.manifest.states[task.id].channel, seen.filter(item => item.task === task.id).at(-1)!.channel);
      assert.equal(saved.receipts[task.id].submissionStats?.contentSubmissions, 1);
      assert.equal(saved.manifest.states[task.id].attempts, failed.has(task.id) ? 2 : 1);
    }
    const before = seen.length;
    await runEvaluation(options);
    assert.equal(seen.length, before, "resume must preserve accepted work");
    delete process.env.BALANCED_TEST_KEY;
    assert.throws(() => createBalancedModels(models), /Missing BALANCED_TEST_KEY/);
  } finally {
    delete process.env.BALANCED_TEST_KEY;
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
