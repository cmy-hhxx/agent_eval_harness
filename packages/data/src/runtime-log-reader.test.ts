import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { RuntimeLogReader, type LogPosition } from "./runtime-log-reader.js";

test("runtime error reads are incremental, preserve incomplete UTF-8 tails, and reset on file replacement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runtime-reader-")), file = path.join(directory, "runtime.log");
  try {
    const reader = new RuntimeLogReader(file);
    let positions: LogPosition[] = [];
    const poll = () => reader.poll((_record, position) => { positions.push(position); }, () => { positions = []; });
    await poll(); assert.equal(positions.length, 0);
    const bytes = Buffer.from(JSON.stringify({ level: "error", message: "超时🙂" }) + "\n");
    const split = bytes.indexOf(Buffer.from("🙂")) + 1;
    await writeFile(file, bytes.subarray(0, split));
    await poll(); assert.equal(positions.length, 0);
    assert.deepEqual(await readFile(file), bytes.subarray(0, split), "the reader must not truncate partial records");
    await appendFile(file, bytes.subarray(split));
    await poll(); await poll(); assert.equal(positions.length, 1);
    assert.equal((await reader.read(positions[0])).message, "超时🙂");
    await appendFile(file, '{"level":"info"}\ninvalid complete line\n');
    await poll(); assert.equal(positions.length, 2);
    assert.equal((await reader.read(positions[1])).event, "invalid_log_record");
    const old = positions[0];
    await rename(file, file + ".old");
    await writeFile(file, '{"level":"error","message":"new"}\n');
    await poll(); assert.equal(positions.length, 1);
    await assert.rejects(reader.read(old), /changed/);
    await writeFile(file, ""); await poll(); assert.equal(positions.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
