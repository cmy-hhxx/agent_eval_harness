import test from "node:test";
import assert from "node:assert/strict";
import { BSON, MongoClient, type Document } from "mongodb";
import { readMongoLabels, writeMongoPublication } from "./mongo-publication.js";
import type { PublicationInput, PublicationResult } from "@eval/contracts";

async function* rows<T>(items: T[]) { yield* items; }
const date = "2026-09-30", evaluationTaskId = "remote-evaluation";
const inputs: PublicationInput[] = ["a_fast", "b_fast"].map((versionId) => ({ versionId,
  trace: { batch_id: date, case_id: "中文业务题号", version: versionId === "a_fast" ? "A Fast" : "B Fast",
    versions: "0930", task: "专题", messages: [{ role: "user", content: "问题" }], meta: { task: "分类" } },
}));
const result: PublicationResult = { evaluatedAt: 10000, row: {
  status: "decided", assessments: { a_fast: { meets_core: true }, b_fast: { meets_core: true } },
  case: { batch_id: date, case_id: "中文业务题号" }, comparison_id: "cmp-case", models: { a_fast: { version: "A组Fast" }, b_fast: { version: "B组Fast" } },
  verdicts: { a_fast__vs__b_fast: { result: "win", winner_version: "b_fast" } },
  rewritten: { rewrites: [{ id: "tradeoff", text: "改写后" }] },
} };
function fakeCollection(seed: Document[] = []) {
  const docs = new Map(seed.map((doc) => [doc._id, structuredClone(doc)]));
  let failNext = false, writes = 0;
  const collection = {
    find(query: Document) { return { toArray: async () => [...docs.values()].filter((doc) => doc.evaluationTaskId === query.evaluationTaskId && (query._id ? query._id.$in.includes(doc._id) : doc.batchId === query.batchId)).map((doc) => structuredClone(doc)) }; },
    async bulkWrite(operations: Document[], options: Document) {
      let upsertedCount = 0, modifiedCount = 0;
      for (const { updateOne: op } of operations) {
        assert.equal(op.filter.evaluationTaskId, evaluationTaskId);
        writes++;
        if (docs.has(op.filter._id)) {
          const doc = docs.get(op.filter._id)!;
          for (const [key, value] of Object.entries(op.update.$set)) {
            const parts = key.split(".");
            let target = doc;
            for (const part of parts.slice(0, -1)) target = target[part] ??= {};
            target[parts.at(-1)!] = structuredClone(value);
          }
          modifiedCount++;
        }
        else { docs.set(op.filter._id, structuredClone(op.update.$setOnInsert)); upsertedCount++; }
        assert.equal(options.bypassDocumentValidation, undefined);
        if (failNext) { failNext = false; throw new Error("Connection lost after first write"); }
      }
      return { isOk: () => true, upsertedCount, modifiedCount };
    },
  } as unknown as Parameters<typeof writeMongoPublication>[0];
  return { docs, collection, writes: () => writes, failOnce: () => { failNext = true; } };
}

test("comparison publication leaves a separately published attribution tree untouched", async () => {
  const tree = { _id: `attribution_tree:${evaluationTaskId}:${date}:b_post_train_fast:topic`, kind: "attribution_tree",
    evaluationTaskId, batchId: date, versionId: "b_post_train_fast", runId: "topic",
    evaluation_topic: "专题", createdAt: new Date(1), result: { attribution_tree: { nodes: [] } } };
  const db = fakeCollection([tree]);
  const counts = await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000));
  assert.equal(counts.inputs, 2); assert.equal(counts.comparisons, 1);
  assert.deepEqual(db.docs.get(tree._id), tree);
  assert.equal(db.docs.size, 4);
});

