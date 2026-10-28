import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProgressJournal, runLock } from "@eval/data";
import { compactRunProgress } from "./compact-progress.mjs";

for (const workflow of ["attribution", "comparison"]) test(`offline compaction respects the ${workflow} checkpoint and refuses a running Host`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compact-progress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { format: "evaluation-run", journalSequence: 1 };
  const checkpoint = workflow === "attribution" ? { workflow, manifest } : manifest;
  await writeFile(path.join(root, "state.json"), JSON.stringify(checkpoint));
  const journal = [{ seq: 1, event: { at: 1, manifest: { config: { text: "已落盘".repeat(100000) } } } },
    { seq: 2, event: { at: 2, recordedAttempts: 2 } }].map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(path.join(root, "progress.jsonl"), journal);
  const release = await runLock(root);
  await assert.rejects(compactRunProgress(root), /Run already owned/);
  assert.equal(await readFile(path.join(root, "progress.jsonl"), "utf8"), journal);
  await release();
  const measured = await compactRunProgress(root);
  assert(measured.after_bytes < 200);
  assert.equal(measured.before_bytes, Buffer.byteLength(journal));
  assert.equal(measured.remaining_events, 1);
  assert.deepEqual(await readProgressJournal(root, 1), [{ seq: 2, event: { at: 2, recordedAttempts: 2 } }]);
  assert.equal(await readFile(path.join(root, "state.json"), "utf8"), JSON.stringify(checkpoint));
});
