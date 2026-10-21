import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { readJson, writeJson, writeJsonl } from "@eval/data";
import { emptyUsage } from "@eval/contracts";
import { buildPlan, comparisonCodec, type Checkpoint, type PredictionAnswer } from "@eval/workflows/comparison";
import type { AutomationJob } from "@eval/automations";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { discoverPrediction, syncPrediction, predictionEvaluationConfig } from "../../../apps/host/src/automation-prediction.js";
import { publicationSnapshot, statisticsSnapshot, syncMongoDay } from "../../../apps/host/src/automation-publication.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

async function setup(t: TestContext) {
  const date = "2026-09-22", input = { ...raw("original"), batch_id: date };
  const fixture = await fixtureConfig([[input], [input], [input], [input]]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  const plan = await buildPlan(fixture.config), runId = "daily-" + date;
  const saved = comparisonCodec.encode({ usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
    format: "evaluation-run", debug: false, runId, status: "finished", evaluatorVersion: fakeEvaluatorVersion,
    engine: fakeIdentity, config: fixture.config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1,
  } });
  for (const task of Object.values(saved.tasks)) {
    task.status = "succeeded";
    task.receipt = { acceptedAt: 10, exported: {} } as NonNullable<typeof task.receipt>;
  }
  const sourceDirectory = path.join(fixture.directory, "prediction");
  const hostFile = path.join(fixture.directory, "host.json"), sourceConfig = path.join(fixture.directory, "original.json");
  await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...fixture.config });
  const origin = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")),
    hostConfigs: [hostFile], predictionResults: sourceDirectory };
  await writeJson(sourceConfig, origin);
  const config = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations-prediction.json")),
    hostConfigs: [hostFile], sourceDirectory, stateDirectory: path.join(fixture.directory, "prediction-state"),
    prediction: { answersFile: path.join(sourceDirectory, "answers.jsonl"), sourceConfig },
  };
  config.publication.mongoUriEnv = "PATH";
  origin.publication.mongoUriEnv = "PATH";
  await writeJson(sourceConfig, origin);
  const answer: PredictionAnswer = { question_id: "external-id", batch_id: date, text: "计算2+2",
    question_time: "2026-09-22T12:00:00+08:00", prediction_results: [{
      target_id: "target", start_date: "2026-09-23", end_date: "2026-09-23",
      answer: "4", answer_scope: "actual_outcome", status: "resolved",
    }] };
  await writeJsonl(config.prediction.answersFile, [answer]);
  const stateFile = path.join(fixture.config.output.path, runId, "state.json");
  await writeJson(stateFile, saved);
  return { ...fixture, date, saved, origin, automation: config, stateFile, runId, answer };
}
async function collect<T>(values: AsyncIterable<T>) { const items: T[] = []; for await (const value of values) items.push(value); return items; }

test("prediction source freezes original accepted battles, reuses their files and resumes without changing source runs", async t => {
  const f = await setup(t), comparisons = Object.values(f.saved.tasks).filter(task => task.stage === "comparison");
  delete comparisons[1].receipt; comparisons[1].status = "pending";
  await writeJson(f.stateFile, f.saved);
  const before = await readFile(f.stateFile, "utf8");
  const found = await discoverPrediction(f.automation, f.config.output.path);
  assert.equal(found.days[0].selections.length, 1);
  assert.equal(found.days[0].selections[0].caseId, "original", "bind the external ID through unique question text");
  let installs = 0;
  assert.equal((await syncPrediction(f.automation, f.config.output.path, f.date, async () => { installs++; })).changed, true);
  assert.equal((await syncPrediction(f.automation, f.config.output.path, f.date, async () => { installs++; })).changed, false);
  assert.equal(installs, 1);
  assert.equal(await readFile(f.stateFile, "utf8"), before);
  comparisons[1].receipt = { acceptedAt: 20, exported: {} } as NonNullable<typeof comparisons[1]["receipt"]>;
  comparisons[1].status = "succeeded";
  await writeJson(f.stateFile, f.saved);
  assert.equal((await discoverPrediction(f.automation, f.config.output.path)).days[0].selections.length, 1);
  const config = await predictionEvaluationConfig(f.automation, f.config.output.path, f.config, f.date);
  assert.deepEqual(config.inputs.case_ids, ["original"]);
  assert.equal((await buildPlan(config)).tasks.filter(task => task.stage === "comparison").length, 1);
  assert(config.inputs.versions.every(version => f.config.inputs.versions.some(original =>
    original.id === version.id && JSON.stringify(original.sources) === JSON.stringify(version.sources))));
});

