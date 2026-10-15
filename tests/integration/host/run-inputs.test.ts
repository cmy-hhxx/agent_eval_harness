import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import type { RunManifest, ValidationIssue } from "@eval/contracts";
import { fileSourceReader, writeJsonl } from "@eval/data";
import { buildPlan, loadRunInputs, locateRecordStream, normalizeInput, type Candidate, type RawInput } from "@eval/workflows/comparison";
import { resolveEvidence } from "@eval/tools";
import { canonicalEvidence } from "../../fixtures/evidence.js";
import { emptyAudit, fixtureConfig, raw, sessionRaw } from "../../fixtures/comparison.js";

test("single-trace inputs retain evidence coordinates across lazy reads and source reordering", async (t) => {
  const { directory, config } = await fixtureConfig([[raw("old")], [], [raw("old")], []]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  config.inputs.default_batch_id = "b1";
  const source = sessionRaw("new");
  for (const version of config.inputs.versions.filter(version => version.id.endsWith("fast")))
    await writeJsonl(version.sources[0].path, [raw("old"), source]);
  const version = config.inputs.versions[0], file = version.sources[0].path, before = await readFile(file, "utf8");
  const plan = await buildPlan(config);
  assert.deepEqual(plan.summary.issues, []);
  const candidate = (plan.catalog as Candidate[]).find(candidate => candidate.version === version.id && candidate.case_id === "new")!;
  const evidence = canonicalEvidence(candidate.input_id, 1, "2+2=4");
  const check = (input: RawInput) => {
    assert.deepEqual(input, normalizeInput(source));
    assert.equal(resolveEvidence(input, evidence, "answer", emptyAudit(), "/evidence", candidate.input_id).quote, "2+2=4");
  };
  check(plan.inputs[candidate.input_id] as RawInput);
  const manifest = { config, inputCatalog: plan.catalog } as unknown as RunManifest;
  check((await loadRunInputs(manifest))[candidate.input_id] as RawInput);
  check((await locateRecordStream(file, candidate, version, "b1")).raw);
  assert.equal(await readFile(file, "utf8"), before, "all reads preserve the source bytes");
  await writeJsonl(file, [source, raw("old")]);
  check((await loadRunInputs(manifest))[candidate.input_id] as RawInput);
  const relocated = await locateRecordStream(file, candidate, version, "b1");
  assert.equal(relocated.line, 1);
  check(relocated.raw);
  const inputs = await loadRunInputs(manifest);
  await writeJsonl(file, [raw("old")]);
  assert.throws(() => inputs[candidate.input_id], /读取期间输入文件发生变化/);
});

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
