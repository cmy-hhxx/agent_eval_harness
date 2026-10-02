import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileSourceReader } from "./sources.js";

test("streamed input lines preserve coordinates and reject a changed source revision", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-source-test-"));
  const file = path.join(directory, "answers.jsonl");
  try {
    await writeFile(file, '\uFEFF{"case_id":"first"}\r\n{"case_id":"second"}\r\n{"case_id":"third"}\r{"case_id":"fourth"}\n');
    const revision = await fileSourceReader.revision(file);
    const lines: { line: string; index: number; byteOffset: number; byteLength: number }[] = [];
    for await (const entry of fileSourceReader.lines(file, revision)) lines.push(entry);
    assert.deepEqual(lines.map(({ line, index }) => ({ line, index })), [
      { line: '{"case_id":"first"}', index: 1 },
      { line: '{"case_id":"second"}', index: 2 },
      { line: '{"case_id":"third"}\r{"case_id":"fourth"}', index: 3 },
    ]);
    const source = await readFile(file);
    for (const { line, byteOffset, byteLength } of lines) {
      assert.equal(source.subarray(byteOffset, byteOffset + byteLength).toString("utf8"), line);
      assert.equal(fileSourceReader.record(file, byteOffset, byteLength, revision), line);
    }
    await writeFile(file, '{"case_id":"changed"}\n');
    assert.throws(() => fileSourceReader.record(file, lines[0].byteOffset, lines[0].byteLength, revision), /输入文件发生变化/);
    await assert.rejects(async () => {
      for await (const _entry of fileSourceReader.lines(file, revision)) { /* read to completion */ }
    }, /输入文件发生变化/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
