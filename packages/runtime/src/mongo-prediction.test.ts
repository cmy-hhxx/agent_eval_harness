import test from "node:test";
import assert from "node:assert/strict";
import { MongoClient, type Document } from "mongodb";
import type { PublicationInput, PublicationResult } from "@eval/contracts";
import { checkMongoPredictionSources, replaceMongoPredictionPublication } from "./mongo-publication.js";

const date = "2026-09-22", taskId = "remote-evaluation";
async function* rows<T>(values: T[]) { yield* values; }
function fixture() {
  const inputRows: PublicationInput[] = ["a_fast", "b_fast"].map(versionId => ({
    versionId, trace: { batch_id: date, case_id: "original-case", messages: [{ role: "user", content: "预测" }] },
  }));
  const row = {
    evaluation_purpose: "prediction", status: "decided", comparison_id: "new-result",
    prediction: { source_evaluation_task_id: taskId, source_comparison_id: "old-result" },
    case: { batch_id: date, case_id: "original-case" },
    models: { a_fast: { version: "A Fast", trace_id: "trace-a" }, b_fast: { version: "B Fast", trace_id: "trace-b" } },
    ranking: [["b_fast"], ["a_fast"]],
    assessments: { a_fast: { meets_core: false }, b_fast: { meets_core: true } },
    evaluations: { a_fast: { is_correct: false }, b_fast: { is_correct: true } },
    attribution_task_ids: { a_fast: "attribution-a", b_fast: "attribution-b" },
    verdicts: { a_fast__vs__b_fast: { result: "win", winner_version: "b_fast" } },
    decision_basis: { comparisons: [{ better_candidates: ["b_fast"], assessments: { a_fast: {}, b_fast: {} } }],
      decisive_findings: [{ candidate: "b_fast", finding_index: 0 }] },
    rewritten: { rewrites: [{ id: "assessment.B.summary", text: "预测命中" }] },
  };
  const stored: Document = { _id: `comparison:${taskId}:${date}:stored-case:a_fast:aa_fast`,
    kind: "comparison", evaluationTaskId: taskId, batchId: date, caseId: "stored-case",
    versionA: "a_fast", versionB: "aa_fast", evaluatedAt: new Date(1),
    result: { comparison: { comparison_id: "old-result", models: {
      a_fast: { trace_id: "trace-a" }, aa_fast: { trace_id: "trace-b" },
    } } } };
  const originalInputs = ["a_fast", "aa_fast"].map(versionId => ({
    _id: "input-" + versionId, versionId, trace: { case_id: "original-case" },
  }));
  let writes = 0;
  const collection = {
    find(query: Document) {
      assert.equal(query.batchId, date);
      if (query.kind === "input") {
        assert.deepEqual(query.versionId.$in, ["a_fast", "aa_fast"]);
        return { toArray: async () => structuredClone(originalInputs) };
      }
      assert.equal(query.kind, "comparison");
      const sought = query.$or[0]["result.comparison.comparison_id"];
      const found = stored.result.comparison.comparison_id === sought ||
        stored.result.comparison.prediction?.source_comparison_id === sought;
      return { toArray: async () => found ? [structuredClone(stored)] : [] };
    },
    async bulkWrite(operations: Document[], options: Document) {
      assert.equal(options.bypassDocumentValidation, undefined);
      for (const { updateOne: operation } of operations) {
        assert.equal(operation.filter._id, stored._id);
        assert.equal(operation.upsert, undefined);
        assert.equal(operation.update.$set.result.comparison.evaluation_purpose, "prediction");
        assert.deepEqual(Object.keys(operation.update.$set).sort(), ["evaluatedAt", "result"]);
        Object.assign(stored, structuredClone(operation.update.$set)); writes++;
      }
      return { isOk: () => true, matchedCount: operations.length, modifiedCount: operations.length };
    },
  } as unknown as Parameters<typeof replaceMongoPredictionPublication>[0];
  return { inputRows, row, stored, originalInputs, collection, writes: () => writes };
}
test("prediction replaces the exact existing document, binds model traces and never writes inputs", async t => {
  const f = fixture(), inputsBefore = structuredClone(f.originalInputs), originalId = f.stored._id;
  const publish = () => replaceMongoPredictionPublication(f.collection, taskId, date, rows(f.inputRows),
    rows([{ row: f.row, evaluatedAt: 100 }]), t.signal);
  assert.deepEqual(await publish(), { inputs: 0, comparisons: 1, inserted: 0, updated: 1 });
  assert.equal(f.stored._id, originalId);
  assert.equal(f.stored.evaluationTaskId, taskId);
  assert.deepEqual(f.originalInputs, inputsBefore);
  const result = f.stored.result.comparison;
  assert.deepEqual(Object.keys(result.models).sort(), ["a_fast", "aa_fast"]);
  assert.equal(result.evaluations.aa_fast.is_correct, true);
  assert.equal(result.verdict.winner_version, "aa_fast");
  assert.deepEqual(result.ranking, [["aa_fast"], ["a_fast"]]);
  assert.equal(result.decision_basis.decisive_findings[0].candidate, "aa_fast");
  assert.deepEqual(await publish(), { inputs: 0, comparisons: 1, inserted: 0, updated: 0 });
  assert.equal(f.writes(), 1);
});
test("prediction prevalidates the full set and refuses missing originals, foreign tasks and ambiguous answer traces", async t => {
  const f = fixture();
  const unknown: PublicationResult = { evaluatedAt: 101, row: { ...f.row,
    comparison_id: "other", prediction: { ...f.row.prediction, source_comparison_id: "missing" } } };
  await assert.rejects(replaceMongoPredictionPublication(f.collection, taskId, date, rows(f.inputRows),
    rows([{ row: f.row, evaluatedAt: 100 }, unknown]), t.signal), /one existing comparison/);
  assert.equal(f.writes(), 0);
  f.stored.evaluationTaskId = "different-experiment";
  await assert.rejects(replaceMongoPredictionPublication(f.collection, taskId, date, rows(f.inputRows),
    rows([{ row: f.row, evaluatedAt: 100 }]), t.signal), /identity differs/);
  delete f.stored.evaluationTaskId;
  await assert.rejects(replaceMongoPredictionPublication(f.collection, taskId, date, rows(f.inputRows),
    rows([{ row: f.row, evaluatedAt: 100 }]), t.signal), /repair original records/);
  f.stored.evaluationTaskId = taskId;
  f.row.models.b_fast.trace_id = "trace-a";
  await assert.rejects(replaceMongoPredictionPublication(f.collection, taskId, date, rows(f.inputRows),
    rows([{ row: f.row, evaluatedAt: 100 }]), t.signal), /traces are duplicated/);
  assert.equal(f.writes(), 0);
});

test("prediction preflight is read-only and blocks invalid destination identities before evaluation", async t => {
  const f = fixture();
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({
    listCollections: () => ({ hasNext: async () => true }),
    collection: () => ({ find: (query: Document) => {
      assert.deepEqual(query.$or[0]["result.comparison.comparison_id"].$in, ["old-result"]);
      return { toArray: async () => [structuredClone(f.stored)] };
    } }),
  }));
  const config = { uri: "mongodb://fixture", database: "test", collection: "test", evaluationTaskId: taskId };
  await checkMongoPredictionSources(config, date, ["old-result"], t.signal);
  delete f.stored.evaluationTaskId;
  await assert.rejects(checkMongoPredictionSources(config, date, ["old-result"], t.signal), /repair original records/);
  assert.equal(f.writes(), 0);
});
