import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, symlink, writeFile } from "node:fs/promises";
import { writeJsonl } from "@eval/data";
import type { HostConfig } from "@eval/host-app/config";
import { fixtureConfig, raw, sessionRaw } from "../../../tests/fixtures/comparison.js";
import { checkData, commonInputDirectory, emptyDataCheck, parentInputs } from "./data-check.js";

test("parent directory includes .archive while excluding other hidden directories, unknown models and symlinks", async t => {
  const f = await fixtureConfig(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const root = path.join(f.directory, "parent");
  for (const v of f.config.inputs.versions) {
    await writeJsonl(path.join(root, "daily", v.id, "2026-11-01.jsonl"), [raw()]);
    await writeJsonl(path.join(root, "daily", v.id, "2026-11-02.jsonl"), [raw()]);
    await writeJsonl(path.join(root, ".archive", v.id, "old.jsonl"), [raw()]);
    await writeJsonl(path.join(root, ".hidden", v.id, "private.jsonl"), [raw()]);
  }
  await writeJsonl(path.join(root, "unknown.jsonl"), [raw()]);
  await symlink(f.directory, path.join(root, "loop"));
  const result = await parentInputs(root, f.config.inputs.versions, [f.directory]);
  assert.equal(result.ignored, 1);
  assert(Object.values(result.inputs).every(files => files.length === 3));
  assert.equal(commonInputDirectory(f.config.inputs.versions), path.dirname(f.config.inputs.versions[0].sources[0].path));
  await assert.rejects(parentInputs(root, f.config.inputs.versions, [path.join(f.directory, "other")]), /不在/);
  await assert.rejects(parentInputs(path.join(root, "unknown.jsonl"), f.config.inputs.versions, [root]), /父目录/);
});

test("data check counts valid answers, duplicate/invalid rows and existing final output by model/date/case", async t => {
  const value = (id: string) => ({ ...raw(id), batch_id: "2026-11-02" });
  const f = await fixtureConfig([[value("done"), value("new"), { ...value("bad"), messages: [] }, value("dup"), value("dup")], [],
    [value("done"), value("new")], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.output.layout = "business";
  await writeJsonl(path.join(f.config.output.path, "a_fast/a_fast_attribution-2026-11-02.jsonl"), [{ session_meta: { case_id: "done" } }]);
  await writeJsonl(path.join(f.config.output.path, "b_fast/compact/b_fast_compact-2026-11-02.jsonl"), [{ session_meta: { case_id: "new" } }]);
  await writeJsonl(path.join(f.config.output.path, "b_fast/b_fast_attribution-2026-11-01.jsonl"), [{ session_meta: { case_id: "done" } }]);
  const issues: unknown[] = [], result = emptyDataCheck("attribution");
  const host: HostConfig = { workflow: "attribution", evaluation: { ...f.config, workflow: "attribution" }, models: f.models, evaluatorVersion: "fixture" };
  await checkData(host, result, new AbortController().signal, async issue => { issues.push(issue); });
  assert.equal(result.status, "ready"); assert.equal(result.files, 2); assert.equal(result.checkedFiles, 2);
  assert.equal(result.readRecords, 7); assert.equal(result.invalidRecords, 2); assert.equal(result.validRecords, 5);
  assert.equal(result.total, 5); assert.equal(result.skipped, 1); assert.equal(result.pending, 4);
  assert.equal(issues.length, 2); assert.equal(result.destinations.length, 2);
  assert(result.destinations.every(file => file.endsWith("_attribution-2026-11-02.jsonl")));
});

test("comparison check counts pairs, completed output and missing/conflicting answers independently", async t => {
  const value = (id: string) => ({ ...raw(id), batch_id: "2026-11-02" });
  const f = await fixtureConfig([[value("done"), value("new"), value("missing"), value("conflict")], [],
    [value("done"), value("new"), { ...value("conflict"), messages: [{ role: "user", content: "不同问题" }, { role: "assistant", content: "回答" }] }], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.comparisons = [["a_fast", "b_fast"]]; f.config.output.layout = "business";
  await writeJsonl(path.join(f.config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-2026-11-02.jsonl"), [{ case: { case_id: "done" } }]);
  // Comparison precheck must not scan unrelated attribution bodies.
  await writeJsonl(path.join(f.config.output.path, "a_fast/a_fast_attribution-2026-11-02.jsonl"), []);
  await writeFile(path.join(f.config.output.path, "a_fast/a_fast_attribution-2026-11-02.jsonl"), "unrelated-invalid-json\n");
  const result = emptyDataCheck("comparison");
  await checkData({ workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" }, result, new AbortController().signal, async () => {});
  assert.equal(result.readRecords, 7); assert.equal(result.total, 2); assert.equal(result.skipped, 1);
  assert.equal(result.pending, 1); assert.equal(result.unavailable, 2); assert.equal(result.unit, "场对比");
});

test("named default batches preserve explicit input batches and find completed comparisons", async t => {
  const named = { ...raw("named"), batch_id: undefined }, dated = { ...raw("dated"), batch_id: "2026-11-02" };
  const f = await fixtureConfig([[named, dated], [], [named, dated], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0], f.config.inputs.versions[2]];
  f.config.inputs.default_batch_id = "search_eval";
  f.config.comparisons = [["a_fast", "b_fast"]]; f.config.output.layout = "business";
  await writeJsonl(path.join(f.config.output.path, "comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-search_eval.jsonl"), [{ case: { case_id: "named" } }]);
  const result = emptyDataCheck("comparison");
  await checkData({ workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" }, result, new AbortController().signal, async () => {});
  assert.equal(result.invalidRecords, 0); assert.equal(result.total, 2); assert.equal(result.skipped, 1); assert.equal(result.pending, 1);
  assert(result.destinations.some(file => file.endsWith("-search_eval.jsonl")));
  assert(result.destinations.some(file => file.endsWith("-2026-11-02.jsonl")));
});

test("malformed JSON and incomplete answers are counted, while record selection and session aliases match execution", async t => {
  const session = { ...sessionRaw("one"), batch_id: "2026-11-02" };
  const f = await fixtureConfig([[], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0]]; f.config.output.layout = "business";
  const source = f.config.inputs.versions[0].sources[0].path;
  await writeFile(source, '\uFEFF' + JSON.stringify(session) + '\r\nnot-json\nnull\n');
  await writeJsonl(path.join(f.config.output.path, "a_fast/a_fast_attribution-2026-11-02.jsonl"), [{ session_meta: { session_id: "session-one" } }]);
  const host: HostConfig = { workflow: "attribution", evaluation: { ...f.config, workflow: "attribution" }, models: f.models, evaluatorVersion: "fixture" };
  const result = emptyDataCheck("attribution");
  await checkData(host, result, new AbortController().signal, async () => {});
  assert.equal(result.readRecords, 3); assert.equal(result.invalidRecords, 2); assert.equal(result.skipped, 1);
  f.config.inputs.records = [{ model: "a_fast", batch_id: "2026-11-02", case_id: "one", input_file: source, input_index: 0 }];
  const selected = emptyDataCheck("attribution");
  await checkData(host, selected, new AbortController().signal, async () => {});
  assert.equal(selected.readRecords, 1); assert.equal(selected.invalidRecords, 0); assert.equal(selected.skipped, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkData(host, emptyDataCheck("attribution"), controller.signal, async () => {}));
});

test("bad rows use bounded log batches instead of one storage round trip per record", async t => {
  const f = await fixtureConfig([[], [], [], []]); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions = [f.config.inputs.versions[0]];
  await writeFile(f.config.inputs.versions[0].sources[0].path, 'invalid\n'.repeat(120));
  let active = 0, peak = 0, saved = 0;
  const result = emptyDataCheck("comparison");
  await checkData({ workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" }, result,
    new AbortController().signal, async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve)); active--; saved++;
    });
  assert(peak > 1, "error writes must share a batch instead of serial storage waits");
  assert(peak <= 100, "error buffering must stay bounded");
  assert.equal(saved, 120); assert.equal(result.invalidRecords, 120);
});
