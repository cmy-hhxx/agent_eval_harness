import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, appendFile, rm } from "node:fs/promises";
import { writeJson, writeJsonl } from "@eval/data";
import { createChannelRequests, freezeNightInputs, runNightBatch } from "../../../apps/host/src/night-evaluation.js";
import { fixtureConfig, raw } from "../../fixtures/comparison.js";

test("night input snapshot excludes archived data, ignores later files and rejects rewritten frozen inputs before model calls", async t => {
  const f = await fixtureConfig();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const versions = f.config.inputs.versions.slice(0, 2);
  for (const version of versions) {
    const folder = path.join(f.directory, ".prepared", version.id);
    await mkdir(path.join(folder, ".archive"), { recursive: true });
    await writeJsonl(path.join(folder, "2026-10-27.jsonl"), [{ ...raw(), batch_id: "2026-10-27" }]);
    await writeJsonl(path.join(folder, ".archive/old.jsonl"), [{ ...raw("old"), batch_id: "2026-10-26" }]);
    version.sources = [{ kind: "directory", path: folder }];
  }
  const config = path.join(f.directory, "night-host.json");
  await writeJson(config, { ...f.config, workflow: "attribution", evaluatorVersion: "fixture", inputs: { versions },
    models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } },
    bindings: { attribution: { profile: "judge" } } });
  const frozen = await freezeNightInputs([config], "attribution");
  assert.equal(frozen.inputs.records!.length, 2);
  assert(frozen.inputs.records!.every(row => row.batch_id === "2026-10-27"));
  const file = frozen.inputs.versions[0].sources[0].path;
  await writeJsonl(path.join(path.dirname(file), "2026-10-28.jsonl"), [{ ...raw("later"), batch_id: "2026-10-28" }]);
  assert.deepEqual(frozen.inputs.versions[0].sources, [{ kind: "file", path: file }]);
  await appendFile(file, "\n");
  const signal = new AbortController().signal;
  await assert.rejects(runNightBatch({ configs: [config], workflow: "attribution", ...frozen,
    output: f.config.output.path, runId: "frozen", channels: ["evaluation-gateway"],
    requests: createChannelRequests({ "evaluation-gateway": 200 }), signal, pauseSignal: signal }), /Frozen input changed/);
});