test("Mongo labels distinguish missing difficulty from an explicit empty value in stable time order", async (t) => {
  const documents = [
    { _id: "input:c", createdAt: new Date(2000), difficulty: "复杂" },
    { _id: "input:a", createdAt: new Date(1000), difficulty: "简单" },
    { _id: "input:b", createdAt: new Date(2000), difficulty: "中等" },
    { _id: "input:d", createdAt: new Date(3000), difficulty: undefined },
    { _id: "input:e", createdAt: new Date(4000), difficulty: "" },
  ];
  const signal = AbortSignal.timeout(5000);
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", () => ({
    listCollections: () => ({ hasNext: async () => true }),
    collection: () => ({
      find(query: Document, options: Document) {
        assert.deepEqual(query, { evaluationTaskId, kind: "input", batchId: { $in: [date] } });
        assert.equal(options.sort, undefined, "do not block the first cursor batch on a full-history server sort");
        assert.equal(options.signal, signal);
        assert.equal(options.timeoutMode, "iteration");
        assert.deepEqual(options.projection, { _id: 1, createdAt: 1, batchId: 1, "trace.case_id": 1,
          "trace.meta.case_id": 1, "trace.meta.task": 1, "trace.meta.difficulty": 1 });
        return { toArray: async () => documents.map(doc => ({ _id: doc._id, createdAt: doc.createdAt,
          batchId: date, trace: { case_id: "one", meta: { task: "分类", difficulty: doc.difficulty } } })) };
      },
    }),
  }));
  const config = { uri: "mongodb://localhost", database: "test", collection: "inputs", evaluationTaskId };
  const expected = ["简单", "中等", "复杂", undefined, ""].map(difficulty => ({ batchId: date, caseId: "one", task: "分类", difficulty }));
  assert.deepEqual(await readMongoLabels(config, [date], signal), expected);
  documents.reverse();
  assert.deepEqual(await readMongoLabels(config, [date], signal), expected);
  documents[0].createdAt = new Date(NaN);
  await assert.rejects(readMongoLabels(config, [date], signal), /valid createdAt/);
});

test("Mongo publication reuses business identity, preserves B/source fields and is idempotent after partial writes", async () => {
  const db = fakeCollection(); db.failOnce();
  const send = () => writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000));
  await assert.rejects(send(), /Connection lost/);
  const firstCaseId = [...db.docs.values()][0].caseId;
  const counts = await send();
  assert.equal(counts.inputs, 2); assert.equal(counts.comparisons, 1);
  assert.equal(db.docs.size, 3);
  assert([...db.docs.values()].every((doc) => doc.caseId === firstCaseId));
  assert([...db.docs.values()].every((doc) => doc.evaluationTaskId === evaluationTaskId));
  const b = [...db.docs.values()].find((doc) => doc.versionId === "b_fast")!;
  assert.deepEqual(b.trace, inputs[1].trace);
  const comparison = [...db.docs.values()].find((doc) => doc.kind === "comparison")!;
  assert.equal(comparison.versionB, "b_fast"); assert.equal(comparison.task, "专题");
  assert.equal(comparison.result.comparison.rewritten.rewrites[0].text, "改写后");
  const writes = db.writes(); await send(); assert.equal(db.writes(), writes);
  // An earlier uploader may stamp run completion rather than the last stage receipt.
  comparison.evaluatedAt = new Date(20000);
  await send(); assert.equal(db.writes(), writes);
  assert.equal(comparison.evaluatedAt.getTime(), 20000);
  const modified = structuredClone(inputs); modified[1].trace.versions = "new-release";
  assert.equal((await writeMongoPublication(db.collection, evaluationTaskId, date, rows(modified), rows([result]), AbortSignal.timeout(5000))).updated, 1);
  assert.equal(db.docs.size, 3);
});

test("ordinary retries cannot overwrite a published prediction result", async () => {
  const db = fakeCollection();
  const send = () => writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000));
  await send();
  const stored = [...db.docs.values()].find(doc => doc.kind === "comparison")!;
  stored.result.comparison.evaluation_purpose = "prediction";
  stored.result.comparison.comparison_id = "accepted-prediction";
  const before = structuredClone(stored), writes = db.writes();
  await send();
  assert.deepEqual(stored, before);
  assert.equal(db.writes(), writes);
});

test("an older uploader cannot replace newly accepted rewrite text", async () => {
  const db = fakeCollection(), signal = AbortSignal.timeout(5000);
  const original = structuredClone(result); delete original.row.rewritten;
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([original]), signal);
  const polished = { ...result, evaluatedAt: result.evaluatedAt + 1000 };
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([polished]), signal);
  const before = structuredClone([...db.docs.values()]), writes = db.writes();
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([original]), signal);
  assert.deepEqual([...db.docs.values()], before);
  assert.equal(db.writes(), writes);
});

