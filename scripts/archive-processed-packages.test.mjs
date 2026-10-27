import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, archiveDay, organizeSource } from "./archive-processed-packages.mjs";

const script = fileURLToPath(new URL("./archive-processed-packages.mjs", import.meta.url));
const wencai = SOURCES.find((source) => source.key === "wencai");
const aime = SOURCES.find((source) => source.key === "aime");
const packages = (names) => names.filter((name) => name.endsWith(".7z")).sort();
const exists = (file) => stat(file).then(() => true, () => false);

/** One source with an empty inbox and an empty receipt file. */
async function setup(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data"), stateRoot = path.join(root, "state");
  const inbox = path.join(dataRoot, source.archive);
  const archived = path.join(inbox, "3_processed_archives");
  const receiptFile = path.join(stateRoot, source.state, "root-archives.json");
  await mkdir(inbox, { recursive: true });
  await mkdir(path.dirname(receiptFile), { recursive: true });
  return {
    root, dataRoot, stateRoot, inbox, archived, receiptFile,
    /** Write a package and return the receipt entry the data service would have recorded. */
    async add(name, { bytes = 16 } = {}) {
      const file = path.join(inbox, name);
      await writeFile(file, "x".repeat(bytes));
      const info = await stat(file, { bigint: true });
      return { name, size: Number(info.size), mtime_ns: Number(info.mtimeNs) };
    },
    async receipt(entries) {
      await writeFile(receiptFile, JSON.stringify({ archives: entries, dates: [], failed_archives: [] }));
    },
  };
}

test("归档目录名取自包名里的日期", () => {
  assert.equal(archiveDay("ainvest_20261020_160040.7z"), "20261020");
  assert.equal(archiveDay("804771ad29444e29_20261026_111422.7z"), "20261026");
  assert.equal(archiveDay("ainvest_recover_20261023_150618.7z"), "20261023");
  assert.equal(archiveDay("AINVEST_20261024_113614.7Z"), "20261024");
  assert.equal(archiveDay("parallel.7z"), null);
  assert.equal(archiveDay("x_20261301_000000.7z"), null);
  assert.equal(archiveDay("x_2026102_000000.7z"), null);
});

test("已处理的包按日归档，未处理的留在收包目录", async (t) => {
  const fixture = await setup(t, wencai);
  const older = await fixture.add("804771ad29444e29_20261023_111422.7z");
  const newer = await fixture.add("804771ad29444e29_20261026_111422.7z");
  const pending = await fixture.add("804771ad29444e29_20261026_121422.7z");
  await fixture.receipt([older, newer]);

  const report = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });

  assert.equal(report.scanned, 3);
  assert.equal(report.processed, 2);
  assert.deepEqual(report.moved, [older.name, newer.name]);
  assert.deepEqual(report.unprocessed, [pending.name]);
  assert.deepEqual(report.days, new Map([["20261023", 1], ["20261026", 1]]));
  assert.deepEqual(await readdir(path.join(fixture.archived, "20261023")), [older.name]);
  assert.deepEqual(await readdir(path.join(fixture.archived, "20261026")), [newer.name]);
  assert.deepEqual(packages(await readdir(fixture.inbox)), [pending.name]);
});

test("移动保留修改时间，回执依然有效", async (t) => {
  const fixture = await setup(t, wencai);
  const entry = await fixture.add("804771ad29444e29_20261026_111422.7z");
  await fixture.receipt([entry]);
  const before = await stat(path.join(fixture.inbox, entry.name), { bigint: true });

  await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });
  const after = await stat(path.join(fixture.archived, "20261026", entry.name), { bigint: true });

  assert.equal(after.mtimeNs, before.mtimeNs);
  // 回执仍然匹配归档位置上的文件，再次运行不会重新处理
  const again = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });
  assert.equal(again.scanned, 0);
  assert.equal(again.moved.length, 0);
});

