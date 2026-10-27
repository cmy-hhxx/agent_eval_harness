import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLock } from "@eval/data";
import { deliver, helper, resolveConfig, scanInbox, signature } from "./auto-renew.mjs";
import { expandRecord } from "./aime-slim.mjs";

const name = "2026-10-27.jsonl", model = "aime_fast";
const entry = { status: "completed", line: 1, read_line: 1, processed_lines: 1, total_lines: 1,
  inflight_records: 0, ready_to_commit: 0, blocked_records: 0, translation_backlog_records: 0,
  annotation_backlog_records: 0, updated_at: new Date().toISOString() };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "auto-renew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = { inputDirectory: path.join(root, "input"), cleanDirectory: path.join(root, "clean"),
    targetDirectory: path.join(root, "slim"), dataState: path.join(root, "state") };
  for (const folder of [source.inputDirectory, source.cleanDirectory, source.targetDirectory]) await mkdir(path.join(folder, model), { recursive: true });
  await mkdir(source.dataState);
  const message = { role: "user", content: "question".repeat(100) };
  const row = { traces: [{ messages: [
    { type: "llm_turn", input_messages: [message] }, { type: "llm_turn", input_messages: [message] },
  ] }] };
  const raw = path.join(source.inputDirectory, model, name), clean = path.join(source.cleanDirectory, model, name);
  await writeFile(raw, JSON.stringify(row) + "\n");
  await writeFile(clean, JSON.stringify(row) + "\n");
  const info = await signature(raw);
  // mtime_ns is a JSON integer in the existing Python publisher, beyond JS's exact range.
  await writeFile(path.join(source.dataState, "2026-10-27.ready.json"),
    `{"rows":{"${model}":1},"files":{"${model}":{"size_bytes":${info.size},"mtime_ns":${info.mtime_ns}}}}`);
  await writeFile(path.join(source.dataState, "archive.lock"), "");
  await writeFile(path.join(source.cleanDirectory, model, ".status.lock"), "");
  const status = path.join(source.cleanDirectory, model, "status.json");
  const setStatus = async (change = {}) => writeFile(status, JSON.stringify({ files: { [name]: { ...entry, updated_at: new Date().toISOString(), ...change } } }));
  await setStatus();
  const call = (request) => helper("python3", request);
  const events = [];
  const options = { source, model, name, call, record: async (event, details) => events.push({ event, ...details }) };
  return { source, row, raw, clean, status, setStatus, call, events, options, target: path.join(source.targetDirectory, model, name) };
}

test("completed files round-trip, resume without receipt, and skip durable deliveries", async (t) => {
  const f = await fixture(t);
  const first = await deliver(f.options);
  assert.equal(first.rows, 1);
  assert.deepEqual(expandRecord(JSON.parse(await readFile(f.target, "utf8"))), f.row);
  const resumed = await deliver(f.options); // crash between rename and receipt save
  assert.equal(resumed.rows, 1);
  const before = await signature(f.target);
  assert.equal(await deliver({ ...f.options, receipt: resumed }), resumed);
  assert.deepEqual(await signature(f.target), before);
});

test("backlog, missing evidence, and raw input growth never publish", async (t) => {
  const f = await fixture(t);
  await f.setStatus({ status: "completed_with_backlog" });
  assert.equal(await deliver(f.options), null);
  await f.setStatus();
  await writeFile(f.raw, JSON.stringify(f.row) + "\n" + JSON.stringify(f.row) + "\n");
  assert.equal(await deliver(f.options), null);
  assert.equal(f.events.at(-1).reason, "input_not_fully_cleaned");
  await rm(f.status);
  assert.equal(await deliver(f.options), null);
  assert.equal(f.events.at(-1).reason, "missing_cleaning_evidence");
  await assert.rejects(readFile(f.target), { code: "ENOENT" });
});

test("source changes during slimming and malformed JSON preserve previous delivery", async (t) => {
  const f = await fixture(t);
  await writeFile(f.target, "previous delivery\n");
  const call = async (request) => {
    if (request.operation === "publish") await f.setStatus({ status: "processing", inflight_records: 1 });
    return f.call(request);
  };
  assert.equal(await deliver({ ...f.options, call }), null);
  assert.equal(await readFile(f.target, "utf8"), "previous delivery\n");
  await f.setStatus();
  await writeFile(f.clean, "{broken\n");
  await assert.rejects(deliver(f.options), SyntaxError);
  assert.equal(await readFile(f.target, "utf8"), "previous delivery\n");
});

test("active cleaner lock is observed without blocking or publishing", async (t) => {
  const f = await fixture(t);
  const lock = path.join(f.source.cleanDirectory, model, ".status.lock");
  const child = spawn("python3", ["-c", "import fcntl,sys; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", lock]);
  t.after(() => child.kill());
  await new Promise((resolve) => child.stdout.once("data", resolve));
  assert.equal(await deliver(f.options), null);
  assert.equal(f.events.at(-1).reason, "writer_active");
  child.stdin.end();
});

test("completed status cannot hide missing output records", async (t) => {
  const f = await fixture(t);
  await writeFile(f.clean, "");
  await assert.rejects(deliver(f.options), /清洗输出行数 0 与已完成输入行数 1 不一致/);
  await assert.rejects(readFile(f.target), { code: "ENOENT" });
});

test("stable packages proceed independently of another upload and observation survives restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renew-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "one.7z"), "one");
  await writeFile(path.join(directory, "two.7z"), "two");
  const first = await scanInbox(directory, {}, 1000, 0);
  assert.equal(first.packages.length, 0);
  await writeFile(path.join(directory, "two.7z"), "still uploading");
  const second = await scanInbox(directory, JSON.parse(JSON.stringify(first.observed)), 1000, 1001);
  assert.deepEqual(second.packages.map((item) => item.name), ["one.7z"]);
});

test("single-instance lock rejects a duplicate owner and releases for restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renew-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await runLock(directory);
  await assert.rejects(runLock(directory), /Run already owned/);
  await release();
  await (await runLock(directory))();
});

test("configuration forbids lost-user sources and overlapping input/output", () => {
  const config = { dataRoot: "/data", runtimeRoot: "/runtime", python: "python3", intervalSeconds: 30, stableSeconds: 30,
    sources: [{ id: "wencai", cleanDirectory: "wencai-clean", targetDirectory: "wencai-slim" },
      { id: "aime", cleanDirectory: "aime-clean", targetDirectory: "aime-slim" }] };
  assert.equal(resolveConfig(config).sources.length, 2);
  assert.throws(() => resolveConfig({ ...config, sources: [{ ...config.sources[0], id: "lost_user" }, config.sources[1]] }), /只能包含/);
  assert.throws(() => resolveConfig({ ...config, sources: [{ ...config.sources[0], targetDirectory: "wencai-clean/nested" }, config.sources[1]] }), /重叠/);
});
