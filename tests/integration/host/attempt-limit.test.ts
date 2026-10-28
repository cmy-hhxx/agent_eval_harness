import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

test("task attempt cap preserves successes and fresh work across automatic retries and same-run resumes", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("bad"), raw("good")], [], [raw("bad"), raw("good")], []]);
  config.execution.maxTaskAttempts = 2;
  const plan = await buildPlan(config), failing = plan.tasks.find(task => task.stage === "criteria")!.id;
  const calls = new Map<string, number>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
      if (options.spec.taskId === failing) throw new Error("Connection error.");
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const options = { ...services, runId: "bounded-attempts", output: config.output, config, engine: "pi" as const,
    identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, plan, policy: config.execution, modelForStage,
    concurrency: 1, retries: 5, retryDelaySeconds: 0, workerUrls: [worker.url] };
  try {
    await runEvaluation(options);
    const run = path.join(config.output.path, options.runId), before = await readRunState(run);
    assert.equal(calls.get(failing), 2, "task cap overrides a larger transport retry budget");
    assert(before.manifest.tasks.some(task => task.stage === "comparison" && before.receipts[task.id]), "fresh case finishes despite the exhausted sample");
    const accepted = Object.entries(before.receipts).map(([id, receipt]) => [id, receipt.submissionId]);
    await runEvaluation(options);
    const after = await readRunState(run);
    assert.equal(calls.get(failing), 2, "same run must not replenish task attempts");
    for (const [id, submissionId] of accepted) {
      assert.equal(after.receipts[id!]?.submissionId, submissionId);
      assert.equal(calls.get(id!), 1, "accepted tasks do not run again");
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