test("result-only delivery uses projected existing inputs but cannot create incomplete input documents", async () => {
  const db = fakeCollection(), signal = AbortSignal.timeout(5000);
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([]), signal);
  const projected = inputs.map(input => ({ ...input, trace: { ...input.trace } }));
  for (const input of projected) delete input.trace.messages;
  const before = structuredClone([...db.docs.values()]);
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(projected), rows([result]), signal, true);
  assert.deepEqual([...db.docs.values()].filter(doc => doc.kind === "input"), before);
  await assert.rejects(writeMongoPublication(fakeCollection().collection, evaluationTaskId, date,
    rows(projected), rows([result]), signal, true), /Invalid publication input/);
});

test("topic publication labels existing inputs without rewriting traces and labels every new result", async () => {
  const db = fakeCollection(), signal = AbortSignal.timeout(5000), topic = "后训练三模型专题评测（2026-10-19）";
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([result]), signal);
  const input = [...db.docs.values()].find(doc => doc.kind === "input")!;
  input.trace.meta.difficulty = "人工标注";
  const before = structuredClone([...db.docs.values()]);
  const operations: Document[] = [];
  const collection = { ...db.collection, bulkWrite: async (...args: Parameters<typeof db.collection.bulkWrite>) => {
    operations.push(...args[0]);
    return db.collection.bulkWrite(...args);
  } };
  const send = () => writeMongoPublication(collection, evaluationTaskId, date, rows(inputs), rows([result]), signal, true, topic);
  assert.equal((await send()).updated, 3);
  for (const doc of db.docs.values()) {
    assert.equal(doc.kind === "input" ? doc.trace.meta.evaluation_topic : doc.result.comparison.evaluation_topic, topic);
    assert.equal(doc.caseId, before.find(prior => prior._id === doc._id)!.caseId);
  }
  assert.equal(input.trace.meta.difficulty, "人工标注");
  assert(operations.filter(op => op.updateOne.filter._id.startsWith("input:"))
    .every(op => Object.keys(op.updateOne.update.$set).join() === "trace.meta.evaluation_topic"));
  assert.equal((await send()).updated, 0);
  const fresh = fakeCollection();
  await writeMongoPublication(fresh.collection, evaluationTaskId, date, rows(inputs), rows([result]), signal, false, topic);
  assert([...fresh.docs.values()].every(doc =>
    (doc.kind === "input" ? doc.trace.meta.evaluation_topic : doc.result.comparison.evaluation_topic) === topic));
});

test("Mongo publication preserves all six model IDs and resumes every same-tier pair without duplicate writes", async () => {
  const groups = [["a_fast", "b_fast", "6_luna"], ["a_expert", "b_expert", "6.1sol"]];
  const sixInputs = groups.flat().map(versionId => ({ ...inputs[0], versionId,
    trace: { ...inputs[0].trace, version: versionId } }));
  const pairs = groups.flatMap(group => group.flatMap((left, index) => group.slice(index + 1).map(right => [left, right])));
  const results = pairs.map(pair => ({ ...result, row: { ...result.row,
    models: Object.fromEntries(pair.map(id => [id, { version: id }])),
    assessments: Object.fromEntries(pair.map(id => [id, { meets_core: true }])),
    verdicts: { [pair.join("__vs__")]: { result: "win", winner_version: pair[0] } },
  } }));
  const db = fakeCollection();
  const send = () => writeMongoPublication(db.collection, evaluationTaskId, date, rows(sixInputs), rows(results), AbortSignal.timeout(5000));
  const counts = await send();
  assert.equal(counts.inputs, 6);
  assert.equal(counts.comparisons, 6);
  assert.equal(db.docs.size, 12);
  assert.deepEqual(new Set([...db.docs.values()].filter(doc => doc.kind === "input").map(doc => doc.versionId)), new Set(groups.flat()));
  assert.equal(new Set([...db.docs.values()].map(doc => doc.caseId)).size, 1);
  const writes = db.writes();
  await send();
  assert.equal(db.writes(), writes);
  for (const versionId of ["../escape", "a..b", "", "bad/id"])
    await assert.rejects(writeMongoPublication(db.collection, evaluationTaskId, date, rows([{ ...inputs[0], versionId }]), rows([]), AbortSignal.timeout(5000)));
});

