import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import {
  applyRunJournalDelta,
  isRunJournalProjection,
  appendProgressJournal,
  compactProgressJournal,
  CheckpointAdvancedError,
  readProgressJournal,
  runProgressFile,
  RunHotStore,
  runHotFile,
  runJournalIdentity,
} from "./run-journal.js";

const state = (): RunState => ({
  manifest: {
    format: "evaluation-run", debug: false, runId: "journal", status: "running",
    engine: { engine: "pi", version: "test", commit: "test", buildId: "test" },
    evaluatorVersion: "test", config: {}, tasks: [], inputs: {}, states: {}, preflight: {}, startedAt: 1,
  },
  receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
});

test("long user-selected output paths retain distinct durable hot journals without hashing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-hot-long-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = "/evaluation/" + "source/".repeat(40) + "console-run";
  const file = runHotFile(root, run);
  assert.notEqual(file, runHotFile(root, run + "-other"));
  assert(path.relative(root, file).split(path.sep).every(part => Buffer.byteLength(part) < 255));
  const hot = new RunHotStore(file, "long-output");
  hot.append({ at: 1 }); hot.close();
  const restored = new RunHotStore(file, "long-output");
  assert.equal(restored.eventsAfter().length, 1); restored.close();
});

test("progress enrichment permits only a previously absent exported reference", () => {
  const receipt = { taskId: "task", attemptId: "attempt", submissionId: "submission", evaluation: { ok: true },
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] },
    acceptedAt: 2, evaluatorVersion: "test", judge: "model", status: "succeeded" as const };
  const original = { at: 2, receipts: { task: receipt }, states: { task: { status: "succeeded" as const, attempts: 1 } } };
  const enriched = { ...original, receipts: { task: { ...receipt, exported: { file: "results.jsonl", id: "task", row: { ok: true } } } } };
  assert(isRunJournalProjection(original, enriched));
  assert(isRunJournalProjection(enriched, enriched));
  assert(!isRunJournalProjection(enriched, original), "projection cannot remove an existing result reference");
  assert(!isRunJournalProjection(enriched, { ...enriched, receipts: { task: { ...enriched.receipts.task,
    exported: { ...enriched.receipts.task.exported, id: "different" } } } }));
  assert(!isRunJournalProjection(original, { ...enriched, states: { task: { status: "failed", attempts: 1 } } }));
  assert(!isRunJournalProjection(original, { ...enriched, receipts: {} }));
});

test("progress replay advances a fresh or older hot store without reusing sequence numbers", () => {
  const hot = new RunHotStore(":memory:", "sequence-recovery");
  try {
    hot.setSequenceFloor(10);
    assert.equal(hot.append({ at: 1 }), 11);
    hot.setSequenceFloor(20);
    assert.equal(hot.append({ at: 2 }), 21);
    hot.setSequenceFloor(5);
    assert.equal(hot.append({ at: 3 }), 22);
  } finally { hot.close(); }
});

test("hot journal is durable, replayable and rejects cross-task submission id reuse", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-hot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = runHotFile(root, "/runs/source/run"), initial = state();
  const hot = new RunHotStore(file, runJournalIdentity(initial));
  hot.append({ at: 1, states: { task: { status: "running", attempts: 1 } } });
  hot.append({ at: 2, receipts: { task: {
    taskId: "task", attemptId: "attempt", submissionId: "submission", evaluation: { ok: true },
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceViews: [], traceReads: [], viewedImages: [], calculations: [], artifacts: [] },
    acceptedAt: 2, evaluatorVersion: "test", judge: "model", status: "succeeded",
  } } as never });
  assert.throws(() => hot.append({ at: 3, receipts: { other: {
    taskId: "other", attemptId: "attempt", submissionId: "submission", evaluation: { ok: true },
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
    acceptedAt: 3, evaluatorVersion: "test", judge: "model", status: "succeeded",
  } } }), /UNIQUE/);
  assert.equal(hot.outboxStats().count, 2);
  hot.close();

  const reopened = new RunHotStore(file, runJournalIdentity(initial));
  const replay = reopened.eventsAfter();
  assert.deepEqual(replay.map(event => event.seq), [1, 2]);
  for (const event of replay) applyRunJournalDelta(initial, event.event);
  assert.equal(initial.manifest.states.task!.status, "running");
  assert.equal(initial.receipts.task!.submissionId, "submission");
  reopened.markDelivered([1, 2]);
  assert.equal(reopened.outboxStats().count, 0);
  reopened.close();
});

