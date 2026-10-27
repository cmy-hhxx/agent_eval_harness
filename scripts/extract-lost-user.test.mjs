import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aimeChannel,
  extract,
  normalizeAime,
  normalizeWencai,
  shanghaiDay,
  wencaiChannel,
} from "./extract-lost-user.mjs";

const aimeRecord = (session, mode, requestTime) => ({
  meta: { session_id: session, agent_mode: mode, request_time: requestTime, n_messages: 2 },
  traces: [{
    meta: { trace_id: "trace-" + session, mode: mode.split("-")[0], timestamp: requestTime },
    messages: [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }],
  }],
});

test("business dates are Asia/Shanghai dates", () => {
  assert.equal(shanghaiDay("2026-10-09T17:30:00Z"), "2026-10-10");
  assert.equal(shanghaiDay("2026-10-10T04:04:33.057Z"), "2026-10-10");
  assert.equal(shanghaiDay("2026-10-10 23:59:00"), "2026-10-10");
  assert.equal(shanghaiDay("2026-10-10T23:59:00+08:00"), "2026-10-10");
  assert.equal(shanghaiDay("not a time"), null);
});

test("AIME modes come from the session or its traces", () => {
  assert.equal(aimeChannel(aimeRecord("s", "fast-analyst", "2026-10-10T00:00:00Z")), "aime_fast");
  assert.equal(aimeChannel(aimeRecord("s", "expert", "2026-10-10T00:00:00Z")), "aime_expert");
  const traceOnly = { meta: {}, traces: [{ meta: { mode: "expert" }, messages: [{}] }] };
  assert.equal(aimeChannel(traceOnly), "aime_expert");
  const conflicting = {
    meta: { agent_mode: "fast" },
    traces: [{ meta: { mode: "expert" }, messages: [{}] }],
  };
  // The session-level mode wins, exactly as the data service publishes AIME rows.
  assert.equal(aimeChannel(conflicting), "aime_fast");
  const unknown = { meta: {}, traces: [{ meta: { mode: "expert" }, messages: [{}] }, { meta: { mode: "fast" }, messages: [{}] }] };
  assert.equal(aimeChannel(unknown), null);
});

test("Wencai members map A to a and AA/B to b", () => {
  assert.equal(wencaiChannel("pkg_A-fast.incr00458.jsonl"), "a_fast");
  assert.equal(wencaiChannel("pkg_AA-expert.incr1.jsonl"), "b_expert");
  assert.equal(wencaiChannel("pkg_B-fast.jsonl"), "b_fast");
  assert.equal(wencaiChannel("shard_20261010_0001.jsonl"), null);
  assert.equal(wencaiChannel("pkg_A-normal.jsonl"), null);
});

test("AIME rows get the published input contract", () => {
  const origin = { archive: "lost_user_20261010_0001.7z", member: "shard.jsonl", line: 4, item: 1 };
  const source = aimeRecord("thread_1", "fast-analyst", "2026-10-09T17:30:00Z");
  const { channel, day, row, line } = normalizeAime(source, origin, JSON.stringify(source));
  assert.deepEqual(JSON.parse(line), row);
  assert.equal(channel, "aime_fast");
  assert.equal(day, "2026-10-10");
  assert.equal(row.request_time, "2026-10-09T17:30:00Z");
  assert.equal(row.has_standard_answer, false);
  assert.equal(row.versions, "default");
  assert.equal(row.batch_id, "2026-10-10");
  assert.equal(row.case_id, "trace-thread_1");
  assert.equal(row.trace_id, "trace-thread_1");
  assert.equal(row.version, "aime_fast");
  assert.deepEqual(row._source, {
    original_file: "lost_user_20261010_0001.7z/shard.jsonl",
    original_line: 4,
    original_item: 1,
  });
  assert.equal(row.traces.length, 1);
});

test("AIME metadata file references are projected", () => {
  const record = aimeRecord("thread_2", "expert", "2026-10-10T00:00:00Z");
  record.meta.file_refs = [{ fileName: "shot.jpg", filePath: "/harness/file-ref/x", contentType: null, dsw_file_name: "abc.jpg" }];
  const { row } = normalizeAime(record, { archive: "a.7z", member: "m.jsonl", line: 1, item: 1 });
  assert.deepEqual(row.files, [{ fileName: "shot.jpg", filePath: "/harness/file-ref/x", contentType: null, dsw_file_name: "abc.jpg" }]);
});

test("Wencai rows flatten a single trace onto messages", () => {
  const record = {
    meta: { case_id: "case-1", request_time: "2026-10-10 09:00:00" },
    traces: [{
      meta: { trace_id: "trace-1", timestamp: "2026-10-10 09:00:00" },
      messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    }],
  };
  const { channel, day, row } = normalizeWencai(record, { archive: "p.7z", member: "p_A-fast.jsonl", line: 1, item: 1 }, "a_fast");
  assert.equal(channel, "a_fast");
  assert.equal(day, "2026-10-10");
  assert.equal(row.version, "A Fast");
  assert.equal(row.case_id, "case-1");
  assert.equal(row.trace_id, "trace-1");
  assert.equal(row.traces, undefined);
  assert.equal(row.messages.length, 2);
  assert.equal(row.meta.request_time, "2026-10-10 09:00:00");
});

test("Wencai b_fast carries the post-0929 versions marker", () => {
  const record = { meta: { case_id: "case-2", request_time: "2026-10-10T01:00:00Z" }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] };
  const { day, row } = normalizeWencai(record, { archive: "p.7z", member: "p_AA-fast.jsonl", line: 1, item: 1 }, "b_fast");
  assert.equal(day, "2026-10-10");
  assert.equal(row.version, "B Fast");
  assert.equal(row.versions, "0929-big-fast");
});

