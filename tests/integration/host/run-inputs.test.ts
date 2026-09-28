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
    const manifest = { config, inputCatalog: plan.catalog } as unknown as RunManifest;
    t.mock.method(fileSourceReader, "read", async () => { throw new Error("File size is greater than 2 GiB"); });
    assert.deepEqual(await loadRunInputs(manifest), plan.inputs);
    const source = config.inputs.versions[0]!.sources[0]!.path;
    await writeJsonl(source, [raw("unselected"), raw("q2"), raw("q1")]);
    assert.deepEqual(await loadRunInputs(manifest), plan.inputs);
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
