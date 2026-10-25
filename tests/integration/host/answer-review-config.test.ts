import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson, writeJsonl } from "@eval/data";
import { indexDataset, selectDatasetInputs } from "@eval/workflows/inputs";
import { planAnswerReview } from "@eval/workflows/answer-review";
import { loadConfig, loadComparisonConfig, loadComparisonEvaluation } from "@eval/host-app/config";
import { testSettings } from "../../fixtures/settings.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "independent-review-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "input.jsonl"), file = path.join(directory, "config.json");
  await writeJsonl(input, [{ batch_id: "batch", case_id: "case", messages: [
    { role: "user", content: "计算2+2" }, { role: "assistant", content: "4" },
  ] }]);
  const source = { workflow: "answer-review", evaluatorVersion: "fixture",
    inputs: { versions: [{ id: "only", name: "单模型", adapter: "a", sources: [{ kind: "file", path: input }] }] },
    output: { kind: "directory", path: path.join(directory, "runs") }, rewrite: { attribution: false },
    models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } },
    bindings: { score: { profile: "judge" }, attribution: { profile: "judge" }, "instruction-review": { profile: "judge" } },
  };
  await writeJson(file, source);
  return { directory, file, source, settings: testSettings("http://127.0.0.1:1/v1") };
}

test("independent review loads and plans one model without pair, clustering or library configuration", async t => {
  const f = await fixture(t), host = await loadConfig(f.file, f.settings);
  assert(host.workflow === "answer-review");
  assert.deepEqual(Object.keys(host.evaluation).sort(), ["execution", "inputs", "output", "rewrite", "workflow"]);
  const plan = await planAnswerReview(host.evaluation);
  assert.deepEqual(plan.tasks.map(task => task.stage), ["attribution", "score"]);
  assert.equal(plan.catalog!.length, 1);
  await writeJson(f.file, { ...f.source, comparisons: "unused", clustering: "unused", problemLibrary: "unused",
    standardAnswerReview: "unused", rewrite: { attribution: false, comparison: "unused", clustering: "unused" } });
  const independent = await loadConfig(f.file, f.settings);
  assert(independent.workflow === "answer-review");
  assert.deepEqual(independent.evaluation, host.evaluation, "comparison-only settings cannot alter the independent evaluation");
});

test("independent model selection and budgets are validated without enabling comparison settings", async t => {
  const f = await fixture(t), host = await loadConfig(f.file, f.settings, { versions: ["only"] });
  assert(host.workflow === "answer-review");
  assert.deepEqual(host.evaluation.inputs.versions.map(version => version.id), ["only"]);
  await assert.rejects(loadConfig(f.file, f.settings, { execution: { concurrency: 0 } }), /execution.concurrency/);
  await assert.rejects(loadComparisonConfig(f.file, f.settings), /对战工作流配置/);
  await assert.rejects(loadComparisonEvaluation(f.file), /对战工作流配置/);
});

test("an independent single-model dataset preserves exact input coordinates without a pair", async t => {
  const f = await fixture(t), host = await loadConfig(f.file, f.settings);
  assert(host.workflow === "answer-review");
  const root = path.join(f.directory, "catalog");
  await indexDataset(host.evaluation, root, "single", "单模型");
  const config = await selectDatasetInputs(host.evaluation, root, "single");
  const plan = await planAnswerReview(config), candidate = (plan.catalog as { source: string; line: number; final_index: number }[])[0];
  assert.equal(config.inputs.dataset_id, "single");
  assert.equal(candidate.source, f.source.inputs.versions[0].sources[0].path);
  assert.equal(candidate.line, 1);
  assert.equal(candidate.final_index, 1);
});