test("extract rebuilds the channel tree and reports rejects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lost-user-"));
  try {
    const source = path.join(root, "inbox");
    const target = path.join(root, "input");
    await writeFile(path.join(root, "keep"), "");
    await (await import("node:fs/promises")).mkdir(source, { recursive: true });

    const aime = [
      aimeRecord("thread_1", "fast-analyst", "2026-10-09T17:30:00Z"),
      aimeRecord("thread_1", "fast-analyst", "2026-10-09T17:30:00Z"),
      aimeRecord("thread_2", "expert", "2026-10-10T01:00:00Z"),
      { meta: { agent_mode: "fast", request_time: "2026-10-10T00:00:00Z" }, traces: [{ meta: {}, messages: [{}] }] },
    ];
    const wencai = [
      { meta: { case_id: "case-1", request_time: "2026-10-10 09:00:00" }, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] },
    ];
    const payloads = {
      "shard_1.jsonl": aime.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "pack_A-fast.incr1.jsonl": wencai.map((row) => JSON.stringify(row)).join("\n") + "\n",
    };
    const data = path.join(root, "members.json");
    const first = path.basename(path.join(source, "lost_user_20261010_0001.7z"));
    await writeFile(data, JSON.stringify({ [first]: payloads }));

    const stub = path.join(root, "7z");
    await writeFile(stub, [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "const archives = JSON.parse(readFileSync(process.env.STUB_DATA, 'utf8'));",
      "const name = path.basename(args.at(-2));",
      "if (args[0] === 'l') { const members = archives[path.basename(args.at(-1))] ?? {}; console.log('Path = ' + args.at(-1)); console.log('----------'); for (const m of Object.keys(members)) console.log('Path = ' + m); }",
      "else if (args[0] === 'x') { process.stdout.write((archives[name] ?? {})[args.at(-1)] ?? ''); }",
      "else process.exit(9);",
    ].join("\n"), { mode: 0o755 });
    await writeFile(path.join(source, "lost_user_20261010_0001.7z"), "stub");
    process.env.STUB_DATA = data;
    try {
      const summary = await extract({ source, target, sevenZip: stub, quiet: true, log: () => {} });
      assert.equal(summary.archives, 1);
      assert.equal(summary.rows, 5);
      assert.equal(summary.accepted, 3);
      assert.equal(summary.duplicates, 1);
      assert.equal(summary.invalid, 1);
      assert.equal(summary.skipped.case_id_missing, 1);
      assert.deepEqual(summary.files, { "aime_fast/2026-10-10": 1, "aime_expert/2026-10-10": 1, "a_fast/2026-10-10": 1 });

      const fast = (await readFile(path.join(target, "aime_fast/2026-10-10.jsonl"), "utf8")).trim().split("\n");
      assert.equal(fast.length, 1);
      const row = JSON.parse(fast[0]);
      assert.equal(row.case_id, "trace-thread_1");
      assert.equal(row.version, "aime_fast");
      assert.equal(row.batch_id, "2026-10-10");
      assert.equal(row._source.original_file, "lost_user_20261010_0001.7z/shard_1.jsonl");

      const wencaiRow = JSON.parse((await readFile(path.join(target, "a_fast/2026-10-10.jsonl"), "utf8")).trim());
      assert.equal(wencaiRow.version, "A Fast");
      assert.equal(wencaiRow.messages.length, 2);
      assert.equal(wencaiRow.traces, undefined);

      const again = await extract({ source, target, sevenZip: stub, quiet: true, log: () => {} });
      assert.equal(again.unchanged, true);
      assert.equal((await readFile(path.join(target, "aime_fast/2026-10-10.jsonl"), "utf8")).trim().split("\n").length, 1);

      // A new package appends only its new rows; a re-exported trace is skipped.
      const second = "lost_user_20261010_0002.7z";
      const extra = [
        aimeRecord("thread_3", "expert", "2026-10-10T02:00:00Z"),
        aimeRecord("thread_1", "fast-analyst", "2026-10-09T17:30:00Z"),
      ];
      const all = JSON.parse(await readFile(data, "utf8"));
      all[second] = { "shard_2.jsonl": extra.map((row) => JSON.stringify(row)).join("\n") + "\n" };
      await writeFile(data, JSON.stringify(all));
      await writeFile(path.join(source, second), "stub");

      const incremental = await extract({ source, target, sevenZip: stub, quiet: true, log: () => {} });
      assert.equal(incremental.incremental, true);
      assert.equal(incremental.accepted, 1);
      assert.equal(incremental.duplicates, 1);
      assert.equal(incremental.files["aime_expert/2026-10-10"], 2);
      assert.equal((await readFile(path.join(target, "aime_expert/2026-10-10.jsonl"), "utf8")).trim().split("\n").length, 2);

      // Archiving moves the package but keeps its name, so the manifest still
      // matches and nothing is extracted twice.
      const archived = path.join(source, "3_processed_archives", "20261010");
      await mkdir(archived, { recursive: true });
      for (const name of [first, second]) await rename(path.join(source, name), path.join(archived, name));
      const afterArchive = await extract({ source, target, sevenZip: stub, quiet: true, log: () => {} });
      assert.equal(afterArchive.unchanged, true);
      assert.equal(afterArchive.archives, 2);
    } finally {
      delete process.env.STUB_DATA;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
