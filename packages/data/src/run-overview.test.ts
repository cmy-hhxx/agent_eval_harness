import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLock, writeJson } from "./files.js";
import { readRunOverviews, rebuildRunOverviews, writeRunOverview } from "./run-overview.js";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "run-overview-")), run = path.join(directory, "run");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeJson(path.join(run, "state.json"), { count: 1, material: "not part of the overview" });
  await writeRunOverview(run, { count: 1 });
  return { directory, run };
}

test("run overviews report missing, damaged and replaced checkpoints without silently rescanning", async t => {
  const { directory, run } = await fixture(t), file = path.join(run, "overview.json"), state = path.join(run, "state.json");
  assert.deepEqual(await readRunOverviews(directory), [{ runId: "run", value: { count: 1 } }]);
  assert(!(await readFile(file, "utf8")).includes("material"));
  const original = await readFile(state);
  await writeJson(state, JSON.parse(original.toString()));
  assert.match((await readRunOverviews(directory))[0]!.error!, /索引缺失、损坏或过期/,
    "an atomic state replacement invalidates the projection even when its content and size are unchanged");
  assert.deepEqual(await rebuildRunOverviews(directory, (saved: { count: number }) => ({ count: saved.count })), ["run"]);
  assert.deepEqual(await readFile(state), original, "rebuilding an overview must not alter the checkpoint");
  await writeFile(file, "{");
  assert.match((await readRunOverviews(directory))[0]!.error!, /索引缺失、损坏或过期/);
  await rm(file);
  assert.match((await readRunOverviews(directory))[0]!.error!, /rebuild-run-overviews/);
  await rm(state);
  await mkdir(path.join(directory, "unrelated"));
  assert.deepEqual(await readRunOverviews(directory), [], "removed runs and non-run directories are not counted");
  assert.deepEqual(await readRunOverviews(path.join(directory, "absent")), []);
});

test("overview rebuild respects the active run lock and refreshes counts after it is released", async t => {
  const { directory, run } = await fixture(t), file = path.join(run, "overview.json");
  const before = await readFile(file), release = await runLock(run);
  try {
    await writeJson(path.join(run, "state.json"), { count: 2 });
    await assert.rejects(rebuildRunOverviews(directory, (saved: { count: number }) => saved), /lock|active|owned|运行/i);
    assert.deepEqual(await readFile(file), before);
  } finally { await release(); }
  await rebuildRunOverviews(directory, (saved: { count: number }) => saved);
  assert.deepEqual(await readRunOverviews(directory), [{ runId: "run", value: { count: 2 } }]);
});

test("an unchanged checkpoint remains readable after its volume device number changes", async t => {
  const { directory } = await fixture(t);
  const originalStat = fs.stat;
  const mocked = t.mock.method(fs, "stat", async (file: string) => {
    const value = await originalStat(file);
    value.dev += 2;
    return value;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await readRunOverviews(directory), [{ runId: "run", value: { count: 1 } }]);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
