import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import { writeJsonl } from "@eval/data";
import type { Candidate } from "@eval/workflows/inputs";
import { fixtureConfig, raw, emptyAudit, fakeIdentity, fakeEvaluatorVersion, attributionResult } from "../../../../tests/fixtures/comparison.js";
import { answerReviewRepository, answerReviewWorkflow, planAnswerReview, type AnswerReviewConfig } from "./index.js";

async function fixture(t: TestContext) {
  const rows = [raw("accepted"), raw("pending")];
  const f = await fixtureConfig([rows, [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config: AnswerReviewConfig = { ...f.config, workflow: "answer-review", reviewStages: ["attribution"], inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } };
  const plan = await planAnswerReview(config), run = path.join(config.output.path, "resume");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "resume", status: "interrupted",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const accepted = plan.tasks.find(task => (task.data as { candidate: Candidate }).candidate.case_id === "accepted")!;
  state.receipts[accepted.id] = { taskId: accepted.id, attemptId: randomUUID(), submissionId: randomUUID(),
    evaluatorVersion: fakeEvaluatorVersion, judge: "fixture", status: "succeeded", acceptedAt: 1,
    evaluation: attributionResult(true,"2+2=4",true,accepted.inputIds.answer), audit: emptyAudit(), usage: emptyUsage() };
  state.manifest.states[accepted.id] = { status: "succeeded", attempts: 1 };
  await answerReviewRepository.createResultWriter(run, plan.inputs)(state);
  await answerReviewRepository.writeRun(run, state);
  return { ...f, config, plan, run, rows, accepted, state: await answerReviewRepository.readRun(run) };
}

test("resume refreshes unfinished source coordinates and material without changing accepted results or refunding attempts", async t => {
  const f = await fixture(t), before = structuredClone(f.state.receipts);
  const pending = f.state.manifest.tasks.find(task => task.id !== f.accepted.id)!;
  const inputId = pending.inputIds.answer;
  f.state.manifest.states[pending.id] = { status: "failed", attempts: 2, failure: {
    contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "prior", errors: [],
    draft: { summary: "旧稿" }, review: { quotes: [], sources: [], actions: [], viewed: [], searches: [] },
  } };
  const updated = structuredClone(f.rows[1]);
  updated.messages[0].content = "计算3+3";
  updated.messages.splice(1, 0, { type: "reasoning", content: "中间推理，不是最终回答。" });
  updated.messages[2].content = "6";
  await writeJsonl(f.config.inputs.versions[0].sources[0].path, [updated, f.rows[0]]);
  const plan = await answerReviewWorkflow.reconcile!(f.run, f.state, f.config);
  const material = answerReviewWorkflow.bind(pending,plan.inputs,{}, {tasks:plan.tasks}).request.input.answer as {final_answer:string;question:string};
  assert.equal(material.final_answer, "6");
  assert.equal(material.question, "计算3+3");
  const candidate = (pending.data as { candidate: Candidate }).candidate;
  assert.equal(candidate.final_index, 2);
  assert.equal(candidate.line, 1);
  assert.equal(candidate.input_id, inputId);
  const progress = f.state.manifest.states[pending.id];
  assert.equal(progress.attempts, 2);
  assert.equal(progress.failure?.contentSubmissions, 1);
  assert.equal(progress.failure?.draft, undefined);
  assert.equal(progress.failure?.review, undefined);
  await answerReviewRepository.createResultWriter(f.run, plan.inputs)(f.state);
  assert.deepEqual(f.state.receipts, before);
});

test("resume adds newly selected Score and Rewrite tasks once while preserving accepted Attribution", async t => {
  const f = await fixture(t), before = structuredClone(f.state.receipts);
  f.state.manifest.executionScope = [f.accepted.id];
  const score: AnswerReviewConfig = { ...f.config, reviewStages: ["score"] };
  await answerReviewWorkflow.reconcile!(f.run, f.state, score);
  const selected = () => f.state.manifest.tasks.filter(task => f.state.manifest.executionScope!.includes(task.id));
  assert.deepEqual(selected().map(task => task.stage), ["score"]);
  assert.equal((selected()[0].data as { candidate: Candidate }).candidate.case_id, "accepted", "retain pilot answer selection");
  const scoreId = selected()[0].id;
  await answerReviewWorkflow.reconcile!(f.run, f.state, score);
  assert.deepEqual(selected().map(task => task.id), [scoreId]);
  await answerReviewWorkflow.reconcile!(f.run, f.state, { ...f.config, rewrite: { ...f.config.rewrite, attribution: true } });
  assert.deepEqual(selected().map(task => task.stage).sort(), ["attribution", "rewrite"]);
  assert.equal(selected().find(task => task.stage === "rewrite")!.dependencies.source, f.accepted.id);
  assert.deepEqual(f.state.receipts, before);
  delete f.state.manifest.executionScope;
  await answerReviewWorkflow.reconcile!(f.run, f.state, { ...f.config, reviewStages: undefined });
  assert.equal(selected().filter(task => task.stage === "score").length, 2, "releasing scope includes every registered answer");
});
