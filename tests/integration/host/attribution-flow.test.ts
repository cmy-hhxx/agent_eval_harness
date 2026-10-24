import { responsibilityFixture } from "../../fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState, type AttributionResult, type TaskData } from "@eval/workflows/comparison";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, parsedMaterial, submitFor, taskResult } from "../../fixtures/comparison.js";
import { services, validateRun } from "../../fixtures/services.js";

test("Host preserves one attribution per answer and records unresolved comparison without automatic rechecks", { timeout: 60_000 }, async t => {
  let phase = "setup", calls = 0, lastProgress: string | undefined;
  const callsByStage: Record<string, number> = {};
  t.signal.addEventListener("abort", () => {
    if (phase !== "complete") t.diagnostic(JSON.stringify({ phase, calls, callsByStage, lastProgress }));
  }, { once: true });
  const fixture = await fixtureConfig(undefined, true), originalCompletions: string[] = [];
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options); calls++;
      callsByStage[options.spec.evaluation.id] = (callsByStage[options.spec.evaluation.id] ?? 0) + 1;
      const evaluation = taskResult(options.spec), material = parsedMaterial(options.spec) as { review_context?: unknown };
      const original = options.spec.evaluation.id === "attribution" && !material.review_context;
      if (original) {
        const result = evaluation as AttributionResult, finding = structuredClone(result.findings[0]);
        finding.finding_id = "f-extra"; finding.type = "problem"; finding.dimension = "reasoning"; finding.importance = "medium";
        finding.text = "计算过程缺少展开。"; finding.reason = "直接给出结果，缺少中间计算说明。";
        finding.assessment.requirement_index = null; finding.assessment.impact = "过程的可检查性不足。";
        finding.problem = { diagnosis: "other" as const, investigation: [], component: [responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: []})], label: "计算过程缺口", definition: "缺少中间计算说明。" };
        result.findings.push(finding);
      }
      const submitted = await submitFor(options, draftFor(options.spec, evaluation));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
      if (original) originalCompletions.push(options.spec.taskId);
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(fixture.directory, "worker"));
  try {
    const plan = await buildPlan(fixture.config), options = {
      runId: "coverage-rewrite", output: fixture.config.output, config: fixture.config,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, ...services,
      plan, policy: fixture.config.execution, modelForStage: fixture.modelForStage,
      concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: t.signal,
      onProgress: (message: string) => { if (message.startsWith("progress ")) lastProgress = message.slice("progress ".length); },
    };
    phase = "initial-evaluation";
    const summary = await runEvaluation(options), run = path.join(fixture.config.output.path, options.runId);
    const accepted = await readRunState(run);
    assert.equal(originalCompletions.length, 2);
    assert.equal(accepted.manifest.tasks.filter(task => task.stage === "attribution").length, 2);
    assert(!accepted.manifest.tasks.some(task => (task.data as TaskData).reviewOf));
    assert(accepted.manifest.tasks.filter(task => task.stage === "comparison").every(task =>
      (accepted.receipts[task.id]?.evaluation as { status: string }).status === "needs_review"));
    assert.equal(summary.status, "finished");
    assert(accepted.manifest.tasks.filter(task => task.stage !== "rewrite" || (task.data as TaskData).rewriteOf?.stage === "attribution").every(task => accepted.manifest.states[task.id].status === "succeeded"),
      "handoff leaves no permanently pending or blocked work");
    phase = "stored-result-validation";
    assert.equal((await validateRun(run)).delivery.valid, false);
    const callsBeforeResume = calls;
    phase = "same-run-resume";
    await runEvaluation(options);
    const resumed = await readRunState(run);
    assert.equal(calls, callsBeforeResume, "same-run reconciliation must not recreate old-source polish");
    assert.deepEqual(resumed.manifest.tasks.map(task => task.id), accepted.manifest.tasks.map(task => task.id));
    for (const [id, receipt] of Object.entries(accepted.receipts)) assert.equal(resumed.receipts[id]!.submissionId, receipt!.submissionId);
  } finally {
    phase = "cleanup";
    await worker.close(); await rm(fixture.directory, { recursive: true, force: true });
    phase = "complete";
  }
});
