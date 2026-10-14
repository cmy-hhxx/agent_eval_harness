import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend, PlannedTask } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { createBalancedModels } from "../../../apps/host/src/balanced-models.js";
import { draftFor, submitFor, taskResult, invalidDraft, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("same-run resume restores the saved task channel and cumulative submission ledger with a new router", async () => {
  const { directory, config, models } = await fixtureConfig([[raw()], [], [raw()], []]);
  const previousKey = process.env.BALANCED_RESUME_TEST_KEY;
  models.channels["evaluation-gateway"].trafficWeight = 6;
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_RESUME_TEST_KEY", trafficWeight: 4 };
  process.env.BALANCED_RESUME_TEST_KEY = "balanced-resume-test-secret";
  const plan = await buildPlan(config), attempts = new Map<string, number>();
  let targetId: string | undefined, resumed = false;
  const channels: string[] = [];
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const spec = options.spec;
      attempts.set(spec.taskId, (attempts.get(spec.taskId) ?? 0) + 1);
      if (!resumed && spec.evaluation.id === "attribution" && spec.model.provider === "openai") {
        targetId = spec.taskId;
        channels.push(spec.model.provider);
        assert.equal((await submitFor(options, invalidDraft(spec))).isError, true);
        throw new Error("Connection error.");
      }
      if (spec.taskId === targetId) {
        channels.push(spec.model.provider);
        assert.equal(spec.model.provider, "openai", "a transient failure must not move a resumed task to the first channel");
        assert.equal(spec.recovery?.contentSubmissions, 1);
        assert(spec.recovery?.draft, "the rejected submission remains available for repair");
        assert.equal(spec.policy.repairAttempts, config.execution.repairAttempts - 1,
          "resume receives only the remaining cumulative content budget");
      }
      assert.equal((await submitFor(options, draftFor(spec, taskResult(spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const runId = "balanced-resume", options = { ...services, runId, output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const first = await runEvaluation({ ...options, ...createBalancedModels(models) });
    assert.equal(first.completed_comparisons, 0);
    assert(targetId, "the first run must actually interrupt an OpenAI attribution task");
    const run = path.join(config.output.path, runId), interrupted = await readRunState(run);
    const previous = interrupted.manifest.states[targetId];
    assert.equal(previous.status, "failed");
    assert.equal(previous.channel, "openai");
    assert.equal(previous.attempts, 1, "retries=0 must not hide the first interruption");
    assert.equal(previous.failure?.contentSubmissions, 1);
    assert.equal(interrupted.receipts[targetId], undefined);
    resumed = true;
    const complete = await runEvaluation({ ...options, ...createBalancedModels(models), plan: { tasks: [], inputs: {}, summary: {} } });
    assert.deepEqual(channels, ["openai", "openai"], "same-run recovery must preserve the saved channel without extra attempts");
    assert.equal(complete.completed_comparisons, 1);
    const saved = await readRunState(run);
    assert.equal(saved.manifest.states[targetId].attempts, 2, "resume appends to the existing attempt count");
    assert.equal(saved.manifest.states[targetId].channel, "openai");
    assert.equal(saved.receipts[targetId].submissionStats?.contentSubmissions, 2);
    for (const task of plan.tasks) {
      assert.equal(saved.manifest.states[task.id].status, "succeeded");
      assert.equal(attempts.get(task.id), task.id === targetId ? 2 : 1, "already accepted tasks must not execute again");
    }
  } finally {
    if (previousKey === undefined) delete process.env.BALANCED_RESUME_TEST_KEY;
    else process.env.BALANCED_RESUME_TEST_KEY = previousKey;
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restored task routes do not consume new-task weights and respect the current channel pool", async () => {
  const { directory, models } = await fixtureConfig();
  const previousKey = process.env.BALANCED_RESUME_TEST_KEY;
  models.channels["evaluation-gateway"].trafficWeight = 6;
  models.channels.openai = { ...models.channels["evaluation-gateway"], provider: "openai",
    baseUrl: "https://balanced.example/v1", apiKeyEnv: "BALANCED_RESUME_TEST_KEY", trafficWeight: 4 };
  process.env.BALANCED_RESUME_TEST_KEY = "balanced-resume-test-secret";
  const task = (id: string) => ({ id, stage: "attribution" } as PlannedTask);
  try {
    const exhausted = new Set<string>(), routing = createBalancedModels(models, undefined, exhausted);
    for (let index = 0; index < 7; index++) {
      const restored = task(`restored-${index}`);
      assert.equal(routing.modelForTask(restored, "openai").provider, "openai");
      assert.equal(routing.modelForTask(restored, "evaluation-gateway").provider, "openai", "an existing assignment takes priority over a stale hint");
    }
    const counts = new Map<string, number>();
    for (let index = 0; index < 100; index++) {
      const model = routing.modelForTask(task(`new-${index}`));
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
      if ((index + 1) % 10 === 0) {
        assert.equal(counts.get("evaluation-gateway"), (index + 1) * 0.6);
        assert.equal(counts.get("openai"), (index + 1) * 0.4);
      }
    }
    const restored = task("restored-0"), oldModel = routing.modelForTask(restored);
    assert.equal(routing.onModelQuotaExhausted(oldModel, restored), true);
    assert.equal(routing.modelForTask(restored, "openai").provider, "evaluation-gateway", "an exhausted saved channel cannot be restored");
    assert.equal(routing.modelForTask(task("after-exhaustion"), "openai").provider, "evaluation-gateway");
    const removed = createBalancedModels(models, ["evaluation-gateway"]);
    assert.equal(removed.modelForTask(task("removed-channel"), "openai").provider, "evaluation-gateway");
  } finally {
    if (previousKey === undefined) delete process.env.BALANCED_RESUME_TEST_KEY;
    else process.env.BALANCED_RESUME_TEST_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
