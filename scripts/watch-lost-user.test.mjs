import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveProcessed, packageDay } from "./watch-lost-user.mjs";

test("package day comes from the package name, with a date fallback", () => {
  assert.equal(packageDay("lost_user_20261010_0001.7z"), "20261010");
  assert.equal(packageDay("lost-user_20261010_0007.7z"), "20261010");
  assert.equal(packageDay("upload.7z", new Date("2026-10-27T03:04:05Z")), "20261027");
});

test("archiving moves processed packages and never overwrites an archived copy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lost-user-watch-"));
  try {
    const source = path.join(root, "inbox");
    const archiveDir = path.join(root, "archive");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "lost_user_20261010_0001.7z"), "one");
    await writeFile(path.join(source, "lost_user_20261010_0002.7z"), "two");
    const before = (await stat(path.join(source, "lost_user_20261010_0001.7z"))).mtimeMs;
    const state = { archives: { "lost_user_20261010_0001.7z": {} } };

    const { moved, kept } = await archiveProcessed({ source, archiveDir, names: ["lost_user_20261010_0001.7z", "lost_user_20261010_0002.7z"], state });
    assert.deepEqual(moved, [path.join("20261010", "lost_user_20261010_0001.7z")]);
    assert.deepEqual(kept, []);
    assert.equal((await stat(path.join(archiveDir, "20261010", "lost_user_20261010_0001.7z"))).mtimeMs, before);
    assert.ok(await stat(path.join(source, "lost_user_20261010_0002.7z")).catch(() => null));

    // A duplicate upload name must not replace the archived source of truth.
    await writeFile(path.join(source, "lost_user_20261010_0001.7z"), "again");
    const second = await archiveProcessed({ source, archiveDir, names: ["lost_user_20261010_0001.7z"], state });
    assert.deepEqual(second.moved, []);
    assert.equal(second.kept[0].reason, "archived_copy_exists");
    assert.equal(await readFile(path.join(archiveDir, "20261010", "lost_user_20261010_0001.7z"), "utf8"), "one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