test("only confirmed prediction uploads replace subsequent ordinary publication and frozen statistics", async t => {
  const f = await setup(t);
  const originalRows = Object.values(f.saved.tasks).filter(task => task.stage === "comparison").map(task => {
    const versions = task.data.group!;
    return { comparison_id: task.data.comparisonId, status: "decided", case: { batch_id: f.date, case_id: "original" },
      models: Object.fromEntries(versions.map(id => [id, {}])), has_standard_answer: true,
      assessments: Object.fromEntries(versions.map(id => [id, { meets_core: true }])),
      evaluations: Object.fromEntries(versions.map(id => [id, { is_correct: true }])),
      verdicts: { [versions.join("__vs__")]: { result: "both_good", winner_version: null } },
    };
  });
  await writeJsonl(path.join(f.config.output.path, f.runId, "results/comparison.jsonl"), originalRows);
  const predicted = structuredClone(f.saved), predictionRun = "prediction-" + f.date;
  const predictionRows = originalRows.map((row, index) => ({ ...row, comparison_id: "prediction-" + index,
    evaluation_purpose: "prediction", prediction: { source_evaluation_task_id: f.origin.id,
      source_comparison_id: row.comparison_id }, evaluations: Object.fromEntries(Object.keys(row.models).map(id => [id, { is_correct: false }])) }));
  Object.values(predicted.tasks).filter(task => task.stage === "comparison")
    .forEach((task, index) => { task.data.comparisonId = predictionRows[index].comparison_id; });
  await writeJson(path.join(f.config.output.path, predictionRun, "state.json"), predicted);
  await writeJsonl(path.join(f.config.output.path, predictionRun, "results/comparison.jsonl"), predictionRows);
  const ordinaryJob = { date: f.date, runIds: [f.runId], adopted: true, download: "ready" } as AutomationJob;
  const predictionJob = { ...ordinaryJob, runIds: [predictionRun] };
  const current = async () => collect((await publicationSnapshot(f.origin, ordinaryJob, t.signal)).results());
  assert.deepEqual((await current()).map(result => result.row.comparison_id), originalRows.map(row => row.comparison_id));
  await assert.rejects(syncMongoDay(f.automation, predictionJob, t.signal, {
    snapshot: publicationSnapshot, mongo: async () => { throw new Error("offline"); },
  }), /offline/);
  assert.deepEqual((await current()).map(result => result.row.comparison_id), originalRows.map(row => row.comparison_id));
  await syncMongoDay(f.automation, predictionJob, t.signal, {
    snapshot: publicationSnapshot, mongo: async (settings, _date, inputs, results) => {
      assert.equal(settings.resultsOnly, true);
      assert.equal(settings.evaluationTaskId, f.origin.id);
      assert.equal((await collect(inputs)).length, 4);
      assert.equal((await collect(results)).length, 2);
      return { inputs: 0, comparisons: 2, inserted: 0, updated: 2 };
    },
  });
  assert.deepEqual((await current()).map(result => result.row.comparison_id), predictionRows.map(row => row.comparison_id));
  const statistics = await statisticsSnapshot(f.origin, { id: f.origin.id, sourceUrl: f.origin.sourceUrl,
    status: "stopped", startedAt: 1, updatedAt: 1, jobs: { [f.date]: ordinaryJob } }, t.signal, {
    snapshot: publicationSnapshot, labels: async () => [],
  });
  const data = statistics.record("prediction", Date.now()).data as { stats: { accuracy: { correct: number; count: number } }[] };
  assert(data.stats.every(stat => stat.accuracy.correct === 0 && stat.accuracy.count === 1));
  assert.deepEqual(await readJson<Checkpoint>(f.stateFile), f.saved);
  await t.test("statistics retain acknowledged predictions while new polish is pending, without allowing uploads", async () => {
    const [sourceId, source] = Object.entries(predicted.tasks).find(([, task]) => task.stage === "comparison")!;
    predicted.tasks["pending-polish"] = {
      stage: "rewrite", status: "pending", attempts: 0, inputIds: source.inputIds,
      dependencies: { source: sourceId }, data: { reference: source.data.reference,
        rewriteOf: { taskId: sourceId, stage: "comparison", resultId: source.data.comparisonId! } },
    };
    const stateFile = path.join(f.config.output.path, predictionRun, "state.json");
    await writeJson(stateFile, predicted);
    const before = await readFile(stateFile, "utf8");
    const readStatistics = () => statisticsSnapshot(f.origin, { id: f.origin.id, sourceUrl: f.origin.sourceUrl,
      status: "stopped", startedAt: 1, updatedAt: 1, jobs: { [f.date]: ordinaryJob } }, t.signal, {
      snapshot: publicationSnapshot, labels: async () => [],
    });
    const retained = (await readStatistics()).record("pending-polish", Date.now()).data as typeof data;
    assert(retained.stats.every(stat => stat.accuracy.correct === 0 && stat.accuracy.count === 1));
    assert.equal(await readFile(stateFile, "utf8"), before);
    await assert.rejects(current(), /Published prediction result is unavailable/);
    const newUploads = await collect((await publicationSnapshot(f.automation, predictionJob, t.signal)).results());
    assert(!newUploads.some(result => result.row.comparison_id === source.data.comparisonId));

    const publishedFile = path.join(f.automation.sourceDirectory, f.date, "published.json");
    const confirmed = await readJson(publishedFile);
    await syncMongoDay(f.automation, predictionJob, t.signal, {
      snapshot: publicationSnapshot, mongo: async (_settings, _date, _inputs, results) => {
        assert.deepEqual(await collect(results), newUploads);
        return { inputs: 0, comparisons: newUploads.length, inserted: 0, updated: 0 };
      },
    });
    assert.deepEqual(await readJson(publishedFile), confirmed, "partial uploads retain every previously confirmed prediction");
    const afterUpload = (await readStatistics()).record("partial-upload", Date.now()).data as typeof data;
    assert(afterUpload.stats.every(stat => stat.accuracy.correct === 0 && stat.accuracy.count === 1));
    await assert.rejects(current(), /Published prediction result is unavailable/);

    source.receipt!.exported = { file: "comparison-review.jsonl" };
    await writeJson(stateFile, predicted);
    await assert.rejects(readStatistics(), /Published prediction result is unavailable/,
      "a publication reference cannot admit a review result into statistics");
  });
});
