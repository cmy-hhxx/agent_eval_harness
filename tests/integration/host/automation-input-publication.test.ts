import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncMongoInputFile } from "../../../apps/host/src/automation-input-publication.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationMongoTarget, createAutomationMongoLane } from "../../../apps/host/src/automation-sources.js";
import { loadConfig } from "../../../apps/host/src/config.js";
import { testSettings } from "../../fixtures/settings.js";

async function inputConfig(directory: string) {
  const config = await loadAutomationConfig("configs/automations-post-training.json");
  config.hostConfigs = ["host.json", "post-training-models.json"].map(file => path.resolve("configs", file));
  config.sourceDirectory = directory;
  config.publication.mongoUriEnv = "PATH";
  return config;
}

test("complete input files upload in bounded batches with output interleaving and survive promotion", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "input-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const incoming = path.join(directory, ".incoming"); await mkdir(incoming);
  const file = path.join(incoming, "b_fast.jsonl"), date = "2026-10-19";
  const rows = Array.from({ length: 35 }, (_, i) => ({
    batch_id: date, case_id: String(i), messages: [{ role: "assistant", content: "answer" }],
  }));
  rows.push({ ...rows[0] });
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n"));
  const config = await inputConfig(directory);
  const host = await loadConfig(config.hostConfigs, testSettings());
  const lane = createAutomationMongoLane(), published: string[] = [], order: string[] = [];
  let output: Promise<void> | undefined;
  const result = await syncMongoInputFile(config, date, "b_fast", file, t.signal, lane, async (settings, batch, inputs, results) => {
    assert.equal(settings.topic, config.publication.topic);
    assert.notEqual(settings.inputsUnchanged, true);
    assert.equal(batch, date);
    const completed = [];
    for await (const result of results) completed.push(result);
    assert.deepEqual(completed, []);
    const records = [];
    for await (const input of inputs) records.push(input);
    assert(records.length <= 16);
    published.push(...records.map(row => String(row.trace.case_id))); order.push("input");
    if (!output) {
      await rename(file, path.join(directory, "b_fast.jsonl"));
      output = lane(async () => { order.push("output"); }, t.signal, JSON.stringify([automationMongoTarget(config), date]));
    }
    return { inputs: records.length, comparisons: 0, inserted: records.length, updated: 0 };
  }, host);
  await output;
  assert.equal(result.rows, 36); assert.equal(result.quarantined, 2);
  assert.equal(result.counts.inputs, 34); assert.equal(new Set(published).size, 34);
  assert(!published.includes("0"));
  assert.deepEqual(order, ["input", "output", "input", "input"]);
});

test("malformed complete input files perform no Mongo writes", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "bad-input-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const incoming = path.join(directory, ".incoming"); await mkdir(incoming);
  const file = path.join(incoming, "b_fast.jsonl");
  await writeFile(file, '{"case_id":"ok","messages":[{}]}\n{"broken":');
  const config = await inputConfig(directory);
  const host = await loadConfig(config.hostConfigs, testSettings());
  let writes = 0;
  await assert.rejects(syncMongoInputFile(config, "2026-10-19", "b_fast", file, t.signal, createAutomationMongoLane(),
    async () => { writes++; return { inputs: 0, comparisons: 0, inserted: 0, updated: 0 }; }, host), SyntaxError);
  assert.equal(writes, 0);
});

test("input publication supplements info by case identity without replacing source metadata", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "input-metadata-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const incoming = path.join(directory, "2026-10-19", ".incoming"); await mkdir(incoming, { recursive: true });
  const caseId = "selected_case_00001", info = {
    _testset_name: "selected", _original_case_id: "case_00001", task: "screening", rued: { R: 1 },
  };
  await writeFile(path.join(directory, "case-meta.jsonl"), JSON.stringify({ case_id: caseId, meta: info }) + "\n");
  const file = path.join(incoming, "b_fast.jsonl");
  await writeFile(file, JSON.stringify({
    case_id: caseId, meta: { task: "manual", usage: { total: 42 } }, messages: [{ role: "assistant", content: "answer" }],
  }) + "\n");
  const config = await inputConfig(directory);
  const host = await loadConfig(config.hostConfigs, testSettings());
  let writes = 0;
  const result = await syncMongoInputFile(config, "2026-10-19", "b_fast", file, t.signal, createAutomationMongoLane(),
    async (_settings, _date, inputs) => {
      for await (const input of inputs) {
        assert.deepEqual(input.trace.meta, { task: "manual", usage: { total: 42 }, info });
        writes++;
      }
      return { inputs: writes, comparisons: 0, inserted: writes, updated: 0 };
    }, host);
  assert.equal(result.counts.inputs, 1);
});

test("an input refresh sends corrected bodies and metadata for existing identities", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "existing-input-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const date = "2026-10-19", file = path.join(directory, "b_fast.jsonl");
  const rows = Array.from({ length: 35 }, (_, i) => ({ batch_id: date, case_id: String(i),
    messages: [{ role: "assistant", content: "corrected answer" }], meta: { info: { task: "updated label" } } }));
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n"));
  const config = await inputConfig(directory);
  const host = await loadConfig(config.hostConfigs, testSettings());
  let writes = 0;
  const uploaded: string[] = [];
  const result = await syncMongoInputFile(config, date, "b_fast", file, t.signal, createAutomationMongoLane(),
    async (settings, _date, inputs) => {
      assert.notEqual(settings.inputsUnchanged, true, "the writer must compare existing contents");
      writes++;
      let count = 0;
      for await (const input of inputs) {
        uploaded.push(String(input.trace.case_id)); count++;
        assert.deepEqual(input.trace.messages, rows[0].messages);
        assert.deepEqual(input.trace.meta, rows[0].meta);
      }
      return { inputs: count, comparisons: 0, inserted: 0, updated: count };
    }, host);
  assert.equal(writes, 3);
  assert.deepEqual(uploaded, rows.map(row => row.case_id));
  assert.deepEqual(result.counts, { inputs: 35, comparisons: 0, inserted: 0, updated: 35 });
});
