import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type RunState } from "@eval/contracts";
import { writeJson, readJson } from "@eval/data";
import { attributionRepository, planAttribution, type AttributionConfig } from "@eval/workflows/attribution";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

test("attribution CLI skip-failed clears the requested pause without retrying failed, timed-out or blocked tasks", { timeout: 12000 }, async t => {
  const f = await fixtureConfig([[raw()], [], [], []]), runId = "skip-failed", run = path.join(f.config.output.path, runId);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 2) } } as AttributionConfig;
  const plan = await planAttribution(config);
  const statuses = ["failed", "timed_out", "blocked"] as const;
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId, status: "interrupted",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map((task, index) => [task.id, {
      status: statuses[index % statuses.length], attempts: index + 1,
    }])), preflight: plan.summary, startedAt: 1, pausedStages: [{ stage: "attribution-compact",
      category: "interruption", code: "attempt_interrupted", path: "/", taskIds: [], at: 1 }] },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  await attributionRepository.writeRun(run, state);
  const checkpoint = await readJson<{ inputs: Record<string, unknown>; tasks: Record<string, { data: Record<string, unknown> }> }>(path.join(run, "state.json"));
  assert(Object.keys(checkpoint.inputs).length > 0);
  assert(Object.values(checkpoint.tasks).every(task => !Object.hasOwn(task.data, "candidate") && typeof task.data.input_id === "string"),
    "each task stores only its candidate coordinate, rather than repeating the full candidate");
  const configFile = path.join(f.directory, "host.json");
  await writeJson(configFile, { ...config, evaluatorVersion: fakeEvaluatorVersion,
    models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } },
    bindings: { attribution: { profile: "judge" } } });
  let code: unknown, diagnostic = "";
  try {
    await promisify(execFile)(process.execPath, [new URL("../../../apps/host/src/cli.js", import.meta.url).pathname,
      "run", "--run-id", runId, "--config", configFile, "--skip-failed", "--resume-stage", "attribution-compact"], {
      env: { ...process.env, EVAL_CONFIG_FILE: process.env.EVAL_CONFIG_FILE!, EVAL_LOG_DIR: path.join(f.directory, "log"),
        EVAL_LOG_LOCK_DIR: path.join(f.directory, "log-lock"), EVAL_HOT_STATE_ROOT: path.join(f.directory, "hot") },
      timeout: 6000, killSignal: "SIGKILL",
    });
  } catch (error) { code = (error as { code: unknown }).code; diagnostic = String((error as { stderr?: string }).stderr ?? error); }
  assert.equal(code, 2, "retained failed tasks produce a failure exit, without executing them: " + diagnostic);
  const restored = await attributionRepository.readRun(run);
  assert.deepEqual(restored.manifest.pausedStages, [], diagnostic);
  for (const task of plan.tasks) {
    assert.equal(restored.manifest.states[task.id]!.status, state.manifest.states[task.id]!.status);
    assert.equal(restored.manifest.states[task.id]!.attempts, state.manifest.states[task.id]!.attempts);
  }
});

