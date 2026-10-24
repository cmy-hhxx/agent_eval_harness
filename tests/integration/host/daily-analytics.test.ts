import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeJson } from "@eval/data";
import { answerReviewRunSummaries } from "@eval/workflows/answer-review";
import type { Checkpoint } from "@eval/workflows/comparison";
import { comparisonEvaluationAnalytics } from "../../../apps/host/src/daily-evaluation-analytics.js";

test("daily comparison coverage counts paired business identities once and waits for formal polish receipts", () => {
  const receipt = { acceptedAt: 1, exported: { file: "comparison.jsonl" } };
  const saved = {
    config: { inputs: { versions: [{ id: "a_fast", comparison_tier: "Fast" }, { id: "b_fast", comparison_tier: "Fast" }] }, rewrite: { comparison: true } },
    inputs: { a: { version: "a_fast", batch_id: "day", case_id: "one", trace_id: "a" }, b: { version: "b_fast", batch_id: "day", case_id: "one", trace_id: "b" } },
    tasks: {
      criteria: { stage: "criteria", status: "succeeded", inputIds: { A: "a", B: "b" }, dependencies: {}, data: {}, receipt },
      comparison: { stage: "comparison", status: "succeeded", inputIds: { A: "a", B: "b" }, dependencies: { criteria: "criteria" }, data: { group: ["a_fast", "b_fast"], comparisonId: "pair" }, receipt },
      rewrite: { stage: "rewrite", status: "pending", inputIds: {}, dependencies: { source: "comparison" }, data: { rewriteOf: { taskId: "comparison", stage: "comparison" } } },
      audit: { stage: "comparison", status: "failed", inputIds: { A: "a", B: "b" }, dependencies: {}, data: { verificationAudit: true } },
    },
  } as unknown as Checkpoint;
  let result = comparisonEvaluationAnalytics("2026-10-24", [saved]);
  assert.deepEqual(result.totals, { total: 1, completed: 0, partial: 1, pending: 0, failed: 0, running: 0 });
  assert.equal(result.models[0].model, "Fast");
  assert.deepEqual(result.groups.map(({date,model,total,partial})=>({date,model,total,partial})), [{date:"2026-10-24",model:"Fast",total:1,partial:1}]);
  assert.equal(result.stages.find(stage => stage.stage === "comparison")!.total, 1, "audit tasks are not daily comparisons");
  saved.tasks.rewrite.status = "succeeded"; saved.tasks.rewrite.receipt = receipt as any;
  result = comparisonEvaluationAnalytics("2026-10-24", [saved, structuredClone(saved)]);
  assert.equal(result.totals.total, 1, "another run covering the same pair does not double the sample denominator");
  assert.equal(result.totals.completed, 1);
  assert.equal(result.dates[0].date, "2026-10-24");
  saved.tasks.comparison.receipt = undefined;
  result = comparisonEvaluationAnalytics("2026-10-24", [saved]);
  assert.equal(result.totals.completed, 0); assert.equal(result.totals.failed, 1, "a succeeded state without accepted output is not completion");
});

test("AIME analytics is an exclusive trace-aware distribution across both stages and overlapping runs", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "aime-analytics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved: any = { workflow: "answer-review", manifest: { runId: "daily", status: "interrupted", evaluatorVersion: "fixture" }, inputs: {}, tasks: {}, usage: {}, recordedAttempts: 0 };
  const add = (id: string, trace = id) => { saved.inputs[id] = { input_id: id, version: "aime_fast", batch_id: "opaque-batch", case_id: "question", trace_id: trace, question: "q" }; };
  const stage = (input: string, name: string, status: string, accepted = false) => {
    const id = `${input}-${name}`;
    saved.tasks[id] = { task: { stage: name, inputIds: { case: input }, dependencies: {} }, data: { input_id: input }, state: { status, attempts: 1 },
      ...(accepted ? { receipt: { taskId: id, exported: { id, file: `${name}.jsonl` } } } : {}) };
  };
  for (const id of ["complete", "partial", "failed", "running", "pending", "no-receipt"]) add(id);
  stage("complete", "score", "succeeded", true); stage("complete", "attribution", "succeeded", true);
  stage("partial", "attribution", "succeeded", true);
  stage("failed", "attribution", "succeeded", true); stage("failed", "score", "failed");
  stage("running", "score", "running");
  stage("no-receipt", "score", "succeeded");
  await writeJson(path.join(directory, "one/state.json"), saved);
  const before = await readFile(path.join(directory, "one/state.json"), "utf8");
  let view = await answerReviewRunSummaries([{ run: path.join(directory, "one") }]);
  assert.deepEqual(view.coverage.totals, { total: 6, completed: 1, partial: 1, pending: 1, failed: 2, running: 1 });
  assert.equal(view.coverage.dates[0].date, null, "opaque batch IDs are not invented calendar dates");
  assert.equal(view.coverage.stages.find(stage => stage.stage === "score")!.total, 6, "missing historical phases remain pending");
  assert.equal(view.coverage.models[0].total, 6, "different true traces of the same question remain independent answers");
  const repeated = structuredClone(saved); repeated.manifest.runId = "again";
  repeated.inputs.complete.case_id = "renamed-case"; repeated.inputs.complete.batch_id = "renamed-batch";
  await writeJson(path.join(directory, "two/state.json"), repeated);
  view = await answerReviewRunSummaries([{ run: path.join(directory, "one"), date: "2026-10-24" }, { run: path.join(directory, "two"), date: "2026-10-24" }]);
  assert.equal(view.coverage.totals.total, 6, "the same answers in another registered daily run are counted once");
  assert.equal(view.coverage.totals.completed, 1); assert.equal(view.coverage.dates[0].date, "2026-10-24");
  assert.equal(view.coverage.groups.length, 1);
  assert.equal(view.coverage.groups[0].total, 6, "date/mode groups retain trace deduplication across runs");
  assert.equal(view.coverage.groups[0].model, "aime_fast");
  assert.equal(view.coverage.groups[0].stages.find(stage=>stage.stage==="score")!.completed, 1);
  assert.equal(view.coverage.groups[0].stages.find(stage=>stage.stage==="attribution")!.completed, 3);
  assert.equal(await readFile(path.join(directory, "one/state.json"), "utf8"), before, "analytics cannot mutate progress or receipts");
  assert.equal(view.runs.length, 2, "run history remains independently inspectable");
  repeated.inputs.complete.version = "aime_expert";
  await writeJson(path.join(directory, "two/state.json"), repeated);
  await assert.rejects(answerReviewRunSummaries([{ run: path.join(directory, "one") }, { run: path.join(directory, "two") }]), /同一trace_id存在不同回答模型/);
});
