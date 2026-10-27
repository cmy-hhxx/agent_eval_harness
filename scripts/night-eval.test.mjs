import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, link, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileSourceReader } from "@eval/data";
import { admitLost, createNightDispatcher, dailyJobs, nextJob, resolveNightConfig } from "./night-eval.mjs";
import { deliverLost, ingestLost, lostHelper, registerPreparedLost } from "./night-data.mjs";
import { scanInbox } from "./auto-renew.mjs";
import { slimRecord, expandRecord } from "./aime-slim.mjs";

const model = "aime_fast", name = "2026-10-27.jsonl";
const row = id => ({ batch_id: "2026-10-27", case_id: id, meta: { session_id: id },
  traces: [{ meta: { trace_id: id }, messages: [
    { type: "llm_turn", input_messages: [{ role: "system", content: "long prompt".repeat(100) }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "long prompt".repeat(100) }] },
  ] }] });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "night-eval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { inputDirectory: path.join(root, "input"), cleanDirectory: path.join(root, "clean"), targetDirectory: path.join(root, "slim") };
  for (const directory of Object.values(config)) await mkdir(path.join(directory, model), { recursive: true });
  await writeFile(path.join(config.cleanDirectory, model, ".status.lock"), "");
  const state = { cleaned: {}, records: {}, deliveries: [], pending: {} };
  const call = request => lostHelper("python3", request);
  const publish = async (rows, extra = {}) => {
    // Three raw rows, including a row removed by external cleaning.
    const raw = rows.map(value => JSON.stringify(value)).join("\n") + "\n{\"filtered\":true}\n";
    await writeFile(path.join(config.inputDirectory, model, name), raw);
    await writeFile(path.join(config.inputDirectory, ".extract-lost-user.json"), JSON.stringify({
      archives: {}, files: { [`${model}/2026-10-27`]: { bytes: Buffer.byteLength(raw), rows: rows.length + 1 } },
    }));
    await writeFile(path.join(config.cleanDirectory, model, name), rows.map(value => JSON.stringify(value)).join("\n") + "\n");
    await writeFile(path.join(config.cleanDirectory, model, "status.json"), JSON.stringify({ files: { [name]: {
      status: "completed", line: rows.length + 1, read_line: rows.length + 1, processed_lines: rows.length + 1,
      total_lines: rows.length + 1, output_records: rows.length, inflight_records: 0, ready_to_commit: 0,
      blocked_records: 0, translation_backlog_records: 0, annotation_backlog_records: 0,
      updated_at: new Date().toISOString(), ...extra,
    } } }));
  };
  const deliver = (save = async () => {}, customCall = call) => deliverLost(config, state, model, name, save, async () => {}, customCall);
  return { config, state, call, publish, deliver };
}

test("filtered input count differs from output; immutable deliveries contain only new records", async t => {
  const f = await fixture(t);
  await f.publish([row("first")]); await f.deliver();
  const first = f.state.deliveries[0];
  const contents = await readFile(first.file, "utf8");
  assert.ok(JSON.parse(contents).traces[0].message_pool);
  assert.deepEqual(expandRecord(JSON.parse(contents)), row("first"));
  await f.publish([row("first"), row("second")]); await f.deliver();
  assert.equal(f.state.deliveries.length, 2);
  assert.equal(f.state.deliveries[1].rows, 1);
  assert.equal(JSON.parse(await readFile(f.state.deliveries[1].file, "utf8")).case_id, "second");
  assert.equal(await readFile(first.file, "utf8"), contents);
  assert.equal(await fileSourceReader.revision(first.file), first.revision);
  await f.deliver(); assert.equal(f.state.deliveries.length, 2);
});

test("prepared slim stock is admitted once and automatic cleaning only delivers later identities", async t => {
  const f = await fixture(t);
  const file = path.join(f.config.targetDirectory, model, name);
  await writeFile(file, JSON.stringify(slimRecord(row("first"))) + "\n");
  await mkdir(path.join(f.config.targetDirectory, model, ".archive"));
  await writeFile(path.join(f.config.targetDirectory, model, ".archive", "ignored.jsonl"), "invalid");
  assert.deepEqual(await registerPreparedLost(f.config, f.state, f.call), { files: 1, rows: 1 });
  f.state.jobs = []; f.state.nextAdmissionAt = 0;
  admitLost(f.state, [{ id: model }], "/out", 0, 7200000);
  assert.equal(f.state.jobs.length, 1);
  Object.assign(f.state, JSON.parse(JSON.stringify(f.state)));
  await f.publish([row("first")]); await f.deliver();
  assert.equal(f.state.deliveries.length, 1);
  await f.publish([row("first"), row("second")]); await f.deliver();
  assert.equal(f.state.deliveries.length, 2);
  assert.equal(f.state.deliveries[1].rows, 1);
  assert.equal(JSON.parse(await readFile(f.state.deliveries[1].file, "utf8")).case_id, "second");
  admitLost(f.state, [{ id: model }], "/out", 7200000, 7200000);
  assert.equal(f.state.jobs.length, 2);
  assert.equal(await fileSourceReader.revision(file), f.state.deliveries[0].revision);
});

