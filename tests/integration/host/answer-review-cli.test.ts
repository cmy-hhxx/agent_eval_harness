import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import { exists, writeJson, writeJsonl } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { loadIdentity } from "@eval/runtime/client";
import { answerReviewRepository, planAnswerReview, type AnswerReviewConfig } from "@eval/workflows/answer-review";
import { fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

async function fixture(t: TestContext) {
  const f = await fixtureConfig([[raw("one"), raw("two"), raw("three")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config: AnswerReviewConfig = { ...f.config, workflow: "answer-review", reviewStages: ["attribution"], comparisons: [],
    inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) },
    output: { kind: "directory", path: path.join(f.directory, "eval_output/0_daily_eval") } };
  const overlay = path.join(f.directory, "review.json");
  await writeJson(overlay, { ...config, models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } } });
  const cli = (command: string, ...args: string[]) => promisify(execFile)(process.execPath,
    [path.join(ROOT, "dist/tests/fixtures/cli.js"), f.directory, command,
      "--config", path.join(ROOT, "configs/host.json"), "--config", overlay, ...args],
    { env: { ...process.env, EVAL_CONFIG_FILE: path.join(f.directory, "config.ini") } });
  return { ...f, config, cli };
}

test("answer-review CLI applies input, batch, case and limit selection before preflight", async t => {
  const f = await fixture(t), input = path.join(f.directory, "selected.jsonl");
  await writeJsonl(input, [raw("selected"), { ...raw("other"), batch_id: "other" }]);
  const selected = JSON.parse((await f.cli("preflight", "--stage", "attribution", "--input", `a_fast=${input}`,
    "--batch", "b1", "--case", "selected", "--limit-cases", "1")).stdout);
  assert.equal(selected.valid_inputs, 1);
  assert.equal(selected.attribution_tasks, 1);
  assert.deepEqual(selected.issues, []);
  assert.equal(JSON.parse((await f.cli("preflight", "--stage", "attribution", "--limit-cases", "1")).stdout).cases, 1);
});

test("answer-review trial flags reject production output before any model work", async t => {
  const f = await fixture(t);
  for (const flags of [["--test-eval"], ["--pilot-cases", "1"]]) {
    await assert.rejects(f.cli("run", "--stage", "attribution", "--run-id", "trial", "--engine", "invalid",
      "--output", f.config.output.path, ...flags), (error: unknown) =>
      /Test evaluation output must be under/.test((error as { stderr: string }).stderr));
  }
});

test("report and validate dispatch from the saved answer-review workflow without loading current model configuration", async t => {
  const f = await fixture(t), plan = await planAnswerReview(f.config), run = path.join(f.config.output.path, "saved");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "saved", status: "interrupted",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config: f.config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  await answerReviewRepository.writeRun(run, state);
  for (const command of ["report", "validate"]) {
    const result = JSON.parse((await f.cli(command, "--run", run, "--config", path.join(f.directory, "missing.json"))).stdout);
    if (command === "report") assert.equal(result.workflow, "answer-review");
    else assert.equal(result.valid, true);
  }
});

test("answer-review CLI keeps pilot output and scope, then explicitly releases the remaining answers", async t => {
  const f = await fixture(t), calls: string[] = [];
  const worker = await startWorker({ identity: await loadIdentity("pi", ROOT), async createSession(options) {
    return { async run() {
      calls.push(options.spec.taskId);
      const result = await options.execute("submit_evaluation", { summary: "回答正确完成任务。", findings: [] });
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(f.directory, "worker"));
  t.after(() => worker.close());
  const args = ["--stage", "attribution", "--run-id", "pilot", "--worker", worker.url];
  await f.cli("run", ...args, "--pilot-cases", "1");
  const run = path.join(f.directory, "eval_output/test_eval/pilot");
  let state = await answerReviewRepository.readRun(run);
  assert.equal(state.manifest.tasks.length, 3);
  assert.equal(Object.keys(state.receipts).length, 1);
  assert.equal(await exists(path.join(f.config.output.path, "pilot")), false);
  const accepted = structuredClone(state.receipts);
  await f.cli("run", ...args, "--test-eval");
  assert.equal(calls.length, 1, "ordinary resume keeps the pilot scope");
  state = await answerReviewRepository.readRun(run);
  state.manifest.pausedStages = [{ stage: "attribution", category: "transport", code: "fixture", path: "/", taskIds: [], at: 1 }];
  await answerReviewRepository.writeRun(run, state);
  await f.cli("run", ...args, "--test-eval", "--discover-inputs", "--resume-stage", "attribution");
  state = await answerReviewRepository.readRun(run);
  assert.equal(calls.length, 3);
  assert.equal(Object.keys(state.receipts).length, 3);
  assert.deepEqual(state.manifest.pausedStages, []);
  for (const [id, receipt] of Object.entries(accepted)) assert.deepEqual(state.receipts[id], receipt);
});
