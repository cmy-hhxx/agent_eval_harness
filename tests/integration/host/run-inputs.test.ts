import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { RunManifest, ValidationIssue } from "@eval/contracts";
import { fileSourceReader, writeJsonl } from "@eval/data";
import { buildPlan, loadRunInputs } from "@eval/workflows/comparison";
import { fixtureConfig, raw } from "../../fixtures/comparison.js";

test("validation streams registered records and still resolves reordered and missing inputs", async (t) => {
  const { directory, config } = await fixtureConfig([[raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], []]);
  try {
    const plan = await buildPlan(config);
    const expected = Object.fromEntries(Object.entries(plan.inputs));
    const manifest = { config, inputCatalog: plan.catalog } as unknown as RunManifest;
    const streamed = t.mock.method(fileSourceReader, "lines");
    assert.deepEqual(await loadRunInputs(manifest), expected);
    assert(streamed.mock.calls.length > 0, "validation reads registered sources through the streaming interface");
    const source = config.inputs.versions[0]!.sources[0]!.path;
    await writeJsonl(source, [raw("unselected"), raw("q2"), raw("q1")]);
    assert.deepEqual(await loadRunInputs(manifest), expected);
    await writeJsonl(source, [raw("q2")]);
    const issues: ValidationIssue[] = [];
    const available = await loadRunInputs(manifest, issues);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /业务标识不一致/);
    assert.equal(Object.keys(available).length, 3);
    await assert.rejects(loadRunInputs(manifest), /业务标识不一致/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("validation discards selected records if the source changes while reading", async (t) => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    const original = fileSourceReader.lines;
    const source = config.inputs.versions[0]!.sources[0]!.path;
    t.mock.method(fileSourceReader, "lines", async function* (file: string, revision?: string) {
      for await (const row of original(file, revision)) {
        if (file === source) await writeJsonl(source, [raw("q1", "4", "changed")]);
        yield row;
      }
    });
    const issues: ValidationIssue[] = [];
    const available = await loadRunInputs({ config, inputCatalog: plan.catalog } as unknown as RunManifest, issues);
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /读取期间输入文件发生变化/);
    assert.equal(Object.keys(available).length, Object.keys(plan.inputs).length - 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("validation keeps source coordinates and rejects edits after indexing", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const plan = await buildPlan(config);
    const inputs = await loadRunInputs({ config, inputCatalog: plan.catalog } as unknown as RunManifest);
    const candidate = (plan.catalog as { input_id: string; source: string }[])[0]!;
    assert.equal(typeof Object.getOwnPropertyDescriptor(inputs, candidate.input_id)?.get, "function",
      "validation must not retain every raw input body");
    assert.deepEqual(inputs[candidate.input_id], plan.inputs[candidate.input_id]);
    await writeJsonl(candidate.source, [raw("q1", "4", "changed")]);
    assert.throws(() => inputs[candidate.input_id], /读取期间输入文件发生变化/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
