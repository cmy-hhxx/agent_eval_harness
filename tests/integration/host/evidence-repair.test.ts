import { canonicalEvidence } from "../../fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, AttemptSpec, ToolResult, ValidationIssue } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState, type AttributionResult } from "@eval/workflows/comparison";
import { submitFor, inspectFor, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw, taskResult } from "../../fixtures/comparison.js";
import { services, validateRun } from "../../fixtures/services.js";

function structuredToolInput(caseId: string) {
  const input = raw(caseId, null);
  input.messages.splice(1, 0, {
    type: "function_call_output", role: "tool", name: "calculate",
    content: { rows: [{ value: 4, explanation: "计算2+2=4。" }] },
  });
  return input;
}

function taskDraft(spec: AttemptSpec) {
  const result = taskResult(spec);
  if (spec.evaluation.id === "attribution") {
    const material = parsedMaterial(spec) as { answer: { final_message_index: number; final_answer: string } };
    const finding = (result as AttributionResult).findings[0];
    finding.evidence = [canonicalEvidence(spec.inputs.find(input => input.name === "answer")!.id, material.answer.final_message_index, material.answer.final_answer)];
    finding.stage = "execution";
    finding.text = "计算工具正确返回4。";
    finding.reason = "原始工具返回的计算结果与最终回答一致。";
    finding.assessment.observation = "计算2+2=4。";
  }
  return draftFor(spec, result) as { strengths?: { evidence_indices: number[] }[] };
}

const payload = (result: ToolResult) => JSON.parse(result.content.find((item) => item.type === "text")!.text!);
type RepairExpected = {
  available_index_range: number[];
  repair_action: string;
};

for (const scenario of [
  { name: "object", path: "/content", invalidIndex: 999999 },
  { name: "numeric", path: "/content/rows/0/value", invalidIndex: 0 },
  { name: "row", path: "/content/rows/0", invalidIndex: 1.5 },
] as const)
  test(`Host and Worker repair an invalid selection by reading a structured ${scenario.name} within three submissions`, async () => {
    const input = structuredToolInput(`evidence-${scenario.name}`);
    const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
    config.execution.repairAttempts = 2;
    const submittedCounts = new Map<string, number>();
    const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
      return { async run() {
        await inspectFor(options);
        const draft = taskDraft(options.spec);
        if (options.spec.evaluation.id !== "attribution") {
          assert.equal((await submitFor(options, draft)).isError, undefined);
          return;
        }
        draft.strengths![0].evidence_indices = [scenario.invalidIndex];
        submittedCounts.set(options.spec.taskId, 1);
        const rejected = await submitFor(options, draft);
        assert.equal(rejected.isError, true, "an invalid selection is never interpreted as another coordinate");
        const feedback = payload(rejected) as { accepted: boolean; errors: ValidationIssue[] };
        assert.equal(feedback.accepted, false);
        const issue = feedback.errors.find((item) => item.path === "/strengths/0/evidence_indices/0" && item.code === "evidence_selection_invalid")!;
        assert.equal(issue.category, "evidence");
        assert.deepEqual(issue.actual, { evidence_index: scenario.invalidIndex });
        const expected = issue.expected as RepairExpected;
        assert.equal(expected.available_index_range[0], 1);
        assert(expected.available_index_range[1]! >= options.spec.evidenceBank.length);
        assert(expected.repair_action.includes("evidence_index"));
        const read = await options.execute("read_trace", { candidate: "answer", message_index: 1, path: scenario.path });
        assert.equal(read.isError, undefined, JSON.stringify(read));
        const selected = (payload(read) as { evidence: { reference: { evidence_index: number }; quote: string }[] }).evidence
          .find(item => item.quote.includes("4"));
        assert(selected, "the model selects evidence only after checking that its original quote supports the finding");
        draft.strengths![0].evidence_indices = [selected.reference.evidence_index];
        submittedCounts.set(options.spec.taskId, 2);
        const accepted = await submitFor(options, draft);
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        assert.equal(accepted.terminate, true);
      }, async abort() {}, async dispose() {} };
    } };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    try {
      const plan = await buildPlan(config), runId = `evidence-${scenario.name}`;
      const summary = await runEvaluation({ ...services, runId, output: config.output, config, plan,
        modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
        policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url] });
      const run = path.join(config.output.path, runId), saved = await readRunState(run);
      assert.equal(summary.completed_comparisons, 1, JSON.stringify(Object.values(saved.manifest.states)
        .filter((state) => state.status === "failed").map((state) => state.reason)));
      const attributions = plan.tasks.filter((task) => task.stage === "attribution");
      assert.equal(attributions.length, 2);
      for (const task of attributions) {
        assert.equal(submittedCounts.get(task.id), 2);
        assert.equal(saved.manifest.states[task.id].attempts, 1);
        assert.equal(saved.receipts[task.id].submissionStats!.contentSubmissions, 2);
        const accepted = saved.receipts[task.id].evaluation as AttributionResult;
        assert.equal(accepted.findings[0].evidence[0].message_index, 1);
        assert(accepted.findings[0].evidence[0].quote.includes("4"));
      }
      assert.equal((await validateRun(run)).valid, true, "accepted source coordinates survive persistence and offline validation");
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
  });

test("Host retains remaining repairs for identical invalid evidence without exceeding the shared content budget", async () => {
  const input = structuredToolInput("evidence-repeat");
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  const contentBudget = 1 + config.execution.repairAttempts;
  assert.equal(contentBudget, 4, "the default permits one draft and three content repairs in total");
  const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "attribution")!;
  const invalidIndex = 999999;
  let attempts = 0, submissions = 0;
  const attemptContentBudgets: number[] = [];
  const remainingContentBudgets: number[] = [];
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (options.spec.taskId === target.id) {
      attempts++;
      attemptContentBudgets.push(1 + options.spec.policy.repairAttempts);
    }
    return { async run() {
      await inspectFor(options);
      const draft = taskDraft(options.spec);
      if (options.spec.taskId !== target.id) {
        assert.equal((await submitFor(options, draft)).isError, undefined);
        return;
      }
      draft.strengths![0].evidence_indices = [invalidIndex];
      for (let index = 0; index < Math.min(2, 1 + options.spec.policy.repairAttempts); index++) {
        submissions++;
        const rejected = await submitFor(options, draft);
        assert.equal(rejected.isError, true);
        remainingContentBudgets.push(payload(rejected).budget.content_remaining);
      }
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const runId = "evidence-repeat";
    const summary = await runEvaluation({ ...services, runId, output: config.output, config, plan,
      modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url] });
    assert.equal(summary.completed_comparisons, 0);
    const saved = await readRunState(path.join(config.output.path, runId)), failed = saved.manifest.states[target.id];
    assert.equal(attempts, 1, "the bounded same-session continuation uses the remaining repairs without restarting");
    assert.deepEqual(attemptContentBudgets, [contentBudget], "the continuation shares the original session budget");
    assert.deepEqual(remainingContentBudgets, [3, 2, 1, 0], "the same-run continuation cannot reset the cumulative repair budget");
    assert.equal(submissions, contentBudget);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.failure!.contentSubmissions, contentBudget);
    assert.equal(failed.failure!.repeatedErrors, 4, "all rejected drafts belong to the same session");
    assert.equal(failed.failure!.stopped, false, "duplicate errors are diagnostic; cumulative exhaustion stops the task");
    assert.equal(saved.receipts[target.id], undefined, "invalid evidence never produces an accepted receipt");
    assert.deepEqual(failed.failure!.errors.find(issue => issue.code === "evidence_selection_invalid")!.actual,
      { evidence_index: invalidIndex });
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
