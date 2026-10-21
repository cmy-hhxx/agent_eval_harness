import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { attributionTreeDocument } from "./attribution-tree-document.mjs";

function fixture() {
  const source = { model: "b_post_train_fast", batch_id: "2026-10-19", case_id: "case-1", input_id: "input",
    task_id: "attribution", submission_id: "accepted", evaluator_version: "judge", run_id: "source" };
  return { evaluationTaskId: "remote-post-training-evaluation", batchId: source.batch_id,
    versionId: source.model, runId: "post-topic", topic: "后训练专题", createdAt: "2026-10-21T00:00:00Z",
    tree: { models: [{ id: source.model }], nodes: [], unfinished: [],
      samples: [{ id: "sample", inputId: "input", model: source.model, date: source.batch_id,
        caseId: source.case_id, taskId: source.task_id, problemCount: 1 }],
      pending: { observations: [{ sampleId: "sample", findingId: "finding" }] },
      totals: { targetSamples: 1, samples: 1, unfinishedSamples: 0, problems: 1 } },
    sources: [source], clustering: { jobs: [{ run_id: "post-topic", evaluator_version: "judge", source_input_ids: [source.input_id],
      submissions: [{ task_id: "clustering", stage: "clustering", submission_id: "cluster-accepted", evaluator_version: "judge" }] }] } };
}

test("manual tree document keeps topic, single-model sources and unclustered observations", () => {
  const input = fixture(), record = attributionTreeDocument(input);
  assert.equal(record._id, "attribution_tree:remote-post-training-evaluation:2026-10-19:b_post_train_fast:post-topic");
  assert.equal(record.kind, "attribution_tree"); assert.equal(record.evaluation_topic, input.topic);
  assert.deepEqual(record.result.sources, input.sources);
  assert.deepEqual(record.result.attribution_tree.pending, input.tree.pending);
});

test("manual tree publication rejects incomplete coverage, mixed identities and unbound findings", () => {
  const mutations = [
    f => { f.tree.unfinished.push({}); },
    f => { f.tree.models.push({ id: "a_fast" }); },
    f => { f.sources[0].model = "a_fast"; },
    f => { f.sources.push(structuredClone(f.sources[0])); },
    f => { f.tree.samples[0].taskId = "another-task"; },
    f => { f.tree.pending.observations[0].sampleId = "missing"; },
    f => { f.tree.totals.problems = 2; },
    f => { f.sources[0].submission_id = ""; },
    f => { f.clustering.jobs[0].submissions.push(structuredClone(f.clustering.jobs[0].submissions[0])); },
    f => { f.clustering.jobs.push(structuredClone(f.clustering.jobs[0])); },
    f => { f.clustering.jobs[0].source_input_ids = ["missing"]; },
    f => { f.clustering.jobs[0].submissions[0].stage = "attribution"; },
    f => { f.topic = ""; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => attributionTreeDocument(input)); }
});

test("a final tree preserves separate original and delta clustering receipt provenance", () => {
  const input = fixture(), source = { ...input.sources[0], input_id: "input-2", task_id: "attribution-2" };
  input.sources.push(source);
  input.tree.samples.push({ ...input.tree.samples[0], id: "sample-2", inputId: source.input_id, taskId: source.task_id });
  input.tree.pending.observations.push({ sampleId: "sample-2", findingId: "finding" });
  input.tree.totals = { targetSamples: 2, samples: 2, unfinishedSamples: 0, problems: 2 };
  input.clustering.jobs.push({ run_id: "post-topic-delta", evaluator_version: "judge-new", source_input_ids: [source.input_id],
    submissions: [{ task_id: "delta-task", stage: "clustering", submission_id: "delta-accepted", evaluator_version: "judge-new" }] });
  assert.deepEqual(attributionTreeDocument(input).result.clustering, input.clustering);
  input.clustering.jobs[1].source_input_ids = [input.sources[0].input_id];
  assert.throws(() => attributionTreeDocument(input), /cover the accepted sources exactly/);
});

test("Mongo's document schema separates trees from existing inputs and comparisons", async () => {
  const validator = JSON.parse(await readFile(new URL("../schemas/workflow/mongo-publication.validator.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addKeyword({ keyword: "bsonType", validate(type, value) {
    return (Array.isArray(type) ? type : [type]).some(kind => kind === "date" ? value instanceof Date :
      kind === "null" ? value === null : kind === "array" ? Array.isArray(value) :
      kind === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) :
      typeof value === kind);
  } });
  const valid = ajv.compile(validator.$and[0].$jsonSchema);
  const tree = { ...attributionTreeDocument(fixture()), createdAt: new Date(1) };
  assert(valid(tree), JSON.stringify(valid.errors));
  const noTopic = { ...tree }; delete noTopic.evaluation_topic;
  assert(!valid(noTopic));
  assert(!valid({ ...tree, kind: "comparison" }));
  assert(!valid({ ...tree, versionA: "a_fast" }));
  const common = { evaluationTaskId: "task", batchId: "date", caseId: "case", createdAt: new Date(1) };
  assert(valid({ ...common, _id: "input:task:date:case:a", kind: "input", versionId: "a", trace: {} }));
  assert(valid({ ...common, _id: "comparison:task:date:case:a:b", kind: "comparison",
    versionA: "a", versionB: "b", result: {}, evaluatedAt: new Date(1) }));
  assert(!valid({ ...common, _id: "input:task:date:case:a", kind: "input", versionId: "a", trace: {}, result: {} }));
});
