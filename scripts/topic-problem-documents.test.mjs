import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { attributionTreeDocument } from "./attribution-tree-document.mjs";
import { topicProblemDocuments, topicProblemChanges } from "./topic-problem-documents.mjs";

function fixture() {
  const model = "b_post_train_fast", input = "00000000-0000-4000-8000-000000000001";
  const source = { model, input_id: input, batch_id: "2026-10-19", case_id: "case", task_id: "task",
    submission_id: "accepted", evaluator_version: "judge", run_id: "source" };
  const observation = { sampleId: "sample", findingId: "f1", summary: "已改写摘要", components: ["模型自身推理"],
    evidenceStatus: "established", importance: "high", libraryStatus: "classified", findingLibraryStatus: "classified" };
  const tree = { models: [{ id: model }], nodes: [{ id: "class1", model, category: "模型自身推理", label: "新类名",
    definition: "新定义", observations: [observation] }], unfinished: [], pending: { observations: [] },
    samples: [{ id: "sample", inputId: input, taskId: "task", model, date: source.batch_id, caseId: "case",
      taskSummary: "任务摘要", problemCount: 1 }], totals: { samples: 1, targetSamples: 1, unfinishedSamples: 0, problems: 1 } };
  const record = attributionTreeDocument({ evaluationTaskId: "remote-post-training-evaluation", versionId: model,
    batchId: source.batch_id, runId: "topic-run", topic: "后训练三模型专题评测（2026-10-19）",
    createdAt: "2026-10-21T00:00:00Z", tree, sources: [source], clustering: { jobs: [{ run_id: "topic-run", evaluator_version: "judge",
      source_input_ids: [input], submissions: [{ task_id: "cluster", stage: "clustering", submission_id: "cluster-accepted", evaluator_version: "judge" }] }] } });
  return { record, scope: { kind: "full-evaluation", capturedAt: record.createdAt, sourceEvaluationComplete: true,
    targetAttributions: 1, acceptedAttributions: 1, excludedAttributions: 0 },
    library: { model, components: { component: { label: "模型自身推理" } }, classes: { class1: {
      status: "active", component_id: "component", category_paths: [["计算错误"]], label: "原类名", definition: "原定义" } } },
    inputs: { [input]: { version: model, batch_id: source.batch_id, case_id: "case", trace_id: "original-session" } },
    attributions: new Map([["task", { task_id: "task", submission_id: "accepted", evaluator_version: "judge",
      input_id: input, version: model, case: { batch_id: source.batch_id, case_id: "case" }, evaluation: { findings: [
        { type: "problem", finding_id: "f1", text: "原文", reason: "原因", importance: "high",
          assessment: { evidence_status: "established" }, problem: { component: ["模型自身推理"] },
          evidence: [{ message_index: 1, quote: "本模型证据" }] }] } }]]) };
}

test("topic projection keeps rewritten summaries, original evidence and exact model receipt", () => {
  const documents = topicProblemDocuments(fixture()), sample = documents[1];
  assert.equal(documents[0].direction, "计算错误");
  assert.equal(documents[0].originalLabel, "原类名");
  assert.equal(sample.findings[0].summary, "已改写摘要");
  assert.equal(sample.findings[0].text, "原文");
  assert.equal(sample.source.submissionId, "accepted");
  assert.equal(sample.traceId, "original-session");
  assert.equal(sample.replay, null);
  assert.equal(sample.scope.sourceEvaluationComplete, true);
  assert.equal(sample.scope.acceptedAttributions, 1);
});

test("incremental topic publication updates the same identities and retires only merged classes", () => {
  const f = fixture(), previous = topicProblemDocuments(f), documents = structuredClone(previous);
  documents.forEach(doc => { doc.scope.capturedAt = "2026-10-21T01:00:00Z"; });
  documents.push({ ...structuredClone(documents[1]), _id: "new-sample", id: "new-input" });
  const changes = topicProblemChanges(previous, documents, f.library);
  assert.equal(changes.replace.length, 2); assert.equal(changes.insert.length, 1); assert.equal(changes.remove.length, 0);
  assert.equal(topicProblemChanges(documents, documents, f.library).unchanged, 3);
  assert.throws(() => topicProblemChanges(previous, documents.filter(doc => doc.kind === "sample"), f.library), /omit/);
  f.library.classes.class1.status = "merged";
  assert.equal(topicProblemChanges(previous, documents.filter(doc => doc.kind === "sample"), f.library).remove.length, 1);
  for (const mutate of [docs => { docs[1].source.submissionId = "changed"; },
    docs => { docs[1].model = "b_fast"; }, docs => { docs.splice(1, 1); }]) {
    const next = structuredClone(documents); mutate(next);
    assert.throws(() => topicProblemChanges(previous, next, f.library));
  }
  assert.throws(() => topicProblemChanges(documents, previous, f.library), /snapshot time/);
});

