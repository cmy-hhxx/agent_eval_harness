import test from "node:test";
import assert from "node:assert/strict";
import { promiseHooks } from "node:v8";
import { setTimeout as delay } from "node:timers/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

test("scheduler quota polling does not accumulate listeners on a long-running task", async t => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let peakListeners = 0, measuring = false, measured = false;
  const listeners = new WeakMap<Promise<unknown>, number>();
  const stopHook = promiseHooks.onInit((_promise, parent) => {
    if (!measuring || !parent) return;
    const count = (listeners.get(parent) ?? 0) + 1;
    listeners.set(parent, count);
    peakListeners = Math.max(peakListeners, count);
  });
  t.after(() => stopHook());
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      if (!measured) {
        measured = true; measuring = true;
        await delay(1600);
        measuring = false;
      }
      await inspectFor(options);
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).isError, undefined);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  t.after(() => worker.close());
  await runEvaluation({ ...services, runId: "wait", output: config.output, engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, plan: await buildPlan(config), policy: config.execution, modelForStage,
    concurrency: 1, modelRequests: { concurrency: () => 1, acquire: async () => () => {} },
    retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] });
  assert(measured);
  assert(peakListeners < 10, `one pending promise accumulated ${peakListeners} listeners while polling`);
});
