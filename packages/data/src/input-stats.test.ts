import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { localFiles, readJson } from "./files.js";
import { InputDirectoryStats } from "./input-stats.js";
async function inputRoot(prefix: string) {
  const parent = await mkdtemp(path.join(tmpdir(), prefix)), root = path.join(parent, "eval_input");
  await mkdir(root); return root;
}

test("directory file counts are visible before first-time line counting finishes", { timeout: 5000 }, async t => {
  const root = await inputRoot("input-stats-inventory-");
  await writeFile(path.join(root, "one.jsonl"), '{}\n'); await writeFile(path.join(root, "two.jsonl"), '{}\n');
  const stats = new InputDirectoryStats(path.join(root, "eval_input_stats.json"), root);
  let release!: () => void, entered!: () => void;
  const allowRead = new Promise<void>(resolve => { release = resolve; });
  const counting = new Promise<void>(resolve => { entered = resolve; });
  const stream = localFiles.stream;
  t.mock.method(localFiles, "stream", () => Readable.from((async function* () {
    entered(); await allowRead; yield Buffer.from('{}\n');
  })()) as ReturnType<typeof stream>);
  t.after(async () => { release(); await stats.close(); await rm(path.dirname(root), { recursive: true, force: true }); });
  await stats.initialize(); const pending = stats.refresh(); await counting;
  const page = await stats.browse(root);
  assert.equal(page.stats?.files, 2); assert.equal(page.stats?.records, 0); assert.equal(page.stats?.pendingFiles, 2);
  release(); await pending;
  assert.equal((await stats.browse(root)).stats?.records, 2);
  assert.equal((await stats.browse(root)).stats?.pendingFiles, 0);
});

test("input statistics count archives, update changed files only, remove deleted files, and constrain browsing", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "input-stats-")), input = path.join(root, "eval_input"), outside = root + "-outside";
  await mkdir(path.join(input, ".archive"), { recursive: true }); await mkdir(outside);
  await mkdir(path.join(input, ".hidden"));
  const current = path.join(input, "current.jsonl"), archived = path.join(input, ".archive/old.jsonl");
  await writeFile(current, '\uFEFF{}\r\n \t\r\n{"last":true}');
  await writeFile(archived, '{}\n'); await writeFile(path.join(input, ".hidden/secret.jsonl"), '{}\n');
  await symlink(outside, path.join(input, "link"));
  const reads: string[] = [], stream = localFiles.stream;
  t.mock.method(localFiles, "stream", (...args: Parameters<typeof stream>) => { reads.push(String(args[0])); return stream(...args); });
  const file = path.join(root, "eval_input_stats.json"), stats = new InputDirectoryStats(file, root);
  t.after(async () => { await stats.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await stats.initialize(); await stats.refresh();
  let page = await stats.browse(input);
  assert.equal(page.stats?.records, 3); assert.equal(page.stats?.files, 2);
  assert(page.entries.some(item => item.name === ".archive"));
  assert(!page.entries.some(item => item.name === ".hidden"));
  assert.equal(page.entries.find(item => item.name === "current.jsonl")?.kind, "file");
  await assert.rejects(stats.browse(current), /当前路径是文件/);
  assert.equal(reads.length, 2, "input discovery counts each file once");
  await stats.refresh(); assert.equal(reads.length, 2, "unchanged files are never reread");
  await writeFile(current, '{}\n{}\n{}\n'); await rm(archived); await stats.refresh();
  assert.equal(reads.length, 3); page = await stats.browse(input);
  assert.equal(page.stats?.records, 3); assert.equal(page.stats?.files, 1);
  const restored = new InputDirectoryStats(file, root); await restored.initialize();
  assert.equal((await restored.browse(input)).stats?.records, 3); await restored.close();
  const saved = await readJson<{ files: Record<string, unknown> }>(file);
  assert.equal(Object.hasOwn(saved.files, archived), false);
  await assert.rejects(stats.browse(outside), /允许的文件系统范围/);
  await assert.rejects(stats.browse(path.join(input, "link")), /允许的文件系统范围/);
  assert.equal((await stats.browse(undefined, false)).stats, undefined);
  assert((await stats.browse(input, true, true)).entries.some(item => item.name === ".hidden"));
  const next = path.join(root, "new_source", "eval_input"); await mkdir(next, { recursive: true });
  await writeFile(path.join(next, "new.jsonl"), '{}\n{}\n');
  assert((await stats.browse()).entries.some(item => item.name === "new_source"), "new directories are browsable before statistics refresh");
  await stats.refresh();
  assert.equal((await stats.browse(next)).stats?.records, 2, "new input folders are discovered without configuration");
  const created = await stats.createDirectory(root, "结果 文件夹");
  assert.equal(created.path, await realpath(path.join(root, "结果 文件夹")));
  await assert.rejects(stats.createDirectory(root, "结果 文件夹"), /已经存在/);
  await assert.rejects(stats.createDirectory(root, "../escape"), /路径分隔符/);
  await assert.rejects(stats.createDirectory(outside, "escape"), /允许的文件系统范围/);
});

test("files changing during a count remain visibly incomplete and are retried", async t => {
  const root = await inputRoot("input-stats-race-"), file = path.join(root, "one.jsonl");
  await writeFile(file, '{}\n');
  const stats = new InputDirectoryStats(path.join(root, "eval_input_stats.json"), root);
  t.after(async () => { await stats.close(); await rm(path.dirname(root), { recursive: true, force: true }); });
  const stream = localFiles.stream; let mutate = true;
  t.mock.method(localFiles, "stream", (...args: Parameters<typeof stream>) => {
    if (mutate) { mutate = false; appendFileSync(file, '{}\n'); }
    return stream(...args);
  });
  await stats.initialize(); await stats.refresh();
  assert.equal((await stats.browse(root)).stats?.pendingFiles, 1);
  assert.equal((await stats.browse(root)).stats?.records, 0);
  await stats.refresh();
  assert.equal((await stats.browse(root)).stats?.pendingFiles, 0);
  assert.equal((await stats.browse(root)).stats?.records, 2);
});

test("the background updater refreshes changed input files hourly", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const root = await inputRoot("input-stats-hourly-"), file = path.join(root, "one.jsonl");
  await writeFile(file, '{}\n');
  const stats = new InputDirectoryStats(path.join(root, "eval_input_stats.json"), root);
  t.after(async () => { await stats.close(); await rm(path.dirname(root), { recursive: true, force: true }); });
  let reads = 0, counted!: () => void; const stream = localFiles.stream;
  const secondRead = new Promise<void>(resolve => { counted = resolve; });
  t.mock.method(localFiles, "stream", (...args: Parameters<typeof stream>) => { if (++reads === 2) counted(); return stream(...args); });
  await stats.initialize(); stats.start(error => assert.fail(String(error))); await stats.refresh();
  await writeFile(file, '{}\n{}\n');
  t.mock.timers.tick(60 * 60 * 1000 - 1); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await secondRead; assert.equal(reads, 2); await stats.refresh();
  assert.equal((await stats.browse(root)).stats?.records, 2);
});