test("invalid, duplicate or actively written prepared stock is rejected before admission", async t => {
  const f = await fixture(t);
  const file = path.join(f.config.targetDirectory, model, name);
  await writeFile(file, JSON.stringify(row("first")) + "\n");
  await assert.rejects(registerPreparedLost(f.config, f.state, f.call), /未完成瘦身/);
  const slim = slimRecord(row("first"));
  await writeFile(file, JSON.stringify(slim) + "\n" + JSON.stringify(slim) + "\n");
  await assert.rejects(registerPreparedLost(f.config, f.state, f.call), /重复身份/);
  assert.equal(f.state.deliveries.length, 0);
  assert.deepEqual(f.state.records, {});
  await writeFile(file, JSON.stringify(slim) + "\n");
  await assert.rejects(registerPreparedLost(f.config, f.state, async () => ({ writing: true })), /仍在写入/);
  const changing = async request => {
    const result = await f.call(request);
    if (!changing.called) changing.called = true;
    else await writeFile(file, JSON.stringify(slimRecord(row("second"))) + "\n");
    return result;
  };
  await assert.rejects(registerPreparedLost(f.config, f.state, changing), /发生变化/);
  assert.equal(f.state.deliveries.length, 0);
});

test("backlog only delays unfinished records; slim deliveries remain incremental", async t => {
  const f = await fixture(t);
  await f.publish([row("first")], { status: "completed_with_backlog", annotation_backlog_records: 1 });
  assert.equal(await f.deliver(), false);
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(f.state.pending[`${model}/${name}`].annotationBacklog, 1);
  assert.deepEqual(expandRecord(JSON.parse(await readFile(f.state.deliveries[0].file, "utf8"))), row("first"));
  await f.deliver();
  assert.equal(f.state.deliveries.length, 1);
  await f.publish([row("first"), row("repaired")]);
  assert.equal(await f.deliver(), true);
  assert.equal(f.state.deliveries.length, 2);
  assert.equal(f.state.deliveries[1].rows, 1);
  assert.equal(JSON.parse(await readFile(f.state.deliveries[1].file, "utf8")).case_id, "repaired");
  assert.deepEqual(f.state.pending, {});
});

test("active cleaner lock and an uncommitted partial tail do not block committed slim records", async t => {
  const f = await fixture(t);
  await f.publish([row("first")], { status: "processing", inflight_records: 1 });
  await writeFile(path.join(f.config.cleanDirectory, model, name), JSON.stringify(row("first")) + '\n{"partial":');
  const child = spawn("python3", ["-c", "import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()",
    path.join(f.config.cleanDirectory, model, ".status.lock")]);
  t.after(() => child.kill());
  await once(child.stdout, "data");
  assert.equal(await f.deliver(), false);
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(f.state.deliveries[0].rows, 1);
  child.stdin.end();
  await once(child, "exit");
});

test("concurrent appends do not starve publication and enter the following delivery", async t => {
  const f = await fixture(t);
  await f.publish([row("first")], { status: "processing" });
  const appending = async request => {
    if (request.operation === "publish") await f.publish([row("first"), row("second")]);
    return f.call(request);
  };
  await f.deliver(undefined, appending);
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(f.state.deliveries[0].rows, 1);
  await f.deliver();
  assert.equal(f.state.deliveries.length, 2);
  assert.equal(f.state.deliveries[1].rows, 1);
});

test("rewritten captured prefixes and incorrect committed output counts cannot be published", async t => {
  const f = await fixture(t);
  await f.publish([row("first")]);
  const changing = async request => {
    if (request.operation === "publish") await f.publish([{ ...row("first"), changed: true }]);
    return f.call(request);
  };
  assert.equal(await f.deliver(undefined, changing), false);
  assert.equal(f.state.deliveries.length, 0);
  await f.publish([row("first")], { output_records: 2 });
  await assert.rejects(f.deliver(), /清洗输出行数不符/);
});

