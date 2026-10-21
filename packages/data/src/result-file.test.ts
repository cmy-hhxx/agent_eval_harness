import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createResultFileWriter } from "./result-file.js";

test("result replacement copies unchanged UTF-8 rows without serializing their bodies again", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-result-copy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "results.jsonl"), writer = createResultFileWriter(file);
  let reads = 0;
  const first = { id: "one", get text() { reads++; return "中文😀".repeat(100000); } };
  const second = { id: "two", text: "original" }, third = { id: "three", text: "new" };
  await writer.replace([first, second]);
  const before = reads;
  await writer.append([third]);
  const rewritten = { ...second, text: "rewritten" };
  await writer.replace([first, rewritten, third]);
  assert.equal(reads, before, "changing one row must not reserialize an accepted neighbor");
  await writer.replace([third, first, rewritten]);
  assert.equal(reads, before, "coordinates follow row identity when ordering changes");
  assert.equal(await readFile(file, "utf8"), [third, first, rewritten].map(row => JSON.stringify(row) + "\n").join(""));
});

test("a failed replacement preserves the committed file and invalidates partial coordinates", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "eval-result-copy-failed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "results.jsonl"), writer = createResultFileWriter(file);
  const rows = [{ id: "one", value: 1 }, { id: "two", value: 2 }];
  await writer.replace(rows);
  const committed = await readFile(file, "utf8");
  function* broken() { yield { id: "one", value: 3 }; throw new Error("interrupted write"); }
  await assert.rejects(writer.replace(broken()), /interrupted write/);
  assert.equal(await readFile(file, "utf8"), committed);
  await writer.replace(rows);
  assert.equal(await readFile(file, "utf8"), committed);
  await writeFile(file, '{"id":"external"}\n');
  await writer.replace(rows);
  assert.equal(await readFile(file, "utf8"), committed, "a changed file cannot supply stale byte coordinates");
});