test("outbox batches honor a byte budget so a large backlog cannot all enter memory", () => {
  const hot = new RunHotStore(":memory:", "byte-budget");
  try {
    hot.append({ at: 1, manifest: { inputCatalog: ["x".repeat(100_000)] } });
    hot.append({ at: 2, manifest: { inputCatalog: ["y".repeat(100_000)] } });
    assert.deepEqual(hot.pending(10, 150_000).map(event => event.seq), [1]);
    assert.deepEqual(hot.pending(10, 250_000).map(event => event.seq), [1, 2]);
  } finally { hot.close(); }
});

test("progress journal appends ordered events and replays only after the checkpoint sequence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [1, 2, 3].map(seq => ({ seq, event: {
    at: seq, states: { task: { status: seq === 3 ? "succeeded" as const : "running" as const, attempts: seq } },
  } }));
  await appendProgressJournal(root, events.slice(0, 2));
  await appendProgressJournal(root, events);
  assert.deepEqual((await readProgressJournal(root, 1)).map(event => event.seq), [2, 3]);
  await assert.rejects(appendProgressJournal(root, [
    { seq: 4, event: { at: 4 } }, { seq: 6, event: { at: 6 } },
  ]), /连续序号/);
});

test("checkpoint replay seeks backward across large UTF-8 rows without parsing covered history", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-progress-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = { at: 2, manifest: { config: { text: "评测".repeat(40_000) } } };
  await writeFile(runProgressFile(root), 'covered history\n' + JSON.stringify({ seq: 1, event: { at: 1 } }) + '\n' +
    JSON.stringify({ seq: 2, event }) + '\n' + JSON.stringify({ seq: 3, event: { at: 3 } }) + '\n');
  assert.deepEqual(await readProgressJournal(root, 1), [{ seq: 2, event }, { seq: 3, event: { at: 3 } }]);
  assert.deepEqual(await readProgressJournal(root, 3), []);
  await appendProgressJournal(root, [{ seq: 4, event: { at: 4 } }]);
  assert.deepEqual((await readProgressJournal(root, 2)).map(row => row.seq), [3, 4]);
});

test("checkpoint compaction keeps concurrent appends, rejects stale readers and leaves a small boundary at completion", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-progress-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = Array.from({ length: 30 }, (_, index) => ({ seq: index + 1, event: {
    at: index + 1, manifest: { config: { text: "完整恢复信息".repeat(index < 10 ? 10000 : 1) } },
  } }));
  await appendProgressJournal(root, events.slice(0, 10));
  const before = (await stat(runProgressFile(root))).size;
  await Promise.all([
    appendProgressJournal(root, events.slice(10, 20)),
    compactProgressJournal(root, 10),
    appendProgressJournal(root, events.slice(20)),
  ]);
  assert.deepEqual(await readProgressJournal(root, 10), events.slice(10));
  assert((await stat(runProgressFile(root))).size < before / 100);
  await assert.rejects(readProgressJournal(root, 9), CheckpointAdvancedError);
  await compactProgressJournal(root, 30);
  assert.deepEqual(await readProgressJournal(root, 30), []);
  assert((await stat(runProgressFile(root))).size < 100);
  const boundary = JSON.parse(await readFile(runProgressFile(root), "utf8"));
  assert.equal(boundary.seq, 30);
  assert.equal(boundary.event.checkpoint, true);
  await appendProgressJournal(root, [...events, { seq: 31, event: { at: 31 } }]);
  assert.deepEqual(await readProgressJournal(root, 30), [{ seq: 31, event: { at: 31 } }]);
});

test("compaction reads only the uncovered tail of an old large journal", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-progress-compact-tail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(runProgressFile(root), "covered bytes that must not be parsed\n".repeat(100000) +
    JSON.stringify({ seq: 100, event: { at: 100 } }) + "\n" + JSON.stringify({ seq: 101, event: { at: 101 } }) + "\n");
  await compactProgressJournal(root, 100);
  assert.deepEqual(await readProgressJournal(root, 100), [{ seq: 101, event: { at: 101 } }]);
  assert((await stat(runProgressFile(root))).size < 200);
});
