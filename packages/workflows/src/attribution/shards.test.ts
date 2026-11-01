import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { writeJsonl } from "@eval/data";
import { fileSourceReader } from "@eval/data";
import type { PlannedTask, RunState } from "@eval/contracts";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { attributionShards, releaseAttribution, type AttributionConfig } from "./index.js";
import type { Candidate } from "../inputs/types.js";

function stateFor(config: AttributionConfig, catalog: Candidate[] = [], tasks: PlannedTask[] = []) {
  const state = { manifest: { config, tasks, inputCatalog: catalog, inputs: {}, states: {}, preflight: {} }, receipts: {} } as unknown as RunState;
  return state;
}

async function twoFiles() {
  const f = await fixtureConfig([[raw("first")], [], [], []]);
  const version = f.config.inputs.versions[0]!;
  const first = path.join(f.directory, "day-1.jsonl"), second = path.join(f.directory, "day-2.jsonl");
  await writeJsonl(first, [raw("case-1")]);
  await writeJsonl(second, [raw("case-2")]);
  version.sources = [{ kind: "file", path: first }, { kind: "file", path: second }];
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs, versions: [version] } } as AttributionConfig;
  return { f, config, first, second };
}

test("attribution plans one physical input file at a time and reads bodies only on access", async t => {
  const { f, config, first, second } = await twoFiles();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const state = stateFor(config), source = attributionShards(config, state);
  const opened: string[] = [], record = fileSourceReader.record, lines = fileSourceReader.lines;
  fileSourceReader.lines = (file, revision) => { opened.push(file); return lines(file, revision); };
  let reads = 0;
  fileSourceReader.record = (...args) => { reads++; return record(...args); };
  t.after(() => { fileSourceReader.lines = lines; fileSourceReader.record = record; });
  const shard = (await source.next())!;
  assert.equal(shard.source, first, "the first file is planned before the second is read");
  assert.deepEqual(opened, [first]);
  assert.equal(shard.candidates.length, 1);
  assert(shard.tasks.length > 0, "tasks exist before the remaining files are read");
  assert.equal(reads, 0, "planning does not parse input bodies");
  void shard.inputs[(shard.candidates[0] as Candidate).input_id];
  assert.equal(reads, 1);
  assert.equal((await source.next())!.source, second);
  assert.equal(await source.next(), undefined);
});

test("a resumed run skips a finished file and reads only the remaining shard", async t => {
  const { f, config, first, second } = await twoFiles();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const state = stateFor(config);
  state.manifest.preflight.shards = { [first]: await fileSourceReader.revision(first) };
  const opened: string[] = [], lines = fileSourceReader.lines;
  fileSourceReader.lines = (file, revision) => { opened.push(file); return lines(file, revision); };
  t.after(() => { fileSourceReader.lines = lines; });
  const source = attributionShards(config, state), shard = (await source.next())!;
  assert.equal(shard.source, second);
  assert.deepEqual(opened, [second], "the completed file is never read again");
});

test("an exported input releases its tasks, receipts and reader and records the finished file", async t => {
  const { f, config } = await twoFiles();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const state = stateFor(config), source = attributionShards(config, state), shard = (await source.next())!;
  const candidate = shard.candidates[0] as Candidate, inputs = shard.inputs;
  state.manifest.inputCatalog = [candidate];
  state.manifest.tasks = shard.tasks;
  const exported = shard.tasks.find(task => task.stage === "attribution-session")!;
  state.receipts[exported.id] = { taskId: exported.id, attemptId: "a", submissionId: "s", status: "succeeded",
    evaluatorVersion: "v", judge: "j", acceptedAt: 1, usage: {} as never, audit: {} as never,
    evaluation: {}, exported: { id: exported.id, file: "attribution.jsonl", line: 1, row: {} } } as never;
  releaseAttribution(state, inputs);
  assert.equal(state.manifest.tasks.length, 0, "a finished input keeps no recovery detail");
  assert.equal(Object.keys(state.receipts).length, 0);
  assert.equal(Object.hasOwn(inputs, candidate.input_id), false);
  assert.equal((state.manifest.inputCatalog as Candidate[]).length, 0);
  assert.equal((state.manifest.preflight.shards as Record<string, string>)[candidate.source], candidate.source_revision, "the file is recorded by revision");
  assert.equal(Object.hasOwn(state.manifest.inputs, candidate.input_id), false);
});