test("fully filtered files finish without creating an evaluation delivery", async t => {
  const f = await fixture(t);
  await f.publish([]);
  await rm(path.join(f.config.cleanDirectory, model, name));
  assert.equal(await f.deliver(), true);
  assert.equal(f.state.deliveries.length, 0);
  assert.deepEqual(f.state.pending, {});
});

test("publication intent recovers crash after link without duplicate data or evaluation", async t => {
  const f = await fixture(t);
  await f.publish([row("first")]);
  let durable;
  const save = async () => { durable = structuredClone(f.state); };
  const crash = async request => {
    const result = await f.call(request);
    if (request.operation === "publish") throw new Error("simulated crash");
    return result;
  };
  await assert.rejects(f.deliver(save, crash), /simulated crash/);
  assert.ok(durable.publishing);
  Object.assign(f.state, durable);
  await f.deliver(); await f.deliver();
  assert.equal(f.state.deliveries.length, 1);
  assert.equal(Object.keys(f.state.records).length, 1);
});

test("changed, duplicate, or removed delivered identities fail instead of silently reusing results", async t => {
  const f = await fixture(t);
  await f.publish([row("first"), row("second")]); await f.deliver();
  await f.publish([row("first"), row("first")]);
  await assert.rejects(f.deliver(), /重复身份/);
  await f.publish([{ ...row("first"), changed: true }, row("second")]);
  await assert.rejects(f.deliver(), /被清洗改写/);
  await f.publish([row("first")]);
  await assert.rejects(f.deliver(), /删除了已交付记录/);
});

test("three sources dispatch concurrently without duplicating an active batch", async () => {
  const sources = ["wencai", "lost", "aime"];
  const state = { jobs: sources.map(source => ({ source, runId: source, status: "queued" })) };
  const runs = [];
  let drain, started;
  const barrier = new Promise(resolve => { drain = resolve; });
  const running = new Promise(resolve => { started = resolve; });
  const dispatch = createNightDispatcher(state, { save: async () => {}, record: async () => {}, run: async job => {
    runs.push(job.runId);
    if (runs.length === 3) started();
    await barrier;
    return { complete: true };
  } });
  const active = sources.map(source => dispatch.step(source));
  await running;
  assert.deepEqual(runs, sources);
  assert.equal(await dispatch.step("aime"), false);
  drain(); await Promise.all(active);
  await dispatch.settle();
  assert.ok(state.jobs.every(job => job.status === "completed"));
});

test("incremental admission survives restart and honors the two-hour interval", () => {
  const state = { jobs: [], nextAdmissionAt: 0, deliveries: [{ model, file: "/slim/one.jsonl", revision: "r1", admitted: false }] };
  const versions = [{ id: model, adapter: "a", name: "Fast" }];
  assert.equal(admitLost(state, versions, "/out", 0, 7200000), true);
  const resumed = JSON.parse(JSON.stringify(state));
  resumed.deliveries.push({ model, file: "/slim/two.jsonl", revision: "r2", admitted: false });
  assert.equal(admitLost(resumed, versions, "/out", 7199999, 7200000), false);
  assert.equal(admitLost(resumed, versions, "/out", 7200000, 7200000), true);
  assert.equal(resumed.jobs.length, 2);
  assert.notEqual(resumed.jobs[0].runId, resumed.jobs[1].runId);
});

test("tail overlap admits only one extra batch globally and drains on pause", async () => {
  const sources = ["wencai", "lost", "aime"], drains = [];
  const state = { jobs: sources.flatMap(source => [0, 1].map(index =>
    ({ source, runId: source + index, status: "queued" }))) };
  const dispatch = createNightDispatcher(state, { save: async () => {}, record: async () => {},
    canOverlap: async () => true, run: async () => {
      await new Promise(resolve => drains.push(resolve));
      return { complete: true };
    } });
  for (const source of sources) assert.equal(await dispatch.step(source), true);
  assert.equal(await dispatch.step("aime"), true);
  assert.equal(await dispatch.step("aime"), false);
  assert.equal(await dispatch.step("lost"), false);
  assert.equal(state.jobs.filter(job => job.status === "running").length, 4);
  await new Promise(resolve => setImmediate(resolve));
  dispatch.pause();
  assert.equal(await dispatch.step("lost"), false);
  drains.forEach(resolve => resolve());
  await dispatch.settle();
  assert.equal(state.jobs.filter(job => job.status === "completed").length, 4);
  assert.equal(state.jobs.filter(job => job.status === "queued").length, 2);
});

