import { compactReceipt } from "../../fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import { buildPlan, readRunState, reportRun, writeRunState } from "@eval/workflows/comparison";
import { emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, raw } from "../../fixtures/comparison.js";

test("an interrupted Comparison report retains internal receipts without treating them as final comparisons", async t => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await buildPlan(f.config), runId = "partial-components", run = path.join(f.config.output.path, runId);
  const component = plan.tasks.find(task => task.stage === "attribution-compact")!;
  assert(component);
  const evaluation = compactReceipt().evaluation;
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId, status: "interrupted",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config: f.config, tasks: plan.tasks,
    inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary, startedAt: 1,
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: task === component ? "succeeded" : "cancelled", attempts: task === component ? 1 : 0 }])) },
    receipts: { [component.id]: { taskId: component.id, attemptId: "attempt", submissionId: "submission",
      status: "succeeded", acceptedAt: 2, evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge,
      evaluation, audit: emptyAudit(), usage: emptyUsage() } }, usage: emptyUsage(), recordedAttempts: 1 };
  await writeRunState(run, state);
  await reportRun(run);
  const saved = await readRunState(run);
  assert.deepEqual(saved.receipts[component.id].evaluation, evaluation);
  assert.equal(saved.manifest.states[component.id].status, "succeeded");
  const report = await readFile(path.join(run, "task_summaries.md"), "utf8");
  assert(!report.includes("（attribution-compact）"));
  assert(!report.includes("（attribution-trace）"));
  assert(report.includes("（comparison）"));
});
