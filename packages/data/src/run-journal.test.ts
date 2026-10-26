import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import {
  applyRunJournalDelta,
  appendProgressJournal,
  readProgressJournal,
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

test("progress journal appends ordered events and replays only after the checkpoint sequence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [1, 2, 3].map(seq => ({ seq, event: {
    at: seq, states: { task: { status: seq === 3 ? "succeeded" as const : "running" as const, attempts: seq } },
  } }));
  await appendProgressJournal(root, events.slice(0, 2));
  await appendProgressJournal(root, events);
  assert.deepEqual((await readProgressJournal(root, 1)).map(event => event.seq), [2, 3]);
});