test("回执与磁盘不一致时不动包", async (t) => {
  const fixture = await setup(t, wencai);
  const resized = await fixture.add("804771ad29444e29_20261026_111422.7z");
  const touched = await fixture.add("804771ad29444e29_20261023_111422.7z");
  // 同名重传：一个包的字节数变了，另一个包的修改时间变了
  await writeFile(path.join(fixture.inbox, resized.name), "y".repeat(resized.size + 8));
  const resizedInfo = await stat(path.join(fixture.inbox, resized.name), { bigint: true });
  const touchedInfo = await stat(path.join(fixture.inbox, touched.name), { bigint: true });
  await fixture.receipt([{ ...resized, mtime_ns: Number(resizedInfo.mtimeNs) },
    { ...touched, mtime_ns: Number(touchedInfo.mtimeNs) + 5_000_000 }]);

  const report = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });

  assert.equal(report.processed, 0);
  assert.deepEqual(report.moved, []);
  assert.deepEqual(report.unprocessed, [touched.name, resized.name]);
  assert.equal(await exists(fixture.archived), false);
});

test("没有 --apply 时只出计划，不动磁盘", async (t) => {
  const fixture = await setup(t, wencai);
  const entry = await fixture.add("804771ad29444e29_20261026_111422.7z");
  await fixture.receipt([entry]);

  const report = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot });

  assert.deepEqual(report.moved, [entry.name]);
  assert.equal(await exists(fixture.archived), false);
  assert.deepEqual(packages(await readdir(fixture.inbox)), [entry.name]);
});

test("归档目录已有同名包时不覆盖", async (t) => {
  const fixture = await setup(t, wencai);
  const entry = await fixture.add("804771ad29444e29_20261026_111422.7z");
  await fixture.receipt([entry]);
  const target = path.join(fixture.archived, "20261026", entry.name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "已经归档的那一份");

  const report = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });

  assert.deepEqual(report.moved, []);
  assert.deepEqual(report.existing, [entry.name]);
  assert.equal((await stat(target)).size, Buffer.byteLength("已经归档的那一份"));
  assert.deepEqual(packages(await readdir(fixture.inbox)), [entry.name]);
});

test("收包目录里的子目录和其他文件不参与归档", async (t) => {
  const fixture = await setup(t, wencai);
  await mkdir(path.join(fixture.inbox, "files"));
  await writeFile(path.join(fixture.inbox, "notes.txt"), "not a package");
  await fixture.receipt([]);

  const report = await organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });

  assert.equal(report.scanned, 0);
  assert.deepEqual(report.moved, []);
});

test("缺少处理回执时拒绝归档", async (t) => {
  const fixture = await setup(t, wencai);
  await fixture.add("804771ad29444e29_20261026_111422.7z");

  await assert.rejects(
    () => organizeSource(wencai, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true }),
    /缺少处理回执/,
  );
  assert.deepEqual(packages(await readdir(fixture.inbox)), ["804771ad29444e29_20261026_111422.7z"]);
});

test("问财与 AIME 各用自己的收包目录和回执", async (t) => {
  const fixture = await setup(t, aime);
  const entry = await fixture.add("ainvest_recover_20261024_113614.7z");
  await fixture.receipt([entry]);

  // 问财的回执不存在，只跑 AIME
  const report = await organizeSource(aime, { dataRoot: fixture.dataRoot, stateRoot: fixture.stateRoot, apply: true });

  assert.deepEqual(report.moved, [entry.name]);
  assert.deepEqual(await readdir(path.join(fixture.archived, "20261024")), [entry.name]);
});

test("命令行默认 dry-run，--apply 才移动", async (t) => {
  const fixture = await setup(t, wencai);
  const entry = await fixture.add("804771ad29444e29_20261026_111422.7z");
  await fixture.receipt([entry]);
  const run = (...args) => spawnSync(process.execPath, [script, "--data-root", fixture.dataRoot, "--state-root", fixture.stateRoot, ...args], { encoding: "utf8" });

  const dryRun = run("--source", "wencai");
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry-run/);
  assert.deepEqual(packages(await readdir(fixture.inbox)), [entry.name]);

  const applied = run("--source", "wencai", "--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(packages(await readdir(fixture.inbox)), []);
  assert.deepEqual(await readdir(path.join(fixture.archived, "20261026")), [entry.name]);

  const missing = spawnSync(process.execPath, [script, "--data-root", path.join(fixture.root, "absent"), "--state-root", fixture.stateRoot, "--source", "wencai"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /收包目录不存在/);
});