test("Mongo publication accepts original prose, rejects malformed rewrites and conflicting case identities", async () => {
  const db = fakeCollection();
  const incomplete = structuredClone(result); delete incomplete.row.rewritten;
  const delivered = await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([incomplete]), AbortSignal.timeout(5000));
  assert.equal(delivered.comparisons, 1);
  assert(!Object.hasOwn([...db.docs.values()].find(item => item.kind === "comparison")!.result.comparison, "rewritten"));
  for (const malformed of [null, {}, { rewrites: [] }])
    await assert.rejects(writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([{ ...incomplete,
      row: { ...incomplete.row, rewritten: malformed } }]), AbortSignal.timeout(5000)), /Invalid comparison rewrite/);
  assert.equal([...db.docs.values()].filter(doc => doc.kind === "comparison").length, 1);
  const conflict = fakeCollection(inputs.map((input, i) => ({ _id: String(i), kind: "input", evaluationTaskId, batchId: date, caseId: "case-" + i, trace: input.trace })));
  await assert.rejects(writeMongoPublication(conflict.collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000)), /Conflicting/);
  assert.equal(conflict.writes(), 0);
});

test("Mongo publication accepts a registered baseline input and keeps paired external documents", async () => {
  const db = fakeCollection();
  const baseline = { ...inputs[1], versionId: "baseline", trace: { ...inputs[1].trace, version: "Baseline" } };
  const paired = { ...result, row: { ...result.row, models: { a_fast: { version: "A Fast" }, baseline: { version: "Baseline" } },
    assessments: { a_fast: { meets_core: true }, baseline: { meets_core: true } },
    verdicts: { a_fast__vs__baseline: { result: "win", winner_version: "baseline" } } } };
  const counts = await writeMongoPublication(db.collection, evaluationTaskId, date, rows([inputs[0], baseline]), rows([paired]), AbortSignal.timeout(5000));
  assert.equal(counts.inputs, 2); assert.equal(counts.comparisons, 1);
  const stored = [...db.docs.values()].find((doc) => doc.kind === "comparison")!;
  assert.equal(stored.versionA, "a_fast"); assert.equal(stored.versionB, "baseline");
  assert.equal(stored.result.comparison.models.baseline.display_name, "Baseline");
  const missing = fakeCollection();
  await assert.rejects(writeMongoPublication(missing.collection, evaluationTaskId, date, rows([inputs[0]]), rows([paired]), AbortSignal.timeout(5000)), /paired input/);
});

test("Mongo publication rejects review rows and conflicting core assessments for a repeated answer", async () => {
  for (const row of [{ ...result.row, status: "needs_review" },
    { ...result.row, evaluation_type: "comparison_review" }]) {
    const db = fakeCollection();
    await assert.rejects(writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([{ ...result, row }]), AbortSignal.timeout(5000)), /decided/);
    assert([...db.docs.values()].every((doc) => doc.kind === "input"));
  }
  const db = fakeCollection(), baseline = { ...inputs[1], versionId: "baseline", trace: { ...inputs[1].trace, version: "Baseline" } };
  const first = { ...result, row: { ...result.row, status: "decided", assessments: { a_fast: { meets_core: true }, b_fast: { meets_core: true } } } };
  const second = { ...result, row: { ...result.row, status: "decided", models: { a_fast: {}, baseline: {} },
    assessments: { a_fast: { meets_core: false }, baseline: { meets_core: true } },
    verdicts: { a_fast__vs__baseline: { result: "win", winner_version: "baseline" } },
  } };
  await assert.rejects(writeMongoPublication(db.collection, evaluationTaskId, date, rows([...inputs, baseline]), rows([first, second]), AbortSignal.timeout(5000)), /Conflicting answer core/);
  assert([...db.docs.values()].every((doc) => doc.kind === "input"));
});

test("large traces are read and written in bounded batches instead of timing out on 100 documents", async () => {
  const db = fakeCollection();
  const large = Array.from({ length: 12 }, (_, i) => ({ ...inputs[0], trace: { ...inputs[0].trace,
    case_id: `large-${i}`, messages: [{ role: "user", content: "x".repeat(400_000) }] } }));
  const find = db.collection.find.bind(db.collection), bulkWrite = db.collection.bulkWrite.bind(db.collection);
  const reads: number[] = [], writes: number[] = [];
  const collection = {
    find(query: Document, options: Document) {
      if (query._id) {
        const bytes = query._id.$in.length * 401_000;
        reads.push(bytes);
        if (bytes > 2 * 1024 * 1024) throw new Error("Timed out during socket read: oversized trace batch");
      }
      return find(query, options);
    },
    bulkWrite(operations: Document[], options: Document) {
      const bytes = operations.reduce((sum, op) => sum + BSON.calculateObjectSize(op), 0);
      writes.push(bytes);
      assert(bytes < 2 * 1024 * 1024);
      return bulkWrite(operations as never, options);
    },
  } as unknown as Parameters<typeof writeMongoPublication>[0];
  const send = () => writeMongoPublication(collection, evaluationTaskId, date, rows(large), rows([]), AbortSignal.timeout(5000));
  assert.equal((await send()).inserted, 12);
  assert.equal((await send()).inserted, 0);
  assert(reads.length >= 6); assert(writes.length >= 3);
});