test("failed batches remain failed while later work continues, including after restart", async () => {
  const state = { jobs: [{ source: "wencai", runId: "w", status: "queued" }, { source: "wencai", runId: "next", status: "queued" }] };
  const runs = [];
  const dispatch = createNightDispatcher(state, { save: async () => {}, record: async () => {}, run: async job => {
    runs.push(job.runId);
    if (runs.length === 1) throw new Error("gateway unavailable");
    return { complete: true };
  } });
  await dispatch.step("wencai");
  await dispatch.settle();
  const failed = state.jobs[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryAt, undefined);
  assert.equal(nextJob(state, "wencai"), state.jobs[1]);
  await dispatch.step("wencai");
  await dispatch.settle();
  assert.equal(await dispatch.step("wencai"), false);
  assert.deepEqual(runs, ["w", "next"]);
  assert.equal(failed.status, "failed");
  assert.equal(nextJob(JSON.parse(JSON.stringify(state)), "wencai"), undefined);
});

test("stable archive is extracted once, archived, and resumes an interrupted hard-link move", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "night-ingest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = path.join(root, "inbox"), inputDirectory = path.join(root, "input");
  await mkdir(inbox); await mkdir(inputDirectory);
  const manifestFile = path.join(inputDirectory, ".extract-lost-user.json");
  await writeFile(manifestFile, JSON.stringify({ version: 2, archives: {}, files: {} }));
  const sevenZip = path.join(root, "7z");
  const source = { meta: { session_id: "s", agent_mode: "fast", request_time: "2026-10-27T01:00:00Z" },
    traces: [{ meta: { trace_id: "t", mode: "fast" }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }] };
  await writeFile(sevenZip, ["#!/usr/bin/env node", "const args = process.argv.slice(2);",
    "if (args[0] === 'l') console.log('Path = shard.jsonl');",
    `else process.stdout.write(${JSON.stringify(JSON.stringify(source) + "\n")});`,
  ].join("\n"), { mode: 0o755 });
  const name = "lost_user_20261027_0001.7z", incoming = path.join(inbox, name);
  await writeFile(incoming, "package");
  await writeFile(path.join(inbox, "lost_user_20261027_0002.7z"), "still uploading");
  const observed = (await scanInbox(inbox, {}, 1000, Date.now() - 2000)).observed;
  observed["lost_user_20261027_0002.7z"].since = Date.now();
  const state = { observed }, config = { inbox, inputDirectory, stableSeconds: 1, sevenZip };
  const call = request => lostHelper("python3", request);
  let interrupted = false;
  const crash = async request => {
    if (request.operation === "archive" && !interrupted) {
      interrupted = true;
      await mkdir(path.dirname(request.target), { recursive: true });
      await link(request.file, request.target);
      throw new Error("crash between link and unlink");
    }
    return call(request);
  };
  const errors = await ingestLost(config, state, async () => {}, async () => {}, crash);
  assert.match(errors[`archive/${name}`].reason, /crash/);
  const before = await readFile(path.join(inputDirectory, model, "2026-10-27.jsonl"), "utf8");
  state.observed = (await scanInbox(inbox, {}, 1000, Date.now() - 2000)).observed;
  state.closed = { packages: [name] };
  assert.deepEqual(await ingestLost(config, state, async () => {}, async () => {}, call), {});
  await assert.rejects(stat(incoming), { code: "ENOENT" });
  assert.equal(await readFile(path.join(inputDirectory, model, "2026-10-27.jsonl"), "utf8"), before);
  assert.equal((await stat(path.join(inbox, "lost_user_20261027_0002.7z"))).isFile(), true);
});

test("daily jobs freeze exact coordinates and outputs are the three agreed directories", () => {
  const frozen = { revisions: { "/input": "r" }, inputs: { versions: [], records: [
    { batch_id: "2026-10-26", case_id: "a" }, { batch_id: "2026-10-27", case_id: "b" },
  ] } };
  const jobs = dailyJobs("wencai", frozen, "/out");
  assert.deepEqual(jobs.map(job => job.runId), ["2026-10-26", "2026-10-27"]);
  assert.equal(jobs[0].inputs.records.length, 1);
  const config = resolveNightConfig({ dataRoot: "/data", runtimeRoot: "/runtime", settingsFile: "/runtime/config.ini",
    pollSeconds: 30, stableSeconds: 30, admissionSeconds: 7200, channels: ["a", "b"],
    hostConfigs: { wencai: ["w.json"], lost: ["a.json"], aime: ["a.json"] } }, "/configs/night.json");
  assert.equal(config.outputs.lost, "/data/1_aime/eval_output/3_lost_user_eval");
  assert.equal(config.lost.targetDirectory, "/data/1_aime/6_lost_user_eval_clean_slim");
});