test("cutoff topic records explicitly mark unfinished source evaluation", () => {
  const f = fixture();
  f.scope = { ...f.scope, kind: "accepted-at-cutoff", sourceEvaluationComplete: false,
    targetAttributions: 3, excludedAttributions: 2 };
  for (const doc of topicProblemDocuments(f)) {
    assert.equal(doc.scope.kind, "accepted-at-cutoff");
    assert.equal(doc.scope.sourceEvaluationComplete, false);
    assert.equal(doc.scope.acceptedAttributions, 1);
    assert.equal(doc.scope.excludedAttributions, 2);
  }
});

test("topic projection rejects stale, wrong-model and cross-answer evidence", () => {
  for (const mutate of [
    f => { f.attributions.get("task").version = "b_fast"; },
    f => { f.attributions.get("task").submission_id = "stale"; },
    f => { f.attributions.get("task").evaluation.findings[0].evidence[0].source_input_id = "competitor"; },
    f => { f.library.classes.class1.category_paths = []; },
    f => { f.scope.sourceEvaluationComplete = false; },
    f => { f.scope.acceptedAttributions = 2; },
    f => { f.scope.targetAttributions = 2; },
    f => { f.record.result.attribution_tree.samples[0].problemCount = 2; },
  ]) { const data = fixture(); mutate(data); assert.throws(() => topicProblemDocuments(data)); }
});

test("unlocated findings remain explicit pending samples without a fabricated class", () => {
  const input = fixture(), tree = input.record.result.attribution_tree;
  const observation = tree.nodes[0].observations[0];
  tree.nodes = [];
  tree.pending.observations = [{ ...observation, components: [], libraryStatus: "unlocated", findingLibraryStatus: "unlocated" }];
  input.attributions.get("task").evaluation.findings[0].problem.component = [];
  const docs = topicProblemDocuments(input);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, "sample");
  assert.equal(docs[0].findings[0].status, "unlocated");
  assert.deepEqual(docs[0].findings[0].pendingStatuses, ["unlocated"]);
  assert.deepEqual(docs[0].findings[0].classIds, []);
});

test("problem collection schema requires topic labels and keeps existing model branches isolated", async () => {
  const schema = JSON.parse(await readFile(new URL("../schemas/workflow/mongo-problems.validator.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addKeyword({ keyword: "bsonType", validate(type, value) {
    return (Array.isArray(type) ? type : [type]).some(kind => kind === "null" ? value === null :
      kind === "array" ? Array.isArray(value) : kind === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
      kind === "bool" ? typeof value === "boolean" : ["int", "long", "double"].includes(kind) ? typeof value === "number" : typeof value === kind);
  } });
  const valid = ajv.compile(schema.$jsonSchema);
  for (const cutoff of [false, true]) for (const v2 of [false, true]) {
    const f = fixture();
    if (v2) {
      f.record.evaluationTaskId = "remote-post-training-evaluation-v2";
      f.record.evaluation_topic = "后训练 v2 双模型专项评测（2026-10-19，678对）";
    }
    if (cutoff) Object.assign(f.scope, { kind: "accepted-at-cutoff", sourceEvaluationComplete: false });
    for (const doc of topicProblemDocuments(f)) {
      assert(valid(doc), JSON.stringify(valid.errors));
      const missing = structuredClone(doc); delete missing.evaluation_topic;
      assert(!valid(missing)); assert(!valid({ ...doc, model: "b_fast" }));
      assert(!valid({ ...doc, evaluationTaskId: "invalid task/id" }));
      assert(!valid({ ...doc, evaluation_topic: "" }));
      assert(!valid({ ...doc, batchId: "not-a-date" }));
      assert(!valid({ ...doc, scope: { ...doc.scope, sourceEvaluationComplete: cutoff } }));
      const existing = structuredClone(doc);
      for (const key of ["evaluationTaskId", "evaluation_topic", "batchId", "runId", "scope"]) delete existing[key];
      if (existing.kind === "sample") existing.id = "a".repeat(64);
      assert(valid(existing), "Existing unscoped model records must remain valid: " + JSON.stringify(valid.errors));
    }
  }
});
