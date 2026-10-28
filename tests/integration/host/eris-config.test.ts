import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJson } from "@eval/data";
import { readErisConfig } from "../../../apps/host/src/eris-config.js";

test("Eris resolves collection files and directories from their owning configuration", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "eris-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "eris.json"), collectionsFile = path.join(root, "layout/collections.json");
  const config = { runtimeRoot: "runtime", collectionsFile: "layout/collections.json", evalConfigFile: "model.ini",
    publicOrigin: "http://eris.example", listen: { host: "127.0.0.1", port: 0 } };
  await writeJson(collectionsFile, [{ id: "custom/feed", path: "../renamed/results" }]);
  await writeJson(file, config);
  const resolved = await readErisConfig(file);
  assert.equal(resolved.runtimeRoot, path.join(root, "runtime"));
  assert.equal(resolved.evalConfigFile, path.join(root, "model.ini"));
  assert.deepEqual(resolved.collections, [{ id: "custom/feed", path: path.join(root, "renamed/results"), test: false }]);
  await writeJson(collectionsFile, [{ id: "same", path: "a" }, { id: "same", path: "b" }]);
  await assert.rejects(readErisConfig(file), /重复/);
  await writeJson(file, { ...config, collectionsFile: "missing.json" });
  await assert.rejects(readErisConfig(file), /ENOENT/);
});
