import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, rm } from "node:fs/promises";
import { fileSourceReader } from "@eval/data";
import type { RunManifest } from "@eval/contracts";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { collectInputs } from "./scan.js";
import { loadRunInputs } from "./load.js";

test("adjacent tasks reuse one parsed record, evict on input change and still reject changed sources", async t => {
  const f = await fixtureConfig([[raw("first"), raw("second")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const indexed = await collectInputs(f.config, undefined, { materializeInputs: false });
  const inputs = await loadRunInputs({ config: f.config, tasks: [], inputCatalog: indexed.catalog } as unknown as RunManifest);
  const [first, second] = indexed.catalog, record = fileSourceReader.record;
  let reads = 0;
  fileSourceReader.record = (...args) => { reads++; return record(...args); };
  t.after(() => { fileSourceReader.record = record; });
  const value = inputs[first!.input_id];
  assert.equal(inputs[first!.input_id], value);
  assert.equal(reads, 1);
  assert.notEqual(inputs[second!.input_id], value);
  assert.deepEqual(inputs[first!.input_id], value);
  assert.equal(reads, 3, "only the current record is retained");
  await appendFile(first!.source, "\n");
  assert.throws(() => inputs[first!.input_id], /输入文件发生变化/);
});
