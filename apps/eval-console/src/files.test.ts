import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { consoleLog, consolePath } from "./files.js";

test("console paths reject traversal and symlink escapes, while allowing new output directories", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "console-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "input")); await mkdir(path.join(root, "outside"));
  await symlink(path.join(root, "outside"), path.join(root, "input/link"));
  await assert.rejects(consolePath(path.join(root, "input/link/new"), [path.join(root, "input")]), /允许/);
  await assert.rejects(consolePath(path.join(root, "outside"), [path.join(root, "input")]), /允许/);
  assert.equal((await consolePath(path.join(root, "input/new/result"), [path.join(root, "input")])).kind, "directory");
  await assert.rejects(consolePath(path.join(root, "input/missing"), [path.join(root, "input")], true), /ENOENT/);
});

test("bounded log pagination retains older task errors and ignores unfinished tails", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "console-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "runtime.log");
  const rows = Array.from({ length: 3000 }, (_, i) => ({ run_id: i % 2 ? "other" : "test", level: i % 6 ? "info" : "error", i, message: "x".repeat(500) }));
  await writeFile(file, rows.map(row => JSON.stringify(row) + "\n").join("") + '{"unfinished":');
  let cursor: number | undefined, found: number[] = [];
  do {
    const page = await consoleLog(file, "test", true, cursor);
    found = found.concat(page.rows.map(row => row.i as number));
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(found.sort((a, b) => a - b), rows.filter(row => row.run_id === "test" && row.level === "error").map(row => row.i));
});
