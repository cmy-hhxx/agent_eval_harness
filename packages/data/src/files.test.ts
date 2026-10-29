import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import filesystem from "node:fs/promises";
import { constants } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { exists, hasLiveRunOwner, readJson, readJsonl, readJsonlText, runLock, writeJson, writeCheckpointJson } from "./files.js";

const deadOwner = { pid: 2147483647, token: "dead-owner" };

test("JSON reads preserve nested values, escaped strings, Unicode and own object keys", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-json-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const nested = JSON.parse('{"__proto__":{"value":1},"constructor":2,"items":[null,true,false,-0,1.25e10]}');
  const text = JSON.stringify({ nested, text: "x".repeat(65530) + "中文😀\u2028\u2029" + "\\\"\n\ud800".repeat(1000) });
  await writeFile(file, text);
  assert.deepEqual(await readJson(file), JSON.parse(text));
  for (const value of [null, true, false, 17, "中文", []]) {
    await writeFile(file, JSON.stringify(value));
    assert.deepEqual(await readJson(file), value);
  }
  for (const text of ['-0', '1e400', '{"duplicate":1,"duplicate":2}', '"\\ud800\\udc00\\ud800x\\udc00"',
    '{"\ufeffkey":"\ufeffvalue"}', '"' + "x".repeat(65534) + '😀汉"']) {
    await writeFile(file, text);
    assert.deepEqual(await readJson(file), JSON.parse(text));
  }
  const malformedUtf8 = Buffer.from([34, 0xc0, 0xaf, 34]);
  await writeFile(file, malformedUtf8);
  assert.deepEqual(await readJson(file), JSON.parse(malformedUtf8.toString("utf8")));
  await assert.rejects(readJson(path.join(directory, "missing.json")), { code: "ENOENT" });
});

test("JSON reads reject incomplete documents, trailing values and invalid JSON", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-json-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  for (const text of ["", " ", '{"missing":', '[]{}', "true false", '"unfinished',
    '{"number":01}', "[1,]", '{"a":1,}', '"\\uZZZZ"', '"\u0001"', "NaN", "Infinity", "\ufeff{}", '"\\\ufeff"']) {
    await writeFile(file, text);
    await assert.rejects(readJson(file), SyntaxError, JSON.stringify(text));
  }
});

test("JSON checkpoints larger than the maximum string length remain readable", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-json-large-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json"), handle = await open(file, "w");
  try {
    await handle.writeFile('{"head":true,"items":{"one":1,');
    const chunk = Buffer.alloc(8 * 1024 * 1024, 32);
    for (let bytes = 0; bytes <= constants.MAX_STRING_LENGTH; bytes += chunk.length) await handle.write(chunk);
    await handle.writeFile('"two":2},"tail":true}');
  } finally { await handle.close(); }
  assert.deepEqual(await readJson(file), { head: true, items: { one: 1, two: 2 }, tail: true });
});

