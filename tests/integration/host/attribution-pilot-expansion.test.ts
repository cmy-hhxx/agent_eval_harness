import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJson } from "@eval/data";
import { attributionPilotFixture } from "../../fixtures/attribution-pilot.js";
import { fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

test("reattribute CLI previews bounded per-model expansion and rejects full-discovery or source selection mixing", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const configFile = path.join(fixture.directory, "host.json"); await writeJson(configFile, { ...fixture.baseConfig, evaluatorVersion: fakeEvaluatorVersion });
  const args = [path.join(ROOT, "dist/tests/fixtures/cli.js"), fixture.directory, "reattribute", "--run-id", "pilot", "--pilot-per-model", "3",
    "--output", path.join(fixture.directory, "attribution"), "--config", path.join(ROOT, "configs/host.json"), "--config", configFile];
  const file = path.join(fixture.run, "state.json"), before = await readFile(file, "utf8"), execute = promisify(execFile);
  const result = await execute(process.execPath, args, { env: process.env });
  const summary = JSON.parse(result.stdout); assert.equal(summary.pilot_answers, 12);
  assert(Object.values(summary.models as Record<string, { selected: number }>).every(model => model.selected === 3));
  assert.equal(await readFile(file, "utf8"), before);
  for (const extra of [["--discover-inputs"], ["--run", fixture.run], ["--from-date", "2026-10-01"], ["--pilot-answers", "12"]]) {
    await assert.rejects(execute(process.execPath, [...args, ...extra], { env: process.env }));
    assert.equal(await readFile(file, "utf8"), before);
  }
});
