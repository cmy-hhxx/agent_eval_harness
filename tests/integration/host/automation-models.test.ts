import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { createModelResolver } from "@eval/host-app/config";
import { createAutomationModels } from "../../../apps/host/src/automation-models.js";
import { draftFor, submitFor, taskResult, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("automation balances tasks and shares exhausted channels across dates without spending content or transport retries", async () => {
  const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://preferred.example/v1", apiKeyEnv: "AUTOMATION_TEST_KEY" };
  process.env.AUTOMATION_TEST_KEY = "preferred-secret";
  const exhausted = new Set<string>(), channels = ["openai", "evaluation-gateway"];
  const routing = createAutomationModels(models, channels, exhausted);
  const plan = await buildPlan(config), calls: { stage: string; channel: string }[] = [];
  const routedTask = (id: string) => ({ id, stage: "attribution" } as typeof plan.tasks[number]);
  const assignments = createAutomationModels(models, channels, exhausted);
  assert.equal(assignments.modelForTask!(routedTask("first")).provider, "openai");
  assert.equal(assignments.modelForTask!(routedTask("second")).provider, "evaluation-gateway");
  assert.equal(assignments.modelForTask!(routedTask("first")).provider, "openai");
  let quotaFailures = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const { model, evaluation } = options.spec;
      calls.push({ stage: evaluation.id, channel: model.provider });
      if (model.provider === "openai") {
        quotaFailures++;
        options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
          errorMessage: "429 insufficient_quota: You exceeded your current quota" } });
        return;
      }
      if (model.provider === "evaluation-gateway") {
        assert.equal(model.baseUrl, models.channels["evaluation-gateway"].baseUrl);
        assert.equal(model.apiKeyEnv, models.channels["evaluation-gateway"].apiKeyEnv);
        assert.equal(options.spec.recovery?.contentSubmissions ?? 0, 0);
      }
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const workers = await Promise.all([0, 1].map(index => startWorker(backend, path.join(directory, `worker-${index}`))));
  try {
    const options = { ...services, ...routing, runId: "quota-fallback", output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
      concurrency: 2, retries: 0, retryDelaySeconds: 0, failureGuard: { windowSize: 2, threshold: 2 },
      workerUrls: workers.map(worker => worker.url), signal: AbortSignal.timeout(15_000) };
    const result = await runEvaluation(options);
    assert.deepEqual(result.paused_stages, [], "concurrent exhausted requests cannot pause a stage before fallback");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    for (const task of plan.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded", task.stage);
      assert.equal(saved.manifest.states[task.id].attempts, task.stage === "criteria" ? 2 : 1);
      assert.equal(saved.receipts[task.id].submissionStats?.contentSubmissions, 1);
    }
    assert.equal(quotaFailures, 1);
    assert.equal(calls.at(-1)?.channel, "evaluation-gateway");
    const nextDay = createAutomationModels(models, channels, exhausted);
    const nextModel = nextDay.modelForTask!(routedTask("next-day"));
    assert.equal(nextModel.provider, "evaluation-gateway");
    assert.equal(nextDay.onModelQuotaExhausted!(nextModel, routedTask("next-day")), false, "all exhausted channels cannot loop");
    assert.equal(createAutomationModels(models, channels).modelForTask!(routedTask("restart")).provider, "openai", "restart restores both channels");
    assert.equal(createModelResolver(models)("criteria").provider, "evaluation-gateway", "manual bindings are unchanged");
    assert.equal(createAutomationModels(models, []).modelForStage("criteria").provider, "evaluation-gateway");
    const before = calls.length;
    await runEvaluation(options);
    assert.equal(calls.length, before, "accepted work is preserved on resume");
    delete process.env.AUTOMATION_TEST_KEY;
    assert.throws(() => createAutomationModels(models, channels), /Missing AUTOMATION_TEST_KEY/);
  } finally {
    delete process.env.AUTOMATION_TEST_KEY;
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("automation caps OpenAI attempts while other channels use free slots, including retries and resume", async () => {
  const previousKey = process.env.AUTOMATION_CONCURRENCY_TEST_KEY;
  const rows = [raw("q1"), raw("q2"), raw("q3")];
  const { directory, config, models } = await fixtureConfig([rows, [], rows, []]);
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://preferred.example/v1", apiKeyEnv: "AUTOMATION_CONCURRENCY_TEST_KEY" };
  process.env.AUTOMATION_CONCURRENCY_TEST_KEY = "concurrency-test-secret";
  const plan = await buildPlan(config);
  const routing = createAutomationModels(models, ["openai", "evaluation-gateway"], new Set(), { openai: 1 });
  const attributions = plan.tasks.filter(task => task.stage === "attribution");
  assert.equal(attributions.length, 6);
  for (const task of plan.tasks)
    routing.modelForTask(task, attributions.indexOf(task) >= 0 && attributions.indexOf(task) < 4 ? "openai" : "evaluation-gateway");
  const active = new Map<string, { channel: string; stage: string }>(), attempts = new Map<string, number>();
  let peakOpenai = 0, sharedSlots = false, failedTask: string | undefined;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const spec = options.spec, channel = spec.model.provider;
      active.set(spec.taskId, { channel, stage: spec.evaluation.id });
      attempts.set(spec.taskId, (attempts.get(spec.taskId) ?? 0) + 1);
      peakOpenai = Math.max(peakOpenai, [...active.values()].filter(value => value.channel === "openai").length);
      try {
        if (channel === "openai" && !failedTask) {
          failedTask = spec.taskId;
          options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error",
            errorMessage: "OpenAI API error (503): Service temporarily unavailable" } });
          return;
        }
        if (spec.evaluation.id === "attribution") {
          const held = [...active.values()].filter(value => value.stage === "attribution");
          if (held.some(value => value.channel === "openai") && held.filter(value => value.channel === "evaluation-gateway").length >= 2) {
            sharedSlots = true;
            clearTimeout(timeout);
            release();
          }
          await barrier;
        }
        if (!controller.signal.aborted)
          assert.equal((await submitFor(options, draftFor(spec, taskResult(spec)))).terminate, true);
      } finally { active.delete(spec.taskId); }
    }, async abort() { release(); }, async dispose() {},
  }; } };
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  try {
    assert.throws(() => createAutomationModels(models, ["openai"], new Set(), { missing: 1 }), /Unknown automation channel limit/);
    for (const index of [0, 1, 2, 3]) workers.push(await startWorker(backend, path.join(directory, `worker-${index}`)));
    timeout = setTimeout(() => {
      controller.abort(new Error("Channel-limited tasks must leave slots for other channels"));
      release();
    }, 10_000);
    const options = { ...services, ...routing, runId: "limited-channels", output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
      concurrency: 4, retries: 1, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url), signal: controller.signal };
    const result = await runEvaluation(options);
    assert.equal(controller.signal.aborted, false);
    assert.equal(peakOpenai, 1);
    assert.equal(sharedSlots, true, "OpenAI backlog must not stop other channels from filling available slots");
    assert.deepEqual(result.paused_stages, []);
    const saved = await readRunState(path.join(config.output.path, options.runId));
    for (const task of plan.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded");
      assert.equal(saved.manifest.states[task.id].attempts, task.id === failedTask ? 2 : 1);
      assert.equal(saved.receipts[task.id].submissionStats?.contentSubmissions, 1);
    }
    const before = [...attempts.values()].reduce((sum, count) => sum + count, 0);
    await runEvaluation(options);
    assert.equal([...attempts.values()].reduce((sum, count) => sum + count, 0), before, "resume preserves accepted work");
    await assert.rejects(runEvaluation({ ...options, channelConcurrency: { openai: 0 } }), /positive integer limits/);
  } finally {
    clearTimeout(timeout);
    release();
    if (previousKey === undefined) delete process.env.AUTOMATION_CONCURRENCY_TEST_KEY;
    else process.env.AUTOMATION_CONCURRENCY_TEST_KEY = previousKey;
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
