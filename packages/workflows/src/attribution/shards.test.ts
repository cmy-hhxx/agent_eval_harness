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

test("a large corpus keeps state bounded by the window and releases every finished input", async t => {
  const files = 50, perFile = 20, window = 8;
  const f = await fixtureConfig([[], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const version = f.config.inputs.versions[0]!, paths: string[] = [];
  for (let file = 0; file < files; file++) {
    const source = path.join(f.directory, `day-${file}.jsonl`);
    await writeJsonl(source, Array.from({ length: perFile }, (_, index) => raw(`case-${file}-${index}`)));
    paths.push(source);
  }
  version.sources = paths.map(path => ({ kind: "file" as const, path }));
  const config = { ...f.config, workflow: "attribution" as const,
    inputs: { ...f.config.inputs, versions: [version] } } as AttributionConfig;
  config.execution.sessionWindow = window;
  const state = stateFor(config), source = attributionShards(config, state), inputs: Record<string, unknown> = {};
  let bound = 0, maxBound = 0, maxBytes = 0, pulled = 0;
  const pull = async () => {
    const shard = await source.next();
    if (!shard) return false;
    pulled++;
    const candidates = shard.candidates as Candidate[];
    state.manifest.inputCatalog = [...(state.manifest.inputCatalog as Candidate[]), ...candidates];
    for (const candidate of candidates) state.manifest.inputs[candidate.input_id] = { id: candidate.input_id, name: candidate.input_id };
    Object.defineProperties(inputs, Object.getOwnPropertyDescriptors(shard.inputs));
    // A file is the smallest shard: its tasks join the plan even when it overshoots the window.
    for (const task of shard.tasks) { state.manifest.tasks.push(task); state.manifest.states[task.id] = { status: "pending", attempts: 0 }; }
    bound = Object.keys(inputs).length;
    maxBound = Math.max(maxBound, bound);
    maxBytes = Math.max(maxBytes, JSON.stringify(state).length);
    return true;
  };
  for (;;) {
    while (Object.keys(inputs).length < window) { if (!await pull()) break; }
    bound = Object.keys(inputs).length;
    maxBytes = Math.max(maxBytes, JSON.stringify(state).length);
    if (!bound) break;
    // Evaluate one bound input, then export and release it like the outbox does.
    const candidate = (state.manifest.inputCatalog as Candidate[])[0]!;
    const session = state.manifest.tasks.find(task => task.stage === "attribution-session" &&
      (task.data as { candidate: Candidate }).candidate.input_id === candidate.input_id)!;
    state.receipts[session.id] = { taskId: session.id, attemptId: "a", submissionId: "s-" + session.id, status: "succeeded",
      evaluatorVersion: "v", judge: "j", acceptedAt: 1, usage: {} as never, audit: {} as never,
      evaluation: {}, exported: { id: session.id, file: "attribution.jsonl", line: 1, row: {} } } as never;
    releaseAttribution(state, inputs);
  }
  assert.equal(pulled, files, "every physical file is read exactly once");
  assert(maxBound <= window - 1 + perFile, "one file may overshoot the window, never the corpus: " + maxBound);
  assert(maxBytes < 4 * 1024 * 1024, "checkpoint stays sized by the window, not the corpus: " + maxBytes);
  assert.equal(state.manifest.tasks.length, 0, "finished inputs leave recovery detail");
  assert.equal(Object.keys(state.receipts).length, 0);
  assert.equal(Object.keys(inputs).length, 0);
  assert.equal((state.manifest.inputCatalog as Candidate[]).length, 0);
  assert.equal(Object.keys(state.manifest.preflight.shards as object).length, files, "each finished file is recorded by revision");
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
