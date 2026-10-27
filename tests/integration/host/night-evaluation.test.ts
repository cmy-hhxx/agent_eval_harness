import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, appendFile, rm } from "node:fs/promises";
import { writeJson, writeJsonl } from "@eval/data";
import { createChannelRequests, freezeNightInputs, runNightBatch } from "../../../apps/host/src/night-evaluation.js";
import { fixtureConfig, raw } from "../../fixtures/comparison.js";

for (const workflow of ["comparison", "attribution"] as const) {
  test(`night ${workflow} records invalid inputs and continues valid work without accepting incomplete comparisons`, async t => {
    const f = await fixtureConfig();
    t.after(() => rm(f.directory, { recursive: true, force: true }));
    const versions = f.config.inputs.versions;
    const good = { ...raw("good"), batch_id: "2026-10-27" };
    for (const version of versions) {
      const file = path.join(f.directory, ".prepared", version.id, "2026-10-27.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      const bad = { ...raw("bad"), batch_id: "2026-10-27" };
      if (version.id === "b_fast") bad.messages = [];
      await writeJsonl(file, [good, bad]);
      version.sources = [{ kind: "file", path: file }];
    }
    const config = path.join(f.directory, "night-host.json");
    await writeJson(config, { ...f.config, workflow, evaluatorVersion: "fixture", inputs: { versions },
      models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } },
      bindings: { attribution: { profile: "judge" } } });
    const frozen = await freezeNightInputs([config], workflow);
    assert.equal(frozen.inputs.records!.length, workflow === "comparison" ? 4 : 7);
    assert.equal(frozen.excludedInputs.length, workflow === "comparison" ? 4 : 1);
    assert(frozen.inputs.records!.every(row => row.case_id !== "bad" || workflow === "attribution"));
    assert(frozen.excludedInputs.some(issue => issue.version === "b_fast" && issue.line === 2));
    await appendFile(versions[0].sources[0].path, JSON.stringify(good) + "\n");
    await assert.rejects(freezeNightInputs([config], workflow), /duplicate_input/);
  });
}

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
