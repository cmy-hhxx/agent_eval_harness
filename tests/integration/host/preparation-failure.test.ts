import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

for (const failure of ["binding", "profile"] as const)
  test(`a ${failure} preparation error fails only its task and survives two resumes`, async t => {
    const { directory, config, modelForStage } = await fixtureConfig([[raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], []]);
    t.after(() => rm(directory, { recursive: true, force: true }));
    const plan = await buildPlan(config), failed = plan.tasks.find(task => task.stage === "attribution-component")!;
    const executed: string[] = [];
    const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
      async run() {
        executed.push(options.spec.taskId);
        await inspectFor(options);
        const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }, async abort() {}, async dispose() {},
    }; } };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    t.after(() => worker.close());
    const options = { ...services, taskSource: { ...services.taskSource, bind(...args: Parameters<typeof services.taskSource.bind>) {
      if (args[0].id === failed.id && failure === "binding") throw new Error("fixture material preparation failed");
      const binding = services.taskSource.bind(...args);
      return args[0].id === failed.id && failure === "profile" ? { ...binding, profile: "missing-profile" } : binding;
    } }, runId: "preparation", output: config.output, engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution, modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(options);
    const run = path.join(config.output.path, options.runId), state = await readRunState(run);
    assert.equal(state.manifest.status, "finished");
    assert.equal(state.manifest.states[failed.id]!.status, "failed");
    assert.equal(state.manifest.states[failed.id]!.attempts, 0, "preparation spends no model attempt");
    assert.match(state.manifest.states[failed.id]!.reason!, /prepar|profile/i);
    assert(!executed.includes(failed.id));
    const sessions = state.manifest.tasks.filter(task => task.stage === "attribution-session");
    assert.equal(sessions.filter(task => state.receipts[task.id]?.status === "succeeded").length, 4);
    assert.equal(sessions.filter(task => state.receipts[task.id]?.incompleteDependencies?.length).length, 1);
    const counts = [...executed];
    for (let round = 0; round < 2; round++) {
      await runEvaluation({ ...options, skipFailed: true, plan: { tasks: [], inputs: {}, summary: {} } });
      const restored = await readRunState(run);
      assert.equal(restored.manifest.states[failed.id]!.status, "failed");
      assert.deepEqual(executed, counts, "accepted results and explicitly skipped failures are not reevaluated");
    }
  });
