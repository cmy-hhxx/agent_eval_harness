import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandRecord, slimRecord } from "./aime-slim.mjs";

const script = fileURLToPath(new URL("./aime-slim.mjs", import.meta.url));
const system = { role: "system", content: "S".repeat(4096) };
const question = { role: "user", content: "question" };
const assistant = { role: "assistant", content: null, reasoning_content: "thinking" };
const toolMessage = { role: "tool", content: "<reference>" };
const tools = [{ name: "shell", parameters: { type: "object" } }];

function session(turns = 5) {
  const conversation = [system, question];
  const messages = [{ type: "user_question", role: "user", content: "question" }];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ type: "llm_turn", name: `llm-call-${index}`, model: "m", input_messages: { messages: [...conversation], tools }, output: [{ role: "assistant", content: `step ${index}` }] });
    messages.push({ type: "tool_call", name: "shell", input: { command: "ls" } });
    messages.push({ type: "tool_result", name: "shell", output: { stdout: `out ${index}` } });
    conversation.push({ role: "assistant", content: `step ${index}` }, { role: "tool", content: `<reference ${index}>` });
  }
  messages.push({ type: "final_answer", role: "assistant", content: "answer" });
  return {
    request_time: "2026-10-19T15:39:23.607Z",
    has_standard_answer: true,
    meta: { session_id: "s1", n_traces: 1 },
    traces: [{ meta: { trace_id: "t1" }, messages }],
  };
}

/** Slim then expand through JSON, exactly as the CLI writes and reads. */
function roundTrip(record) {
  const source = JSON.stringify(record);
  const slimmed = JSON.stringify(slimRecord(JSON.parse(source)));
  return { slimmed, restored: JSON.stringify(expandRecord(JSON.parse(slimmed))), source };
}