test("settled inputs are not reread on output-only deliveries, while missing inputs and source changes are synced", async () => {
  const db = fakeCollection();
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([]), AbortSignal.timeout(5000));
  const find = db.collection.find.bind(db.collection);
  const collection = { ...db.collection, find(query: Document, options: Document) {
    if (query._id) assert(query._id.$in.every((id: string) => id.startsWith("comparison:")));
    return find(query, options);
  } } as unknown as Parameters<typeof writeMongoPublication>[0];
  assert.equal((await writeMongoPublication(collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000), true)).inserted, 1);
  const id = [...db.docs.values()].find((doc) => doc.versionId === "b_fast")!._id;
  db.docs.delete(id);
  assert.equal((await writeMongoPublication(db.collection, evaluationTaskId, date, rows(inputs), rows([result]), AbortSignal.timeout(5000), true)).inserted, 1);
  const changed = structuredClone(inputs); changed[0].trace.messages = [{ role: "user", content: "updated" }];
  assert.equal((await writeMongoPublication(db.collection, evaluationTaskId, date, rows(changed), rows([]), AbortSignal.timeout(5000))).updated, 1);
});

test("refreshing raw inputs preserves task and difficulty annotations added in Mongo", async () => {
  const db = fakeCollection();
  const unlabelled = structuredClone(inputs);
  unlabelled.forEach((input) => { input.trace.meta = { usage: { input_tokens: 10 } }; });
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(unlabelled), rows([]), AbortSignal.timeout(5000));
  for (const stored of db.docs.values()) Object.assign(stored.trace.meta, { task: "数据查询类", difficulty: "简单" });
  unlabelled.forEach((input) => { input.trace.versions = "updated"; });
  const counts = await writeMongoPublication(db.collection, evaluationTaskId, date, rows(unlabelled), rows([]), AbortSignal.timeout(5000));
  assert.equal(counts.updated, 2);
  for (const stored of db.docs.values()) {
    assert.equal(stored.trace.versions, "updated");
    assert.equal(stored.trace.meta.task, "数据查询类");
    assert.equal(stored.trace.meta.difficulty, "简单");
    assert.deepEqual(stored.trace.meta.usage, { input_tokens: 10 });
  }
  assert.equal(unlabelled[0].trace.meta && (unlabelled[0].trace.meta as Record<string, unknown>).task, undefined);
  const writes = db.writes();
  await writeMongoPublication(db.collection, evaluationTaskId, date, rows(unlabelled), rows([]), AbortSignal.timeout(5000));
  assert.equal(db.writes(), writes);
  unlabelled[0].trace.meta = { task: "统计回测建模计算", difficulty: "中等" };
  assert.equal((await writeMongoPublication(db.collection, evaluationTaskId, date, rows(unlabelled), rows([]), AbortSignal.timeout(5000))).updated, 1);
  assert.equal([...db.docs.values()].find((doc) => doc.versionId === "a_fast")!.trace.meta.task, "统计回测建模计算");
});

test("Mongo cursor reads have individual deadlines and carry cancellation, including multi-megabyte single traces", async () => {
  const db = fakeCollection(), controller = new AbortController(), find = db.collection.find.bind(db.collection);
  const collection = { ...db.collection, find(query: Document, options: Document) {
    assert.equal(options.timeoutMode, "iteration");
    assert.equal(options.signal, controller.signal);
    assert(options.timeoutMS >= 30_000);
    if (query._id) assert.equal(options.batchSize, 1);
    return find(query, options);
  } } as unknown as Parameters<typeof writeMongoPublication>[0];
  const large = structuredClone(inputs[0]); large.trace.messages = [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }];
  assert.equal((await writeMongoPublication(collection, evaluationTaskId, date, rows([large]), rows([]), controller.signal)).inserted, 1);
  controller.abort();
  await assert.rejects(writeMongoPublication(collection, evaluationTaskId, date, rows(inputs), rows([]), controller.signal), /aborted/);
});
