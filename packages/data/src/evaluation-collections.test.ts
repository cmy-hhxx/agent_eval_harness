import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { resolveEvaluationCollections } from "./evaluation-collections.js";
import { assistantRunLocations } from "./assistant-runs.js";

test("collection IDs, filesystem names and test classification are independent", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "collections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collections = resolveEvaluationCollections([
    { id: "new-source/daily", path: "outputs/current" },
    { id: "new-source/trials", path: "elsewhere/experiments", test: true },
  ], root);
  const save = async (directory: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ workflow: "attribution" }));
  };
  await save(path.join(collections[0].path, "task/run"));
  await save(path.join(collections[1].path, "trial"));
  await save(path.join(root, "unregistered/input"));
  const visible = await assistantRunLocations(collections);
  assert.deepEqual(visible.errors, []);
  assert.deepEqual(visible.runs.map(({ collectionId, runId }) => ({ collectionId, runId })),
    [{ collectionId: "new-source/daily/task", runId: "run" }]);
  assert.equal((await assistantRunLocations(collections, true)).runs.length, 2);
  for (const invalid of [[], [{ id: "../escape", path: "outputs" }],
    [{ id: "a", path: "outputs", test: "yes" }],
    [{ id: "a", path: "outputs" }, { id: "a", path: "other" }],
    [{ id: "a", path: "outputs" }, { id: "b", path: "./outputs" }]])
    assert.throws(() => resolveEvaluationCollections(invalid, root));
});