test("JSONL preserves long records, split UTF-8, blank lines and the trailing-line policy", async (t) => {
  async function collect<T>(source: AsyncIterable<T>) {
    const values: T[] = [];
    for await (const value of source) values.push(value);
    return values;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-jsonl-chunks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { text: "x".repeat(65525) + "汉字😀".repeat(20000) };
  const first = JSON.stringify(value), last = JSON.stringify({ end: "尾行" });
  const text = " \r\n" + first + "\r\n\n{}\n" + last;
  for (const suffix of ["jsonl", "jsonl.gz"]) {
    const file = path.join(directory, "records." + suffix);
    await writeFile(file, suffix.endsWith("gz") ? gzipSync(text) : text);
    assert.deepEqual(await collect(readJsonlText(file)), [first + "\r", "{}"]);
    assert.deepEqual(await collect(readJsonlText(file, true)), [first + "\r", "{}", last]);
    assert.deepEqual(await collect(readJsonl(file)), [value, {}, { end: "尾行" }]);
  }
  const file = path.join(directory, "incomplete.jsonl");
  await writeFile(file, '{}\n{"partial":');
  assert.deepEqual(await collect(readJsonlText(file)), ["{}"]);
  await assert.rejects(collect(readJsonl(file)), SyntaxError);
});

test("run lock publishes a complete owner before concurrent callers can observe it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-publish-"));
  const originalOpen = filesystem.open;
  let started!: () => void, resume!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const ready = new Promise<void>((resolve) => { resume = resolve; });
  let paused = false;
  t.mock.method(filesystem, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (!paused && args[1] === "wx" && path.basename(String(args[0])).startsWith(".run-lock")) {
      paused = true;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data, options) => { started(); await ready; return write(data, options); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  const first = runLock(directory);
  let contender: ReturnType<typeof runLock> | undefined;
  try {
    await writing;
    contender = runLock(directory);
    const [second] = await Promise.allSettled([contender]);
    resume();
    const [initial] = await Promise.allSettled([first]);
    assert.equal(second.status, "fulfilled", second.status === "rejected" ? String(second.reason) : "");
    assert.equal(initial.status, "rejected", "the first caller cannot overwrite the published owner");
    if (initial.status === "rejected") assert.match(String(initial.reason), /Run already owned by host PID /);
  } finally {
    resume();
    for (const result of await Promise.allSettled(contender ? [first, contender] : [first]))
      if (result.status === "fulfilled") await result.value();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("run lock excludes a second host and is released only by its owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock");
  assert.equal(await hasLiveRunOwner(directory), false);
  const release = await runLock(directory);
  assert.equal(await hasLiveRunOwner(directory), true);
  await assert.rejects(runLock(directory), /owned/);
  const owner = await readFile(file, "utf8");
  await writeJson(file, { pid: process.pid, token: "replacement-owner" });
  await release();
  assert.equal(await exists(file), true);
  await writeFile(file, owner);
  await release();
  assert.equal(await hasLiveRunOwner(directory), false);
  await (await runLock(directory))();
});

test("run lock reclaims a dead owner without leaving a recovery marker", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeJson(path.join(directory, ".run-lock"), deadOwner);
  assert.equal(await hasLiveRunOwner(directory), false);
  const release = await runLock(directory);
  assert.equal(await hasLiveRunOwner(directory), true);
  assert.equal(await exists(path.join(directory, ".run-lock.reclaim")), false);
  await release();
});

test("run lock refuses a recovery marker even when the owner file is absent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock"), guard = file + ".reclaim";
  await mkdir(guard);
  await assert.rejects(runLock(directory), /recovery in progress/);
  assert.equal(await exists(file), false);
  for (const owner of [deadOwner, { pid: process.pid, token: "live-owner" }]) {
    await writeJson(file, owner);
    await assert.rejects(runLock(directory), /recovery in progress/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), owner);
  }
  assert.equal(await exists(guard), true);
});

test("malformed lock owners are never probed, reclaimed or silently replaced", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock");
  const probe = t.mock.method(process, "kill");
  for (const text of ["", "{", ...[
    null, [], {}, { pid: deadOwner.pid }, { token: "missing-pid" },
    ...[0, -1, 1.5, "123", 2147483648, Number.MAX_SAFE_INTEGER].map((pid) => ({ pid, token: "invalid-pid" })),
    ...[null, 123, "", " "].map((token) => ({ pid: deadOwner.pid, token })),
  ].map((owner) => JSON.stringify(owner))]) {
    await writeFile(file, text);
    await assert.rejects(hasLiveRunOwner(directory), /lock is incomplete/);
    await assert.rejects(runLock(directory), /lock is incomplete/);
    assert.equal(await readFile(file, "utf8"), text);
  }
  assert.equal(probe.mock.calls.length, 0);
});


test("checkpoint writes bounded JSON pieces and preserves the previous snapshot on failure", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-checkpoint-stream-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const state = { rows: Array.from({ length: 500 }, (_, id) => ({ id, text: "中文😀".repeat(1000) })), empty: [undefined, null], absent: undefined };
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", ((value: unknown) => {
    assert(value === null || typeof value !== "object", "the writer must never stringify the aggregate state");
    return stringify(value);
  }) as typeof JSON.stringify);
  const bytes = await writeCheckpointJson(file, state);
  const text = await readFile(file, "utf8");
  assert.equal(bytes, Buffer.byteLength(text));
  assert.deepEqual(JSON.parse(text), { rows: state.rows, empty: [null, null] });
  const circular: { self?: unknown } = {}; circular.self = circular;
  await assert.rejects(writeCheckpointJson(file, circular), /Circular/);
  assert.equal(await readFile(file, "utf8"), text);
});
