import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { writeJson, writeJsonl } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import { startWorker } from "@eval/runtime/worker";
import { readRunState } from "@eval/workflows/comparison";
import { ROOT } from "../../fixtures/services.js";
import { fixtureConfig, raw, draftFor, taskResult, submitFor, inspectFor } from "../../fixtures/comparison.js";

test("CLI completes healthy records, reports the rejected row and exits with a partial result", async t => {
  const fixture = await fixtureConfig([[raw("healthy")], [], [raw("healthy")], []]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const bad = { ...raw("broken"), messages: [] };
  await writeJsonl(fixture.config.inputs.versions[0].sources[0].path, [raw("healthy"), bad]);
  const configFile = path.join(fixture.directory, "run.json");
  await writeJson(configFile, { ...fixture.config, models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } } });
  const worker = await startWorker({ identity: await loadIdentity("pi", ROOT), async createSession(options) {
    return { async run() {
      await inspectFor(options);
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(fixture.directory, "worker"));
  t.after(() => worker.close());
  let exitCode: unknown;
  try {
    await promisify(execFile)(process.execPath, [new URL("../../fixtures/cli.js", import.meta.url).pathname, fixture.directory,
      "run", "--config", path.join(ROOT, "configs/host.json"), "--config", configFile, "--run-id", "isolation", "--worker", worker.url],
    { timeout: 20_000, env: { ...process.env, EVAL_HOT_STATE_ROOT: path.join(fixture.directory, "hot") } });
  } catch (error) { exitCode = (error as { code: unknown }).code; }
  assert.equal(exitCode, 2);
  const saved = await readRunState(path.join(fixture.config.output.path, "isolation"));
  assert.equal(saved.manifest.status, "finished");
  assert.equal(saved.manifest.outcome, "partial");
  assert(Object.values(saved.manifest.states).every(state => state.status === "succeeded"));
  const issues = saved.manifest.preflight.issues as { source: string; line: number; case_id: string; reason: string }[];
  assert(issues.some(issue => issue.line === 2 && issue.case_id === "broken" && issue.source && issue.reason));
  assert(Object.keys(saved.receipts).length > 0);
});
