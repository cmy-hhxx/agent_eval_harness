import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishTree } from "./lib.mjs";

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "publish-tree-"));
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("publishTree replaces staged files in place and removes obsolete output afterwards", async () => {
  const { root, dispose } = await scratch();
  try {
    const source = path.join(root, "staged"), destination = path.join(root, "dist");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "entry.js"), "new entry");
    await writeFile(path.join(source, "nested", "module.js"), "new module");
    await mkdir(path.join(destination, "gone"), { recursive: true });
    await writeFile(path.join(destination, "entry.js"), "old entry");
    await writeFile(path.join(destination, "stale.js"), "stale");
    await writeFile(path.join(destination, "gone", "old.js"), "old");
    await publishTree(source, destination);
    assert.equal(await readFile(path.join(destination, "entry.js"), "utf8"), "new entry");
    assert.equal(await readFile(path.join(destination, "nested", "module.js"), "utf8"), "new module");
    await assert.rejects(readFile(path.join(destination, "stale.js")), { code: "ENOENT" });
    await assert.rejects(readdir(path.join(destination, "gone")), { code: "ENOENT" });
  } finally {
    await dispose();
  }
});

test("publishTree removes the managed tree when staging has no files for it", async () => {
  const { root, dispose } = await scratch();
  try {
    const destination = path.join(root, "dist");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "entry.js"), "old entry");
    await publishTree(path.join(root, "missing"), destination);
    await assert.rejects(readdir(destination), { code: "ENOENT" });
  } finally {
    await dispose();
  }
});