test("repeated snapshots collapse into one pool and expand back exactly", () => {
  const { slimmed, restored, source } = roundTrip(session());
  assert.equal(restored, source);
  assert.ok(slimmed.length < source.length / 2, `expected a large reduction, got ${slimmed.length}/${source.length}`);
  const trace = JSON.parse(slimmed).traces[0];
  assert.equal(trace.message_pool.length, 10);
  assert.deepEqual(trace.message_pool[0], system);
  assert.deepEqual(trace.tool_sets, [tools]);
  assert.deepEqual(trace.messages[1].input_messages, { messages: [0, 1], tools: 0 });
  assert.equal(trace.messages[13].input_messages.messages.length, 10);
  assert.deepEqual(trace.messages[13].input_messages.messages, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("a snapshot that repeats the same message twice keeps its order", () => {
  const record = { traces: [{ messages: [
    { type: "llm_turn", input_messages: { messages: [system, system, question] } },
  ] }] };
  const { slimmed, restored, source } = roundTrip(record);
  assert.deepEqual(JSON.parse(slimmed).traces[0].messages[0].input_messages.messages, [0, 0, 1]);
  assert.equal(restored, source);
});

test("a bare input_messages array stays a bare array", () => {
  const record = { traces: [{ messages: [
    { type: "llm_turn", input_messages: [system, question] },
    { type: "llm_turn", input_messages: [system, question, assistant] },
  ] }] };
  const { slimmed, restored, source } = roundTrip(record);
  const messages = JSON.parse(slimmed).traces[0].messages;
  assert.deepEqual(messages[0].input_messages, [0, 1]);
  assert.deepEqual(messages[1].input_messages, [0, 1, 2]);
  assert.equal(restored, source);
});

test("traces without llm_turn spans and snapshots without messages pass through untouched", () => {
  const flat = { traces: [{ messages: [{ type: "llm_turn", output: [] }, { type: "final_answer", content: "a" }] }] };
  const slimmed = slimRecord(JSON.parse(JSON.stringify(flat)));
  assert.equal(JSON.stringify(slimmed), JSON.stringify(flat));
  assert.equal(slimmed.traces[0].message_pool, undefined);
});

test("a flat record without traces is slimmed at the record level", () => {
  const record = { messages: [
    { type: "user_question", role: "user", content: "question" },
    { type: "llm_turn", input_messages: { messages: [system, question] } },
    { type: "llm_turn", input_messages: { messages: [system, question, assistant] } },
  ] };
  const { slimmed, restored, source } = roundTrip(record);
  assert.equal(JSON.parse(slimmed).message_pool.length, 3);
  assert.equal(restored, source);
});

test("cli writes targets, skips current ones, and can expand them back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-"));
  try {
    const source = path.join(root, "source"), target = path.join(root, "target"), expanded = path.join(root, "expanded");
    await mkdir(source);
    const lines = [JSON.stringify(session()), JSON.stringify(session())];
    await writeFile(path.join(source, "2026-10-19.jsonl"), `${lines.join("\n")}\n`);
    await writeFile(path.join(source, "notes.txt"), "ignored\n");

    const first = spawnSync(process.execPath, [script, "--source", source, "--target", target, "--verify"], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual((await readdir(target)).sort(), ["2026-10-19.jsonl"]);
    const slimmed = await readFile(path.join(target, "2026-10-19.jsonl"), "utf8");
    assert.ok(slimmed.length < lines.join("\n").length / 2);

    const again = spawnSync(process.execPath, [script, "--source", source, "--target", target], { encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /跳过/);
    assert.equal((await readdir(target)).length, 1);

    const forced = spawnSync(process.execPath, [script, "--source", source, "--target", target, "--force"], { encoding: "utf8" });
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok((await stat(path.join(target, "2026-10-19.jsonl"))).size > 0);

    const back = spawnSync(process.execPath, [script, "--source", target, "--target", expanded, "--expand", "--verify"], { encoding: "utf8" });
    assert.equal(back.status, 0, back.stderr);
    assert.equal(await readFile(path.join(expanded, "2026-10-19.jsonl"), "utf8"), `${lines.join("\n")}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a nested source tree is mirrored into the target and parsed in parallel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-nested-"));
  try {
    const source = path.join(root, "input"), target = path.join(root, "slim");
    const customers = ["alpha", "beta"];
    for (const customer of customers) {
      await mkdir(path.join(source, customer, "expert"), { recursive: true });
      await writeFile(path.join(source, customer, "expert", "2026-10-19.jsonl"), `${JSON.stringify(session())}\n`);
      await writeFile(path.join(source, customer, "expert", "notes.md"), "ignored\n");
    }
    await mkdir(path.join(source, ".archive"), { recursive: true });
    await writeFile(path.join(source, ".archive", "2026-10-18.jsonl"), `${JSON.stringify(session())}\n`);

    const run = spawnSync(process.execPath, [script, "--source", source, "--target", target, "--concurrency", "2", "--verify"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readdir(target)).sort(), ["alpha", "beta"]);
    for (const customer of customers)
      assert.deepEqual((await readdir(path.join(target, customer, "expert"))), ["2026-10-19.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a single jsonl file is accepted as the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-file-"));
  try {
    const file = path.join(root, "2026-10-19.jsonl"), target = path.join(root, "slim");
    await writeFile(file, `${JSON.stringify(session())}\n`);
    const run = spawnSync(process.execPath, [script, "--source", file, "--target", target], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readdir(target)), ["2026-10-19.jsonl"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file split into byte ranges produces exactly the unsplit output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-split-"));
  try {
    const source = path.join(root, "source"), whole = path.join(root, "whole"), split = path.join(root, "split");
    await mkdir(source);
    const lines = Array.from({ length: 40 }, (_, index) => JSON.stringify({ ...session(3), request_time: `2026-10-19T15:39:${10 + index}.000Z` }));
    await writeFile(path.join(source, "2026-10-19.jsonl"), `${lines.join("\n")}\n`);

    const one = spawnSync(process.execPath, [script, "--source", source, "--target", whole, "--concurrency", "1", "--split", "0"], { encoding: "utf8" });
    assert.equal(one.status, 0, one.stderr);
    const many = spawnSync(process.execPath, [script, "--source", source, "--target", split, "--concurrency", "4", "--split", "20000", "--verify"], { encoding: "utf8" });
    assert.equal(many.status, 0, many.stderr);
    assert.equal(
      await readFile(path.join(split, "2026-10-19.jsonl"), "utf8"),
      await readFile(path.join(whole, "2026-10-19.jsonl"), "utf8"),
    );
    assert.match(many.stdout, /4 段|3 段|2 段/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gzip output reads back through expand mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-gzip-"));
  try {
    const source = path.join(root, "source"), target = path.join(root, "slim"), expanded = path.join(root, "back");
    await mkdir(source);
    const line = JSON.stringify(session());
    await writeFile(path.join(source, "2026-10-19.jsonl"), `${line}\n`);

    const run = spawnSync(process.execPath, [script, "--source", source, "--target", target, "--gzip", "--verify"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await readdir(target), ["2026-10-19.jsonl.gz"]);
    assert.ok((await stat(path.join(target, "2026-10-19.jsonl.gz"))).size < line.length / 2);

    const back = spawnSync(process.execPath, [script, "--source", target, "--target", expanded, "--expand", "--verify"], { encoding: "utf8" });
    assert.equal(back.status, 0, back.stderr);
    assert.deepEqual(await readdir(expanded), ["2026-10-19.jsonl"]);
    assert.equal(JSON.stringify(JSON.parse(await readFile(path.join(expanded, "2026-10-19.jsonl"), "utf8"))), line);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zstd output reads back through expand mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aime-slim-zstd-"));
  try {
    const source = path.join(root, "source"), target = path.join(root, "slim"), expanded = path.join(root, "back");
    await mkdir(source);
    const line = JSON.stringify(session());
    await writeFile(path.join(source, "2026-10-19.jsonl"), `${line}\n`);

    const run = spawnSync(process.execPath, [script, "--source", source, "--target", target, "--zstd", "--verify"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await readdir(target), ["2026-10-19.jsonl.zst"]);
    assert.ok((await stat(path.join(target, "2026-10-19.jsonl.zst"))).size < line.length / 2);

    const back = spawnSync(process.execPath, [script, "--source", target, "--target", expanded, "--expand", "--verify"], { encoding: "utf8" });
    assert.equal(back.status, 0, back.stderr);
    assert.deepEqual(await readdir(expanded), ["2026-10-19.jsonl"]);
    assert.equal(JSON.stringify(JSON.parse(await readFile(path.join(expanded, "2026-10-19.jsonl"), "utf8"))), line);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli rejects a missing target or an unknown flag", () => {
  const missing = spawnSync(process.execPath, [script, "--source", "."], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const unknown = spawnSync(process.execPath, [script, "--source", ".", "--target", "/tmp/x", "--nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
});
