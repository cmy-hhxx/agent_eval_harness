import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { emptyUsage, type ResultReference, type RunState } from "@eval/contracts";
import { createRunRepository, type RunCodec } from "./repository.js";
import { readRunOverviews } from "./run-overview.js";
import { runProgressFile } from "./run-journal.js";

const state: RunState = {
  manifest: {
    format: "evaluation-run", debug: false, runId: "repository-test", status: "finished",
    engine: { engine: "pi", version: "test", commit: "test", buildId: "test" },
    evaluatorVersion: "test", config: null, tasks: [], inputs: {}, states: {}, preflight: {}, startedAt: 0,
  },
  receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
};

test("repository checkpoint saves refresh the overview through running, finished and resumed states", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-overview-save-")), run = path.join(directory, "run");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codec: RunCodec<RunState> = { encode: value => value, overview: value => ({ status: value.manifest.status }),
    references: () => [], resultId: () => "", decode: value => value };
  const repository = createRunRepository(codec, () => { throw new Error("No results"); });
  for (const status of ["running", "finished", "running", "interrupted"] as const) {
    await repository.writeRun(run, { ...state, manifest: { ...state.manifest, status } });
    assert.deepEqual(await repository.readRun(run), { ...state, manifest: { ...state.manifest, status } });
    assert.equal((await readFile(path.join(run, "state.json"), "utf8")).trim().split("\n").length, 1,
      "frequent checkpoint writes must not duplicate their size with indentation");
    assert.deepEqual(await readRunOverviews(directory), [{ runId: "run", value: { status } }]);
  }
});

test("a reader racing journal compaction reloads the new checkpoint instead of dropping covered events", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-checkpoint-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const latest = { ...state, manifest: { ...state.manifest, journalSequence: 10 }, recordedAttempts: 10 };
  let reads = 0;
  const codec: RunCodec<RunState> = { encode: value => value, references: () => [], resultId: () => "", decode(value) {
    if (++reads === 1) {
      writeFileSync(path.join(root, "state.json"), JSON.stringify(latest));
      writeFileSync(runProgressFile(root), JSON.stringify({ seq: 10, event: { at: 10, checkpoint: true } }) + "\n" +
        JSON.stringify({ seq: 11, event: { at: 11, recordedAttempts: 11 } }) + "\n");
    }
    return value;
  } };
  const repository = createRunRepository(codec, () => null);
  await repository.writeRun(root, state);
  const restored = await repository.readRun(root);
  assert.equal(reads, 2);
  assert.equal(restored.manifest.journalSequence, 10);
  assert.equal(restored.recordedAttempts, 11);
});

async function fixture(t: test.TestContext, references: ResultReference[], indexedFiles?: string[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codec: RunCodec<ResultReference[]> = {
    encode: () => references,
    references: (saved, ids) => saved.filter((ref) => !ids || ids.has(ref.id)),
    resultId: (row) => String(row.id),
    decode: (saved, row, ids) => ({
      ...state, manifest: { ...state.manifest, config: saved.filter((ref) => !ids || ids.has(ref.id)).map(row) },
    }),
  };
  const repository = createRunRepository(codec, () => { throw new Error("Read-only test"); }, { indexedFiles });
  await repository.writeRun(directory, state);
  await mkdir(path.join(directory, "results"));
  return { directory, repository };
}

test("checkpoint row references select identical public rows by identity and reject missing or conflicting coordinates", async t => {
  const refs = [{ file: "attribution.jsonl", id: "first", line: 1 }, { file: "attribution.jsonl", id: "second", line: 2 }];
  const { directory, repository } = await fixture(t, refs, ["attribution.jsonl"]);
  const row = { session_meta: {}, turns: [], session_summary: "same", session_problem: [] };
  await writeFile(path.join(directory, "results/attribution.jsonl"), (JSON.stringify(row) + "\n").repeat(2));
  assert.deepEqual((await repository.readRun(directory)).manifest.config, [row, row]);
  assert.deepEqual((await repository.readTasks(directory, ["second"])).manifest.config, [row]);
  for (const [line, error] of [[0, /结果行引用无效/], [1, /被多个身份引用/], [3, /结果文件缺失/]] as const) {
    refs[1]!.line = line;
    await repository.writeRun(directory, state);
    await assert.rejects(repository.readRun(directory), error);
  }
});

test("full and selected result reads share file-scoped identities, duplicate checks and interrupted-tail recovery", async (t) => {
  const { directory, repository } = await fixture(t, [
    { file: "first.jsonl", id: "one" }, { file: "second.jsonl", id: "one" },
  ]);
  const first = { id: "one", value: "中文".repeat(40000) }, second = { id: "one", value: "other file" };
  await writeFile(path.join(directory, "results/first.jsonl"), `${JSON.stringify(first)}\n${JSON.stringify({ value: first.value, id: "one" })}\n{"id":`);
  await writeFile(path.join(directory, "results/second.jsonl"), JSON.stringify(second) + "\n");
  for (const read of [() => repository.readRun(directory), () => repository.readTasks(directory, ["one"])])
    assert.deepEqual((await read()).manifest.config, [first, second]);
  await writeFile(path.join(directory, "results/first.jsonl"), '{"id":"one","value":1}\n{"id":"one","value":2}\n');
  await assert.rejects(repository.readRun(directory), /冲突结果/);
  await assert.rejects(repository.readTasks(directory, ["one"]), /冲突结果/);
});

test("selected result reads ignore unrelated missing or conflicting rows but never hide a missing selected result", async (t) => {
  const { directory, repository } = await fixture(t, [
    { file: "scores.jsonl", id: "one" }, { file: "missing.jsonl", id: "two" },
  ]);
  const file = path.join(directory, "results/scores.jsonl");
  await writeFile(file, '{"id":"orphan","value":1}\n{"id":"orphan","value":2}\n{"id":"one","value":3}\n');
  assert.deepEqual((await repository.readTasks(directory, ["one"])).manifest.config, [{ id: "one", value: 3 }]);
  assert.deepEqual((await repository.readTasks(directory, [])).manifest.config, []);
  await assert.rejects(repository.readRun(directory), /冲突结果/);
  await assert.rejects(repository.readTasks(directory, ["two"]), /结果文件缺失/);
  await writeFile(file, '{"id":"one","value":3}\n');
  await assert.rejects(repository.readRun(directory), /结果文件缺失/);
});
