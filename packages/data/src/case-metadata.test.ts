import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { completeCaseMetadata, completeInputMetadata, readCaseMetadata } from "./case-metadata.js";
import { fileSourceReader } from "./sources.js";

const caseId = "selected_case_00001";
const labels = { id: "label-id", task: "screening", rued: { R: 1, U: 1 },
  _testset_name: "selected", _original_case_id: "case_00001", item_id: "batch_000000" };
const entries = new Map([[caseId, labels]]);

test("case metadata fills only missing info and preserves every existing metadata value", () => {
  const original = { case_id: caseId, messages: [{ content: "unchanged" }],
    meta: { item_id: "batch_000000", task: "manual", difficulty: "complex", usage: { total: 42 },
      info: { id: "label-id", custom: "retain", rued: { R: 1 } } } };
  const completed = completeCaseMetadata(original, entries);
  assert.deepEqual(completed.meta.info, { ...labels, custom: "retain" });
  assert.deepEqual({ ...completed.meta, info: original.meta.info }, original.meta);
  assert.equal(completed.messages, original.messages);
  assert.equal(completeCaseMetadata(completed, entries), completed);
  assert.deepEqual(original.meta.info.rued, { R: 1 });
  assert.throws(() => completeCaseMetadata({ ...original, meta: { info: { rued: { R: 2 } } } }, entries), /conflict/);
  assert.throws(() => completeCaseMetadata({ ...original, meta: { info: null } }, entries), /conflict/);
  assert.throws(() => completeCaseMetadata({ ...original, meta: { item_id: "other" } }, entries), /identity conflict/);
  const unrelated = { case_id: "other", meta: {} };
  assert.equal(completeCaseMetadata(unrelated, entries), unrelated);
});

test("metadata file completion is atomic, idempotent and refuses identity conflicts", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "case-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const supplement = path.join(directory, "case-meta.jsonl"), file = path.join(directory, "a.jsonl");
  await writeFile(supplement, JSON.stringify({ case_id: caseId, meta: labels }) + "\n");
  const loaded = await readCaseMetadata(supplement);
  await writeFile(file, JSON.stringify({ case_id: caseId, meta: { custom: [1, 2] }, messages: [{}] }) + "\n");
  assert.deepEqual(await completeInputMetadata(file, loaded, t.signal), { rows: 1, matched: 1, changed: 1 });
  const saved = await readFile(file, "utf8"), revision = await fileSourceReader.revision(file);
  assert.deepEqual(JSON.parse(saved).meta, { custom: [1, 2], info: labels });
  assert.equal((await completeInputMetadata(file, loaded, t.signal)).changed, 0);
  assert.equal(await fileSourceReader.revision(file), revision);
  await assert.rejects(completeInputMetadata(file, new Map([[caseId, { ...labels, task: "conflict" }]]), t.signal), /conflict/);
  assert.equal(await readFile(file, "utf8"), saved);
  await writeFile(supplement, JSON.stringify({ case_id: caseId, meta: labels }) + "\n"
    + JSON.stringify({ case_id: caseId, meta: labels }) + "\n");
  await assert.rejects(readCaseMetadata(supplement), /Duplicate/);
  await writeFile(supplement, JSON.stringify({ case_id: "wrong", meta: labels }) + "\n");
  await assert.rejects(readCaseMetadata(supplement), /identity/);
});
