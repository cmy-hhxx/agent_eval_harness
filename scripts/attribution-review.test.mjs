import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { attributionPilotFixture } from "../dist/tests/fixtures/attribution-pilot.js";
import { attributionResult } from "../dist/tests/fixtures/comparison.js";
import { clusteringJobRepository, createResultWriter, loadAttributionJobInputs, prepareAttributionTargetedReviews, readRunState, writeRunState } from "@eval/workflows/comparison";
import { pinnedAttributionEntries } from "./attribution-review-tree.mjs";

test("the check-page command selects latest review rows, reuses input titles and copies native model JSONL lines exactly", async t => {
  const fixture = await attributionPilotFixture(); t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const source = fixture.chosen[0], prepared = await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: source.id, reasons: ["核验交付疑点。"] }], apply: true });
  let state = await readRunState(fixture.run);
  const id = prepared.selected[0].review_task_id;
  const { exported: _exported, ...original } = state.receipts[source.id];
  state.receipts[id] = { ...structuredClone(original), taskId: id, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 2 };
  state.manifest.states[id] = { status: "succeeded", attempts: 1, revision: 1 };
  const peer = fixture.chosen[1], result = attributionResult(false, "2+2=4", true, peer.inputIds.answer);
  result.findings[0].text = "不得泄漏的原始点评全文"; result.findings[0].reason = "不得泄漏的原始判断理由"; result.findings[0].problem.label = "高层简短标签";
  state.receipts[peer.id].evaluation = result; delete state.receipts[peer.id].exported;
  const inputs = await loadAttributionJobInputs(state.manifest, new Set([id]));
  await createResultWriter(fixture.run, inputs)(state); await writeRunState(fixture.run, state);
  await prepareAttributionTargetedReviews(fixture.run, { reviews: [{ taskId: source.id, reasons: ["另一个尚未完成的复核。"] }], apply: true });
  state = await readRunState(fixture.run);
  for (const model of ["b_fast", "b_expert"]) {
    const task = state.manifest.tasks.find(task => task.stage === "attribution" && task.data.candidates.A.version === model), candidate = task.data.candidates.A;
    state.manifest.preflight.selected_answers.push({ task_id: task.id, input_id: candidate.input_id, version: model, batch_id: candidate.batch_id, case_id: candidate.case_id });
    state.manifest.executionScope.push(task.id);
  }
  await writeRunState(fixture.run, state);
  const samples = state.manifest.preflight.selected_answers.map(answer => ({ inputId: answer.input_id, taskSummary: "高层任务摘要-" + answer.input_id }));
  const summaries = path.join(fixture.run, "sample-summaries.json"); await writeFile(summaries, JSON.stringify({ samples }));
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/attribution-review.mjs", "--run", fixture.run, "--library", path.join(fixture.directory, "empty-library")], { cwd: path.resolve(import.meta.dirname, "..") });
  const report = JSON.parse(stdout.trim()); assert.equal(report.answers, 2); assert.equal(report.target_answers, 4); assert.equal(report.unfinished_answers, 2); assert.equal(report.nodes, 0);
  const html = await readFile(path.join(fixture.run, "review.html"), "utf8"), tree = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/u)[1]).attributionTree;
  assert.deepEqual(tree.samples.map(sample => sample.inputId), samples.slice(0, 2).map(sample => sample.inputId));
  assert.deepEqual(tree.samples.map(sample => sample.taskSummary), samples.slice(0, 2).map(sample => sample.taskSummary));
  assert.equal(tree.unfinished.length, 2); assert.deepEqual(tree.models.map(model => [model.targetCount, model.sampleCount, model.unfinishedCount]), [[1, 1, 0], [1, 1, 0], [1, 0, 1], [1, 0, 1]]);
  assert.equal(tree.samples[0].taskId, id); assert(!tree.samples.some(sample => sample.taskId === source.id));
  const native = (await readFile(path.join(fixture.run, "results", "attribution.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean);
  const selected = new Set(tree.samples.map(sample => sample.taskId));
  for (const model of ["a_fast", "a_expert", "b_fast", "b_expert"]) {
    const expected = native.filter(line => { const row = JSON.parse(line); return row.version === model && selected.has(row.task_id); });
    assert.equal(await readFile(path.join(fixture.run, "models", model + ".jsonl"), "utf8"), expected.length ? expected.join("\n") + "\n" : "");
  }
  assert.deepEqual(tree.nodes, []); assert.equal(tree.totals.problems, 1); assert.equal(tree.samples[1].summary, "高层简短标签");
  for (const forbidden of ["计算2+2", "2+2=4", "加法结果正确", "不得泄漏", "另一个尚未完成的复核", "<nav", "<a ", "download="])
    assert(!html.includes(forbidden), forbidden);
  assert(!/"(?:core_assessment|quote|evidence_id|ground_truth|raw|question|answer|standard)"\s*:/u.test(JSON.stringify(tree)));

  const otherRun = path.join(fixture.directory, "original-source"), otherState = structuredClone(state);
  otherState.manifest.runId = "original-source";
  otherState.manifest.executionScope = [];
  await mkdir(path.join(otherRun, "results"), { recursive: true });
  await copyFile(path.join(fixture.run, "results", "attribution.jsonl"), path.join(otherRun, "results", "attribution.jsonl"));
  await writeRunState(otherRun, otherState);
  const pinned = (directory, sourceState, taskId) => {
    const task = sourceState.manifest.tasks.find(task => task.id === taskId), candidate = task.data.candidates.A, receipt = sourceState.receipts[taskId];
    return { run: directory, run_id: sourceState.manifest.runId, task_id: taskId, submission_id: receipt.submissionId, evaluator_version: receipt.evaluatorVersion,
      input_id: candidate.input_id, model: candidate.version, batch_id: candidate.batch_id, case_id: candidate.case_id, source: { file: candidate.source, line: candidate.line } };
  };
  const sources = [pinned(fixture.run, state, source.id), pinned(otherRun, otherState, peer.id)];
  const states = new Map([[fixture.run, state], [otherRun, otherState]]), entries = native.map(line => ({ line, value: JSON.parse(line) }));
  const entriesByRun = new Map([[fixture.run, entries], [otherRun, entries]]);
  assert.strictEqual(pinnedAttributionEntries(sources, states, entriesByRun)[0].entry, entries.find(entry => entry.value.task_id === source.id), "the pinned source stays selected even when a newer accepted review exists");
  assert.throws(() => pinnedAttributionEntries([sources[0], sources[0]], states, entriesByRun), /输入重复/);
  assert.throws(() => pinnedAttributionEntries([{ ...sources[0], submission_id: randomUUID() }], states, entriesByRun), /不一致/);
  assert.throws(() => pinnedAttributionEntries([{ ...sources[0], source: { ...sources[0].source, line: 999 } }], states, entriesByRun), /不一致/);
  assert.throws(() => pinnedAttributionEntries(sources, new Map(), entriesByRun), /不一致/);
  assert.throws(() => pinnedAttributionEntries(sources, states, new Map([[fixture.run, []], [otherRun, entries]])), /不一致/);
  const clusterRun = path.join(fixture.directory, "clustering"), clusterState = structuredClone(state);
  clusterState.manifest.runId = "pinned-clustering";
  clusterState.manifest.config = { ...fixture.baseConfig, inputs: { versions: [] }, comparisons: [], clusteringJob: { runs: [fixture.run, otherRun], sources } };
  clusterState.manifest.tasks = []; clusterState.manifest.states = {}; clusterState.receipts = {};
  await clusteringJobRepository.writeRun(clusterRun, clusterState);
  await mkdir(path.join(clusterRun, "results"), { recursive: true });
  await writeFile(path.join(clusterRun, "results", "clustering.jsonl"), "");
  const sourceFiles = [fixture.run, otherRun].flatMap(directory => [path.join(directory, "state.json"), path.join(directory, "results", "attribution.jsonl")]);
  const before = await Promise.all(sourceFiles.map(file => readFile(file)));
  const clustered = await promisify(execFile)(process.execPath, ["scripts/attribution-review.mjs", "--run", fixture.run, "--clustering", clusterRun, "--library", path.join(fixture.directory, "empty-library")], { cwd: path.resolve(import.meta.dirname, "..") });
  const clusteredReport = JSON.parse(clustered.stdout.trim());
  assert.equal(clusteredReport.answers, 2); assert.equal(clusteredReport.target_answers, 2); assert.equal(clusteredReport.unfinished_answers, 0);
  const clusteredHtml = await readFile(path.join(fixture.run, "review.html"), "utf8");
  const clusteredTree = JSON.parse(clusteredHtml.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/u)[1]).attributionTree;
  assert.deepEqual(clusteredTree.samples.map(sample => sample.taskId), sources.map(source => source.task_id));
  assert.deepEqual(clusteredTree.samples.map(sample => sample.taskSummary), samples.slice(0, 2).map(sample => sample.taskSummary));
  assert.equal(clusteredTree.unfinished.length, 0, "uncompleted pilot tasks do not override pinned existing source availability");
  assert.deepEqual(clusteredTree.models.map(model => [model.targetCount, model.sampleCount, model.unfinishedCount]), [[1, 1, 0], [1, 1, 0]]);
  for (const source of sources) assert.equal(await readFile(path.join(fixture.run, "models", source.model + ".jsonl"), "utf8"), native.find(line => JSON.parse(line).task_id === source.task_id) + "\n");
  assert.deepEqual(await Promise.all(sourceFiles.map(file => readFile(file))), before, "the check page does not write either source run");
  for (const forbidden of ["不得泄漏", "计算2+2", "2+2=4", "<nav", "<a ", "download="]) assert(!clusteredHtml.includes(forbidden), forbidden);
});
