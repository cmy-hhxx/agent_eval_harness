import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MongoClient, type Document } from "mongodb";
import { fileSourceReader, readJson, writeJson, writeJsonl } from "@eval/data";
import { publishMongo, readMongoLabels, RemoteInputs } from "@eval/runtime/client";
import { emptyUsage, type JsonObject, type RunState, type PublicationInput, type PublicationResult } from "@eval/contracts";
import { PublicationStatistics, publishableComparisons, comparisonCodec, buildPlan, bindTask, assertStatisticsLog, assertCompleteComparisonRewrite } from "@eval/workflows/comparison";
import type { RewriteItem } from "@eval/agents/rewrite";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { generateStatisticsSnapshot, publicationSnapshot, syncMongoDay, statisticsSnapshot } from "../../../apps/host/src/automation-publication.js";
import { syncRemoteInputs } from "../../../apps/host/src/automation-download.js";
import { loadAutomationConfig, type AutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationMongoTarget, automationSourceFiles } from "../../../apps/host/src/automation-sources.js";
import { StatisticsDeliveryStore } from "../../../apps/host/src/statistics-delivery.js";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion, comparisonResult, emptyAudit, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const automationConfigFiles = async (command: string, configured: string[]) =>
  (await automationSourceFiles({ command, configured })).map(source => source.file);

test("comparison delivery waits for its rewrite, independently of attribution and clustering rewrites", async () => {
  const { directory, config } = await fixtureConfig(undefined, true, true);
  try {
    config.rewrite = { attribution: true, comparison: true, comparisonItems: true, clustering: true };
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const plan = await buildPlan(config);
    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily", status: "running", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } };
    const saved = comparisonCodec.encode(state);
    let time = 100;
    for (const task of Object.values(saved.tasks)) {
      task.status = "succeeded";
      task.receipt = { acceptedAt: time++, exported: {} } as NonNullable<typeof task.receipt>;
    }
    assert.equal(publishableComparisons(saved).size, 2);
    const criteria = Object.values(saved.tasks).find((task) => task.stage === "criteria")!;
    criteria.status = "pending";
    assert.equal(publishableComparisons(saved).size, 0, "both pairs depend on the accepted shared rubric");
    criteria.status = "succeeded";
    for (const task of Object.values(saved.tasks)) {
      if (task.stage === "clustering") task.status = "failed";
      if (task.data.rewriteOf?.stage === "clustering") task.status = "pending";
    }
    assert.equal(publishableComparisons(saved).size, 2, "clustering and its rewrite never gate comparison delivery");
    const comparisonRewrite = Object.values(saved.tasks).find((task) => task.data.rewriteOf?.stage === "comparison")!;
    comparisonRewrite.status = "failed";
    assert.equal(publishableComparisons(saved).size, 1, "failed comparison rewrite is not a completed delivery");
    comparisonRewrite.status = "pending";
    assert.equal(publishableComparisons(saved).size, 1, "publication waits for ongoing polishing");
    saved.pausedStages = [{ stage: "rewrite", category: "structure", code: "invalid", path: "/", taskIds: [], at: 1 }];
    assert.equal(publishableComparisons(saved).size, 1, "paused polishing must not be reported as complete");
    delete saved.pausedStages;
    comparisonRewrite.status = "succeeded";
    comparisonRewrite.data.comparisonRewriteScope = "verdicts";
    assert.equal(publishableComparisons(saved).size, 2, "completed results retain their accepted rewrite scope");
    (saved.config as typeof config).rewrite.comparisonItems = false;
    assert.equal(publishableComparisons(saved).size, 2, "current configuration does not invalidate accepted work");
    (saved.config as typeof config).rewrite.comparisonItems = true;
    comparisonRewrite.data.comparisonRewriteScope = "all";
    for (const task of Object.values(saved.tasks))
      if (task.data.rewriteOf?.stage === "attribution") task.status = "pending";
    assert.equal(publishableComparisons(saved).size, 2);
    const comparison = Object.values(saved.tasks).find((task) => task.stage === "comparison" && !(task.data as { verificationAudit?: boolean }).verificationAudit)!;
    comparison.receipt!.exported!.file = "comparison-review.jsonl";
    assert.equal(publishableComparisons(saved).size, 1, "review requests are not official comparison rows");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publication requires nonempty verdict and overall prose rewrites while derived cells keep their original text", () => {
  const findings = { a_fast: { finding_indices: [0] }, b_fast: { finding_indices: [0] } };
  const row: JsonObject = { comparison_id: "comparison", decision_basis: { comparisons: [
    { criterion_ids: ["r1"], assessments: findings },
    { criterion_ids: [], assessments: { a_fast: { finding_indices: [] }, b_fast: { finding_indices: [] } } },
    { criterion_ids: [], assessments: findings },
  ] }, rewritten: { rewrites: [
    { id: "verdict.A__vs__B.reason", text: "双方都好：给出相同结果。" },
    { id: "assessment.A.summary", text: "给出了结果。" },
    { id: "assessment.B.summary", text: "给出了结果。" },
    { id: "tradeoff", text: "  " },
  ] } };
  const required = ["verdict.A__vs__B.reason", "assessment.A.summary", "assessment.B.summary", "tradeoff"];
  assert.throws(() => assertCompleteComparisonRewrite(row, required), /tradeoff/);
  const items = (row.rewritten as { rewrites: { id: string; text: string }[] }).rewrites;
  items[3].text = "来源明确。";
  assertCompleteComparisonRewrite(row, required);
  items.pop();
  assertCompleteComparisonRewrite(row, required.slice(0, 3));
  assert.throws(() => assertCompleteComparisonRewrite(row, required), /tradeoff/);
  items.shift();
  assert.throws(() => assertCompleteComparisonRewrite(row, required), /verdict\.A__vs__B\.reason/);
});

const date = "2026-09-30";
const configuredGroups = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
const inputs: PublicationInput[] = ["a_fast", "b_fast"].map((versionId) => ({ versionId, trace: {
  batch_id: date, case_id: "one", version: versionId, versions: "release", messages: [{}],
  meta: { task: "客观题", difficulty: "简单", first_token_time_cost: 0, finish_answer_time_cost: 100,
    usage: { input_tokens: 200, output_tokens: 20 } },
} }));
const result: PublicationResult = { evaluatedAt: 10, row: { case: { batch_id: date, case_id: "one" },
  status: "decided", assessments: { a_fast: { meets_core: false }, b_fast: { meets_core: true } },
  models: { a_fast: {}, b_fast: {} }, verdicts: { a_fast__vs__b_fast: { result: "win", winner_version: "b_fast" } },
  has_standard_answer: true, evaluations: { a_fast: { is_correct: false }, b_fast: { is_correct: true } },
} };
async function* rows<T>(data: T[]) { yield* data; }

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const row of rows) result.push(row);
  return result;
}

test("Mongo sync forwards the configured topic for both input and result publication", async t => {
  const config = await loadAutomationConfig("configs/automations-post-training.json");
  assert.equal(config.publication.topic, "后训练双模型专项评测（2026-10-19）");
  const key = "TEST_TOPIC_MONGO_URI", previous = process.env[key];
  process.env[key] = "mongodb://mock";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  config.publication.mongoUriEnv = key;
  let called = false;
  await syncMongoDay(config, { date } as AutomationJob, t.signal, {
    snapshot: async () => ({ close: async () => {}, comparisons: configuredGroups, inputs: () => rows(inputs), results: () => rows([result]) }),
    mongo: async (settings, batch, sourceInputs, sourceResults) => {
      called = true;
      assert.equal(settings.topic, config.publication.topic);
      assert.equal(settings.evaluationTaskId, config.id);
      assert.equal(batch, date);
      assert.equal((await collect(sourceInputs)).length, 2);
      assert.equal((await collect(sourceResults)).length, 1);
      return { inputs: 2, comparisons: 1, inserted: 3, updated: 0 };
    },
  });
  assert(called);
});

test("Mongo failure releases pinned inputs after a newer snapshot installs without waiting for delivery", async t => {
  const { directory, config: evaluation } = await fixtureConfig();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadAutomationConfig("configs/automations.json");
  config.sourceDirectory = path.join(directory, "sources");
  config.stateDirectory = path.join(directory, "state");
  config.predictionResults = path.join(directory,"predictions");
  config.remoteModels = ["a_fast", "b_fast"];
  evaluation.inputs.versions = evaluation.inputs.versions.filter(version => config.remoteModels.includes(version.id));
  const hostFile = path.join(directory, "host.json");
  await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...evaluation });
  config.hostConfigs = [hostFile];
  config.publication.mongoUriEnv = "PATH";
  for (const model of config.remoteModels) {
    const file = path.join(config.sourceDirectory, date, model + ".jsonl");
    await writeJsonl(file, [{ ...raw("old"), batch_id: date }]);
  }
  const day = { date, rows: { a_fast: 1, b_fast: 1 } };
  const job: AutomationJob = { date, runIds: [], adopted: false, download: "ready", evaluation: "completed", observed: day.rows,
    checkedAt: 0, downloadAttempts: 0, evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0,
    mongo: { status: "running", attempts: 1, nextAt: 0 } };
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let delivered: PublicationInput[] = [];
  const work = syncMongoDay(config, job, t.signal, {
    snapshot: publicationSnapshot,
    mongo: async (_settings, _date, inputRows) => {
      assert.equal((await fileSourceReader.files([{ kind: "directory", path: path.join(config.sourceDirectory, date) }])).length, 2,
        "temporary publication pins must not become evaluator inputs");
      ready(); await waiting;
      delivered = await collect(inputRows);
      throw new Error("Mongo network timeout");
    },
  });
  const failed = assert.rejects(work, /Mongo network timeout/);
  try {
    await Promise.race([started, work]);
    const body = Buffer.from(JSON.stringify({ ...raw("new"), batch_id: date }) + "\n");
    const remote = new RemoteInputs("http://127.0.0.1:1", 1000, config.remoteModels);
    t.mock.method(remote, "download", async (_day: unknown, model: string) => ({
      name: model + ".jsonl", size: body.length, rows: 1, chunks: (async function* () { yield body; })(),
      close: async () => {},
    }));
    await syncRemoteInputs(remote, path.join(config.sourceDirectory, date), evaluation.output.path, job, day, t.signal, async () => {});
    assert.equal(job.mongo!.status, "running");
    const current = await readFile(path.join(config.sourceDirectory, date, "a_fast.jsonl"), "utf8");
    assert.equal(JSON.parse(current).case_id, "new");
  } finally { release(); await failed; }
  assert.deepEqual(delivered.map(input => input.trace.case_id), ["old", "old"]);
  assert.equal((await readdir(path.join(config.sourceDirectory, date))).some(file => file.startsWith(".publication-")), false);
});

test("daily and independent experiments sharing a collection keep answers, verdicts and statistics separate", async t => {
  const sourceFiles = await automationConfigFiles("run", ["automations.json", "automations-six-models.example.json", "automations-post-training.json"]
    .map(file => path.join(ROOT, "configs", file)));
  const configs = (await Promise.all(sourceFiles.map(loadAutomationConfig))).filter(config => !config.prediction);
  configs.push({ ...configs[2], id: "post-training-experiment-2" });
  const key = "TEST_TASK_MONGO_URI", previous = process.env[key];
  process.env[key] = "mongodb://mock";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  for (const config of configs) config.publication = { ...config.publication, mongoUriEnv: key };
  const collections = new Map<string, Map<string, Document>>();
  t.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  t.mock.method(MongoClient.prototype, "close", async () => {});
  t.mock.method(MongoClient.prototype, "db", (database: string) => ({
    listCollections: () => ({ hasNext: async () => true }),
    collection: (name: string) => {
      const key = `${database}.${name}`, docs = collections.get(key) ?? new Map<string, Document>();
      collections.set(key, docs);
      return {
        find: (query: Document) => ({ toArray: async () => [...docs.values()]
          .filter(doc => doc.evaluationTaskId === query.evaluationTaskId && (!query.kind || doc.kind === query.kind) &&
            (query._id ? query._id.$in.includes(doc._id) : typeof query.batchId === "string"
              ? doc.batchId === query.batchId : query.batchId.$in.includes(doc.batchId)))
          .map(doc => structuredClone(doc)) }),
        bulkWrite: async (operations: Document[]) => {
          let upsertedCount = 0, modifiedCount = 0;
          for (const { updateOne: op } of operations) {
            if (docs.has(op.filter._id)) {
              Object.assign(docs.get(op.filter._id)!, structuredClone(op.update.$set)); modifiedCount++;
            } else { docs.set(op.filter._id, structuredClone(op.update.$setOnInsert)); upsertedCount++; }
          }
          return { isOk: () => true, upsertedCount, modifiedCount };
        },
      };
    },
  }));
  const snapshot = async (config: AutomationConfig) => {
    const winner = config.id === "remote-six-model-evaluation" ? "a_fast" : "b_fast";
    const sourceInputs = inputs.map(input => ({ ...input, trace: { ...input.trace,
      messages: [{ role: "assistant", content: config.id }] } }));
    return { close: async () => {}, comparisons: configuredGroups, inputs: () => rows(sourceInputs), results: () => rows([{ ...result, row: { ...result.row, tradeoff: config.id,
      assessments: { a_fast: { meets_core: winner === "a_fast" }, b_fast: { meets_core: winner === "b_fast" } },
      verdicts: { a_fast__vs__b_fast: { result: "win", winner_version: winner } },
    } }]) };
  };
  for (const config of configs) {
    const counts = await syncMongoDay(config, { date } as AutomationJob, t.signal, { snapshot, mongo: publishMongo });
    assert.equal(counts.inserted, 3);
  }
  assert.equal(collections.size, 1, "all evaluation tasks use the existing shared collection");
  const allDocs = [...collections.values()].flatMap(docs => [...docs.values()]);
  assert.equal(allDocs.length, configs.length * 3);
  assert.equal(new Set(allDocs.map(doc => doc.caseId)).size, configs.length);
  for (const config of configs) {
    const docs = [...collections.get(`${config.publication.mongoDatabase}.${config.publication.mongoCollection}`)!.values()]
      .filter(doc => doc.evaluationTaskId === config.id);
    assert.equal(docs.length, 3);
    assert(docs.filter(doc => doc.kind === "input").every(doc => doc.trace.messages[0].content === config.id),
      `${config.id} answers were overwritten by another source`);
    assert.equal(docs.find(doc => doc.kind === "comparison")!.result.comparison.tradeoff, config.id);
    assert.equal(docs.find(doc => doc.kind === "comparison")!.result.comparison.verdict.winner_version,
      config.id === "remote-six-model-evaluation" ? "a_fast" : "b_fast");
    const counts = await syncMongoDay(config, { date } as AutomationJob, t.signal, { snapshot, mongo: publishMongo });
    assert.equal(counts.inserted + counts.updated, 0, "resuming one experiment preserves its identities without duplicate writes");
    for (const doc of docs.filter(doc => doc.kind === "input"))
      doc.trace.meta.difficulty = config.id === "remote-evaluation" ? "简单" : "复杂";
  }
  for (const config of configs) {
    const state: AutomationState = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0,
      jobs: { [date]: { date, download: "ready" } as AutomationJob } };
    const statistics = await statisticsSnapshot(config, state, t.signal, { snapshot, labels: readMongoLabels });
    const data = statistics.record("task-isolation", Date.now()).data as Record<string, any>;
    assert.equal(data.totalCaseCount, 1);
    assert.equal(data.progress.completedBattleCount, 1);
    const level = config.id === "remote-evaluation" ? "L1" : "L3";
    assert.equal(data.difficultyLevels.find((row: any) => row.id === level).count, 1);
  }
});

for (const reversed of [false, true]) test(`publication keeps rewrite ownership when blind positions are ${reversed ? "reversed" : "forward"}`, async t => {
  const { directory, config } = await fixtureConfig(Array.from({ length: 4 }, () => [{ ...raw(), batch_id: date }]), true);
  t.after(() => rm(directory, { recursive: true, force: true }));
  config.comparisons = configuredGroups;
  config.rewrite.comparisonItems = true;
  const plan = await buildPlan(config), runId = "rewrite-ownership";
  const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
    format: "evaluation-run", debug: false, runId, status: "finished", evaluatorVersion: fakeEvaluatorVersion,
    engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1,
  } };
  const saved = comparisonCodec.encode(state), output: JsonObject[] = [];
  for (const task of Object.values(saved.tasks)) {
    task.status = "succeeded";
    task.receipt = { acceptedAt: 10, exported: {}, ...(task.data.rewriteOf?.stage === "comparison" ? {
      rewriteIds: ["verdict.A__vs__B.reason", "assessment.A.summary", "assessment.B.summary", "tradeoff"],
    } : {}) } as NonNullable<typeof task.receipt>;
  }
  for (const task of plan.tasks.filter(task => task.stage === "comparison")) {
    const source = saved.tasks[task.id];
    const inputIds = Object.values(source.inputIds).sort((a, b) => saved.inputs[a].version.localeCompare(saved.inputs[b].version));
    const versions = inputIds.map(id => saved.inputs[id].version);
    source.inputIds = Object.fromEntries(["A", "B"].map((label, index) => [label, inputIds[reversed ? 1 - index : index]]));
    const names = Object.fromEntries(Object.entries(source.inputIds).map(([label, id]) => [label, saved.inputs[id].name]));
    const original = comparisonResult();
    for (const label of ["A", "B"]) original.assessments[label].summary = `【候选${label}】${saved.inputs[source.inputIds[label]].version.startsWith("a_") ? "分层选股的PE门槛不一致。" : "八维度全面胜出的说法夸大。"}`;
    const rewriteTask = structuredClone(plan.tasks.find(item => item.dependencies.source === task.id)!);
    rewriteTask.data = { ...rewriteTask.data as JsonObject, rewriteNames: names, comparisonRewriteScope: "all" };
    const binding = bindTask(rewriteTask, {}, { source: { taskId: task.id, attemptId: "attempt", submissionId: "submission",
      acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: original,
      audit: emptyAudit(), usage: emptyUsage() } }, { tasks: [task, rewriteTask] });
    output.push({ ...result.row, comparison_id: source.data.comparisonId,
      case: { batch_id: date, case_id: "q1" },
      models: Object.fromEntries([...versions].reverse().map(id => [id, {}])),
      assessments: Object.fromEntries(versions.map(id => [id, { meets_core: true }])),
      evaluations: Object.fromEntries(versions.map(id => [id, { is_correct: true }])),
      verdicts: { [versions.join("__vs__")]: { result: "both_good", winner_version: null } },
      rewritten: { evaluator_version: "fixture", rewrites: (binding.request.input.items as RewriteItem[]).map(item => ({ id: item.id, text: item.text })) },
    });
  }
  const stateFile = path.join(config.output.path, runId, "state.json"), resultFile = path.join(config.output.path, runId, "results/comparison.jsonl");
  const hostFile = path.join(directory, "host.json");
  await writeJson(stateFile, saved);
  await writeJsonl(resultFile, output);
  await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...config });
  const before = await readFile(resultFile, "utf8");
  const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), hostConfigs: [hostFile],
    predictionResults: path.join(directory, "predictions") };
  const snapshot = await publicationSnapshot(settings, { date, runIds: [runId], adopted: true } as AutomationJob, t.signal);
  const delivered = await collect(snapshot.results());
  assert.equal(delivered.length, 2);
  for (const { row } of delivered) {
    const rewrites = (row.rewritten as { rewrites: { id: string; text: string }[] }).rewrites;
    const a = rewrites.find(item => item.id === "assessment.A.summary")!.text;
    const b = rewrites.find(item => item.id === "assessment.B.summary")!.text;
    assert.match(a, /分层选股的PE门槛不一致/, "published A must belong to versionA regardless of the blind label");
    assert.match(b, /八维度全面胜出的说法夸大/, "published B must belong to versionB regardless of the blind label");
  }
  assert.equal(await readFile(resultFile, "utf8"), before, "publication must preserve accepted local rewrite slots");
  assert.deepEqual(await collect(snapshot.results()), delivered, "retries must not swap already mapped text again");
  await appendFile(resultFile, '{"unfinished_append":');
  assert.deepEqual(await collect(snapshot.results()), delivered, "new appends cannot expand the captured accepted scope");
  await writeJsonl(resultFile, output.map(row => ({ ...row, tradeoff: "later accepted presentation" })));
  assert.deepEqual(await collect(snapshot.results()), delivered, "publication keeps the captured result rows across an atomic rewrite");
  await snapshot.close();
});

test("publication quarantines every duplicate input and only its affected battles without modifying accepted work", async (t) => {
  const originals = ["healthy", "conflict"].map(id => ({ ...raw(id), batch_id: date }));
  const { directory, config } = await fixtureConfig(Array.from({ length: 4 }, () => originals), true);
  try {
    config.comparisons = configuredGroups;
    config.rewrite.comparisonItems = true;
    const plan = await buildPlan(config), runId = `daily-${date}`;
    const saved = comparisonCodec.encode({ usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId, status: "finished", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: 1,
    } });
    for (const task of Object.values(saved.tasks)) {
      task.status = "succeeded";
      task.receipt = { acceptedAt: 10, exported: {}, ...(task.data.rewriteOf?.stage === "comparison" ? {
        rewriteIds: ["verdict.A__vs__B.reason", "assessment.A.summary", "assessment.B.summary", "tradeoff"],
      } : {}) } as NonNullable<typeof task.receipt>;
    }
    const output = Object.values(saved.tasks).filter(task => task.stage === "comparison").map(task => {
      task.inputIds = Object.fromEntries(Object.values(task.inputIds)
        .sort((a, b) => saved.inputs[a].version.localeCompare(saved.inputs[b].version)).map((id, index) => [index === 0 ? "A" : "B", id]));
      const candidates = Object.values(task.inputIds).map(id => saved.inputs[id]);
      const versions = candidates.map(input => input.version).sort();
      return { ...result.row, comparison_id: task.data.comparisonId,
        case: { batch_id: date, case_id: candidates[0].case_id },
        models: Object.fromEntries(versions.map(id => [id, {}])),
        assessments: Object.fromEntries(versions.map(id => [id, { meets_core: true }])),
        evaluations: Object.fromEntries(versions.map(id => [id, { is_correct: true }])),
        verdicts: { [versions.join("__vs__")]: { result: "both_good", winner_version: null } },
        decision_basis: { comparisons: [] },
        rewritten: { rewrites: [
          { id: "verdict.A__vs__B.reason", text: "双方均完成要求。" },
          { id: "assessment.A.summary", text: "已完成所求结果。" },
          { id: "assessment.B.summary", text: "已完成所求结果。" },
          { id: "tradeoff", text: "双方结果可用，现有差异较小。" },
        ] },
      };
    });
    const stateFile = path.join(config.output.path, runId, "state.json");
    const resultFile = path.join(config.output.path, runId, "results/comparison.jsonl");
    await writeJson(stateFile, saved);
    await writeJsonl(resultFile, output);
    const acceptedState = await readFile(stateFile, "utf8"), acceptedResults = await readFile(resultFile, "utf8");
    const hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...config });
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")),
      fromDate: date, hostConfigs: [hostFile], sourceDirectory: path.join(directory, "remote"),
      predictionResults: path.join(directory, "predictions") };
    settings.publication = { ...settings.publication, mongoUriEnv: "PATH" };
    const job = { date, runIds: [runId], adopted: false, download: "ready" } as AutomationJob;
    const conflict = { ...raw("conflict", "4", "another attempt"), batch_id: date };
    const repeated = { ...raw("repeated"), batch_id: date };
    const source = path.join(settings.sourceDirectory, date, "a_fast.jsonl");
    for (const version of config.inputs.versions) {
      const entries = version.id === "a_fast"
        ? [originals[1], repeated, originals[0], repeated, conflict, { ...originals[0], batch_id: "2026-09-29" }]
        : originals;
      await writeJsonl(path.join(settings.sourceDirectory, date, version.id + ".jsonl"), entries);
    }
    const sourceText = await readFile(source, "utf8");
    const expected = output.filter(row => row.case.case_id !== "conflict" || !Object.hasOwn(row.models, "a_fast"));
    const delivered = await syncMongoDay(settings, job, t.signal, {
      snapshot: publicationSnapshot,
      mongo: async (_settings, _date, inputRows, resultRows) => {
        const input = await collect(inputRows), results = await collect(resultRows);
        assert.equal(input.length, 7, "exclude both differing and identical duplicate groups, including their first row");
        assert(!input.some(row => row.versionId === "a_fast" && row.trace.case_id !== "healthy"),
          "accepted-input fallback must not restore a quarantined identity from its older source");
        assert.deepEqual(results.map(row => row.row), expected);
        return { inputs: input.length, comparisons: results.length, inserted: 0, updated: 0 };
      },
    });
    assert.equal(delivered.comparisons, 3);
    const snapshot = await publicationSnapshot(settings, job, t.signal);
    assert.deepEqual(await collect(snapshot.results()), expected.map(row => ({ row, evaluatedAt: 10 })),
      "result-first reads isolate only the conflicting model pair, retaining the healthy Expert pair");
    const statistics = await statisticsSnapshot(settings, { id: settings.id, sourceUrl: settings.sourceUrl,
      status: "stopped", startedAt: 1, updatedAt: 1, jobs: { [date]: job } }, t.signal, {
      snapshot: publicationSnapshot, labels: async () => [],
    });
    const record = statistics.record("quarantined", 100);
    assertStatisticsLog(record);
    assert.equal((record.data as Record<string, any>).progress.completedBattleCount, 3);
    assert.equal(await readFile(source, "utf8"), sourceText, "quarantine never edits raw inputs");
    assert.equal(await readFile(stateFile, "utf8"), acceptedState, "accepted tasks and receipts are untouched");
    assert.equal(await readFile(resultFile, "utf8"), acceptedResults, "formal results are untouched");

    await writeJsonl(source, originals);
    assert.equal((await collect(snapshot.inputs())).length, 7, "an atomic source promotion leaves the pinned input group readable");
    assert.deepEqual((await collect(snapshot.results())).map(row => row.row), expected, "the captured duplicate quarantine survives input promotion");
    await snapshot.close();
    const repaired = await publicationSnapshot(settings, job, t.signal);
    assert.equal((await collect(repaired.inputs())).length, 8);
    assert.deepEqual((await collect(repaired.results())).map(row => row.row), output,
      "fixing the source releases the original accepted results without evaluating them again");
    await repaired.close();
    await t.test("accepted receipts define delivery scope and partial polish cannot hide a missing slot", async () => {
      const rewrites = Object.values(saved.tasks).filter(task => task.data.rewriteOf?.stage === "comparison");
      for (const task of rewrites) task.receipt!.rewriteIds!.pop();
      for (const row of output) row.rewritten.rewrites.pop();
      await writeJson(stateFile, saved);
      await writeJsonl(resultFile, output);
      const accepted = await publicationSnapshot(settings, job, t.signal);
      assert.equal((await collect(accepted.results())).length, output.length,
        "accepted work does not acquire extra rewrite slots at delivery time");
      await accepted.close();
      const full = rewrites[0];
      full.receipt!.rewriteIds!.push("tradeoff");
      saved.tasks["partial-rewrite"] = { ...full, data: { ...full.data, comparisonRewriteScope: "verdicts" },
        receipt: { ...full.receipt!, rewriteIds: ["verdict.A__vs__B.reason"] } };
      await writeJson(stateFile, saved);
      const incomplete = await publicationSnapshot(settings, job, t.signal);
      try { await assert.rejects(collect(incomplete.results()), /Comparison rewrite incomplete.*tradeoff/); }
      finally { await incomplete.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publication detects duplicate identities across adopted source files and retains structural validation", async (t) => {
  let scans = 0;
  const lines = fileSourceReader.lines;
  t.mock.method(fileSourceReader, "lines", (...args: Parameters<typeof lines>) => { scans++; return lines(...args); });
  const { directory, config } = await fixtureConfig();
  try {
    const first = path.join(directory, "first.jsonl"), second = path.join(directory, "second.jsonl");
    const duplicate = { ...raw("duplicate"), batch_id: date }, healthy = { ...raw("healthy"), batch_id: date };
    await writeJsonl(first, [duplicate, healthy]);
    await writeJsonl(second, [{ messages: duplicate.messages, meta: { batch_id: date, case_id: "duplicate" } }]);
    const runId = `daily-${date}`, hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...config });
    await writeJson(path.join(config.output.path, runId, "state.json"), { config, tasks: {}, inputs: {
      first: { version: "a_fast", source: first }, second: { version: "a_fast", source: second },
    } });
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), hostConfigs: [hostFile], predictionResults: path.join(directory,"predictions") };
    const job = { date, runIds: [runId], adopted: true } as AutomationJob;
    const snapshot = await publicationSnapshot(settings, job, t.signal);
    const discoveryScans = scans;
    assert.deepEqual((await collect(snapshot.inputs())).map(input => input.trace.case_id), ["healthy"]);
    assert.equal(scans, discoveryScans, "validation and upload reuse pinned coordinates instead of rescanning all input files");
    await snapshot.close();
    await writeJsonl(second, [{ ...duplicate, messages: "invalid" }]);
    await assert.rejects(publicationSnapshot(settings, job, t.signal), /messages must be an array/);
    await writeJsonl(second, [{ ...duplicate, version: "wrong-model" }]);
    await assert.rejects(publicationSnapshot(settings, job, t.signal), /identity differs from source/);
    await assert.rejects(publicationSnapshot(settings, job, AbortSignal.abort()), { name: "AbortError" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pinned statistics input reads yield to pending Host requests between records", async t => {
  const { directory, config } = await fixtureConfig();
  try {
    const file = path.join(directory, "inputs.jsonl"), runId = `daily-${date}`;
    const expected = Array.from({ length: 12 }, (_, index) => `case-${index}`);
    await writeJsonl(file, expected.map(id => ({ ...raw(id), batch_id: date })));
    const hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...config });
    await writeJson(path.join(config.output.path, runId, "state.json"), { config, tasks: {}, inputs: {
      first: { version: "a_fast", source: file },
    } });
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), hostConfigs: [hostFile], predictionResults: path.join(directory,"predictions") };
    const snapshot = await publicationSnapshot(settings, { date, runIds: [runId], adopted: true } as AutomationJob, t.signal);
    const iterator = snapshot.inputs();
    const first = await iterator.next();
    let hostRequestRan = false;
    setImmediate(() => { hostRequestRan = true; });
    const second = await iterator.next();
    assert(hostRequestRan, "a synchronous coordinate scan must not starve the Host event loop");
    const remaining = await collect(iterator);
    assert.deepEqual([first.value, second.value, ...remaining].map(row => row!.trace.case_id), expected);
    await snapshot.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("statistics scan answer bodies once while retaining labels, metrics and duplicate quarantine", async t => {
  const { directory, config } = await fixtureConfig();
  try {
    const file = path.join(directory, "inputs.jsonl"), runId = `daily-${date}`;
    const healthy = { ...raw("healthy"), batch_id: date, request_time: "2026-09-29 23:00:00",
      meta: { task: "数据查询类", difficulty: "复杂", first_token_time_cost: 12, finish_answer_time_cost: 48,
        usage: { input_tokens: 100, output_tokens: 20 } } };
    const duplicate = { ...healthy, case_id: "duplicate" };
    await writeJsonl(file, [healthy, duplicate, duplicate]);
    const hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...config });
    await writeJson(path.join(config.output.path, runId, "state.json"), { config, tasks: {}, inputs: {
      first: { version: "a_fast", source: file },
    } });
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), hostConfigs: [hostFile] };
    const job = { date, runIds: [runId], adopted: true } as AutomationJob;
    settings.predictionResults = undefined;
    const normal = await publicationSnapshot(settings, job, t.signal);
    const expected = new PublicationStatistics(normal.comparisons);
    for await (const input of normal.inputs()) expected.addInput(input);
    await normal.close();
    t.mock.method(fileSourceReader, "record", () => assert.fail("statistics must not reread complete answer bodies"));
    const snapshot = await publicationSnapshot(settings, job, t.signal, "statistics");
    const actual = new PublicationStatistics(snapshot.comparisons);
    const projected = await collect(snapshot.inputs());
    assert.equal(projected.length, 1);
    assert.equal(projected[0].trace.messages, undefined);
    assert.deepEqual(projected[0].trace.meta, healthy.meta);
    projected.forEach(input => actual.addInput(input));
    assert.deepEqual(actual.record("same", 1000), expected.record("same", 1000));
    await writeJsonl(file, [healthy]);
    assert.deepEqual(await collect(snapshot.results("statistics")), [], "statistics retain their fixed input view after promotion");
    await snapshot.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("three-model statistics use configured battles and count each answer's correctness once", () => {
  const ids = ["a_fast", "b_fast", "baseline"];
  const stats = new PublicationStatistics([ids]);
  for (const versionId of ids) stats.addInput({ ...inputs[0], versionId, trace: { ...inputs[0].trace, version: versionId } });
  const outcomes = ["both_good", "win", "win"];
  let index = 0;
  for (let first = 0; first < ids.length; first++) for (let second = first + 1; second < ids.length; second++) {
    const pair = [ids[first], ids[second]], outcome = outcomes[index++];
    stats.addResult({ evaluatedAt: 10, row: { ...result.row,
      models: Object.fromEntries(pair.map((id) => [id, {}])),
      evaluations: Object.fromEntries(pair.map((id) => [id, { is_correct: id !== "b_fast" }])),
      assessments: Object.fromEntries(pair.map((id) => [id, { meets_core: id !== "baseline" }])),
      verdicts: { [pair.join("__vs__")]: { result: outcome, winner_version: outcome === "win" ? pair[0] : null } },
    } });
  }
  const record = stats.record("three", Date.now()); assertStatisticsLog(record);
  const data = record.data as Record<string, any>;
  assert.deepEqual(data.progress, { expectedBattleCount: 3, completedBattleCount: 3, completedCaseCount: 1 });
  assert.equal(data.caseCount, 1);
  for (const model of data.stats) {
    assert.equal(model.evaluated, 2);
    assert.equal(model.accuracy.count, 1);
    assert.equal(model.accuracy.correct, model.id === "b_fast" ? 0 : 1);
    assert.equal(model.total.count, 1);
    assert.equal(model.winRate, model.wins / 2 * 100);
  }
  assert.throws(() => new PublicationStatistics([ids]).addResult({ ...result, row: { ...result.row,
    models: Object.fromEntries(ids.map((id) => [id, {}])) } }), /two-candidate/);
  assert.throws(() => new PublicationStatistics([["a_fast", "baseline"]]).addResult(result), /configured/);
});

test("statistics reject review requests and contradictory absolute core assessments across pairs", () => {
  const groups = [["a_fast", "b_fast", "baseline"]];
  for (const row of [{ ...result.row, status: "needs_review" },
    { ...result.row, evaluation_type: "comparison_review" }])
    assert.throws(() => new PublicationStatistics(groups).addResult({ ...result, row }), /decided/);
  const stats = new PublicationStatistics(groups);
  stats.addResult({ ...result, row: { ...result.row, status: "decided", assessments: {
    a_fast: { meets_core: false }, b_fast: { meets_core: true },
  } } });
  const reassessed = { ...result, row: { ...result.row, status: "decided", models: { a_fast: {}, baseline: {} },
    evaluations: { a_fast: { is_correct: false }, baseline: { is_correct: true } },
    assessments: { a_fast: { meets_core: true }, baseline: { meets_core: true } },
    verdicts: { a_fast__vs__baseline: { result: "win", winner_version: "baseline" } },
  } };
  assert.throws(() => stats.addResult(reassessed), /Conflicting answer core/);
  reassessed.row.assessments.a_fast.meets_core = false;
  stats.addResult(reassessed);
  assert.throws(() => new PublicationStatistics(groups).addResult({ ...result, row: { ...result.row, assessments: {} } }), /missing a core/);
});

test("configured pairs retain their date scope when a later date adds a baseline", () => {
  const stats = new PublicationStatistics([]), earlier = "2026-09-29", ids = ["a_fast", "b_fast", "baseline"];
  stats.addGroups([["a_fast", "b_fast"]], earlier);
  stats.addGroups([ids], date);
  for (const batchId of [earlier, date]) for (const versionId of ids)
    stats.addInput({ ...inputs[0], versionId, trace: { ...inputs[0].trace, batch_id: batchId, version: versionId } });
  for (const batch_id of [earlier, date]) stats.addResult({ ...result, row: { ...result.row, case: { batch_id, case_id: "one" } } });
  const data = stats.record("scoped", Date.now()).data as Record<string, any>;
  assert.equal(data.progress.expectedBattleCount, 4);
  assert.deepEqual(data.requestDates.map((day: any) => [day.date, day.progress.expectedBattleCount]), [[date, 3], [earlier, 1]]);
  assert.throws(() => stats.addResult({ ...result, row: { ...result.row, case: { batch_id: earlier, case_id: "one" },
    models: { a_fast: {}, baseline: {} },
  } }), /configured/);
});

test("both outcome counts sit beside wins across totals, days, scenarios, difficulties and trends", () => {
  const stats = new PublicationStatistics(configuredGroups);
  const battles = [
    { date: "2026-09-29", caseId: "same", mode: "fast", task: "数据查询类", difficulty: "简单", result: "both_good", winner: null },
    { date: "2026-09-29", caseId: "same", mode: "expert", task: "数据查询类", difficulty: "简单", result: "both_bad", winner: null },
    { date, caseId: "same", mode: "fast", task: "客观题", difficulty: "中等", result: "win", winner: "b_fast" },
    { date, caseId: "good", mode: "expert", task: "问答", difficulty: "复杂", result: "both_good", winner: null },
    { date, caseId: "bad", mode: "fast", task: "未分类", difficulty: "未分层", result: "both_bad", winner: null },
    { date, caseId: "win", mode: "expert", task: "客观题", difficulty: "长程任务", result: "win", winner: "a_expert" },
  ];
  for (const battle of battles) {
    const ids = [`a_${battle.mode}`, `b_${battle.mode}`];
    for (const id of ids) stats.addInput({ versionId: id, trace: { ...inputs[0].trace,
      batch_id: battle.date, case_id: battle.caseId, version: id,
      meta: { task: battle.task, difficulty: battle.difficulty } } });
    stats.addResult({ evaluatedAt: 10, row: {
      status: "decided", assessments: Object.fromEntries(ids.map((id) => [id, { meets_core: battle.result !== "both_bad" }])),
      case: { batch_id: battle.date, case_id: battle.caseId }, models: Object.fromEntries(ids.map((id) => [id, {}])),
      has_standard_answer: false, evaluations: Object.fromEntries(ids.map((id) => [id, { is_correct: null }])),
      verdicts: { [ids.join("__vs__")]: { result: battle.result, winner_version: battle.winner } },
    } });
  }
  for (const input of inputs) stats.addInput({ ...input, trace: { ...input.trace, case_id: "pending" } });
  stats.addInput({ ...inputs[0], trace: { ...inputs[0].trace, case_id: "unpaired" } });
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: date, case_id: "unpaired" },
    verdicts: { a_fast__vs__b_fast: { result: "both_bad", winner_version: null } } } });
  const record = stats.record("outcomes", Date.now());
  assertStatisticsLog(record);
  const data = record.data as Record<string, any>;
  assert.equal(data.progress.expectedBattleCount, 7);
  assert.equal(data.progress.completedBattleCount, 6, "pending and unpaired inputs cannot inflate outcome counts");
  const counts = (value: Record<string, any>) => ({ id: value.id, wins: value.wins,
    both_good: value.both_good, both_bad: value.both_bad, evaluated: value.evaluated });
  const check = (scope: Record<string, any>, selected: typeof battles) => {
    assert.equal(scope.progress.completedBattleCount, selected.length);
    const ids = [...new Set(selected.flatMap((battle) => [`a_${battle.mode}`, `b_${battle.mode}`]))].sort();
    assert.deepEqual(scope.stats.map(counts), ids.map((id) => {
      const entered = selected.filter((battle) => id.endsWith(`_${battle.mode}`));
      return { id, wins: entered.filter((battle) => battle.winner === id).length,
        both_good: entered.filter((battle) => battle.result === "both_good").length,
        both_bad: entered.filter((battle) => battle.result === "both_bad").length, evaluated: entered.length };
    }));
    for (const model of scope.stats) {
      const keys = Object.keys(model), position = keys.indexOf("wins");
      assert.deepEqual(keys.slice(position, position + 4), ["wins", "both_good", "both_bad", "evaluated"]);
      const peer = scope.stats.find((row: any) => row.id === model.id.replace(/^[ab]_/, model.id.startsWith("a_") ? "b_" : "a_"));
      assert.equal(model.wins + peer.wins + model.both_good + model.both_bad, model.evaluated);
      assert.equal(model.winRate, model.wins / model.evaluated * 100, "win-rate denominator is unchanged");
    }
    for (const task of scope.tasks ?? []) check(task, selected.filter((battle) => battle.task === task.name));
    for (const difficulty of scope.difficultyLevels ?? []) check(difficulty, selected.filter((battle) => battle.difficulty === difficulty.name));
  };
  check(data, battles);
  for (const day of data.requestDates) {
    check(day, battles.filter((battle) => battle.date === day.date));
    assert.deepEqual(data.winRateTrend.filter((point: any) => point.date === day.date).map(counts), day.stats.map(counts));
  }
  for (const point of data.winRateTrend) assert.deepEqual(Object.keys(point), ["date", "id", "wins", "both_good", "both_bad", "evaluated"]);
  for (const model of data.stats) for (const key of ["wins", "both_good", "both_bad", "evaluated"]) {
    assert.equal(model[key], data.requestDates.reduce((sum: number, day: any) => sum + (day.stats.find((row: any) => row.id === model.id)?.[key] ?? 0), 0));
  }
  const historical = stats.record("history", Date.now(), "2026-09-29").data as Record<string, any>;
  check(historical, battles.filter((battle) => battle.date === "2026-09-29"));
});

test("statistics read explicit verdict outcomes and reject unknown or inconsistent outcomes", () => {
  for (const verdict of [
    {}, { result: "tie", winner_version: null }, { result: "win", winner_version: null },
    { result: "win", winner_version: "a_expert" }, { result: "both_bad", winner_version: "b_fast" },
    { result: "both_good" },
  ]) {
    assert.throws(() => new PublicationStatistics(configuredGroups).addResult({ ...result, row: { ...result.row,
      verdicts: { a_fast__vs__b_fast: verdict } } }), /statistics verdict|Statistics verdict/);
  }
  const stats = new PublicationStatistics(configuredGroups);
  stats.addResult(result);
  assert.throws(() => stats.addResult(result), /Duplicate statistics comparison/);
});

test("frozen statistics contract rejects added, missing and mistyped fields at every nested object", () => {
  const stats = new PublicationStatistics(configuredGroups);
  inputs.forEach((row) => stats.addInput(row));
  stats.addResult(result);
  const record = stats.record("frozen", Date.now());
  assertStatisticsLog(record);
  const paths: string[][] = [];
  const visit = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) paths.push(path);
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(record, []);
  for (const path of paths) {
    const target = (value: Record<string, any>): Record<string, any> => path.reduce((row, key) => row[key], value);
    const extra = structuredClone(record);
    target(extra).unexpected = 1;
    assert.throws(() => assertStatisticsLog(extra), /frozen contract/, path.join("/"));
    assert.equal(target(extra).unexpected, 1, "validation must not silently strip extra fields");
    for (const [key, value] of Object.entries(target(record))) {
      const missing = structuredClone(record);
      delete target(missing)[key];
      assert.throws(() => assertStatisticsLog(missing), /frozen contract/, [...path, key].join("/"));
      assert.equal(Object.hasOwn(target(missing), key), false, "validation must not fill missing fields");
      const mistyped = structuredClone(record), wrong = typeof value === "string" ? 123 : "123";
      target(mistyped)[key] = wrong;
      assert.throws(() => assertStatisticsLog(mistyped), /frozen contract/, [...path, key].join("/"));
      assert.equal(target(mistyped)[key], wrong, "validation must not coerce numeric strings");
    }
  }
});

test("frozen statistics contract allows evolving values, new dates, empty arrays and nullable metrics", () => {
  const stats = new PublicationStatistics(configuredGroups);
  assertStatisticsLog(stats.record("empty", Date.now()));
  for (const day of ["2026-09-29", "2026-09-30"]) {
    inputs.forEach((row) => stats.addInput({ ...row, trace: { ...row.trace, batch_id: day, meta: {} } }));
    stats.addResult({ ...result, row: { ...result.row, has_standard_answer: false, case: { batch_id: day, case_id: "one" } } });
    const record = stats.record(day, Date.now());
    assertStatisticsLog(record);
    const data = record.data as Record<string, any>;
    assert.deepEqual(data.stats[0].first, { p50: null, p90: null, count: 0 });
    assert.deepEqual(data.stats[0].accuracy, { correct: 0, count: 0, rate: null });
    assert.equal(data.requestDates.length, day.endsWith("29") ? 1 : 2);
  }
});

test("four-hour statistics use paired denominators and preserve the existing log structure", () => {
  const stats = new PublicationStatistics(configuredGroups);
  inputs.forEach((row) => stats.addInput(row));
  stats.addInput({ versionId: "a_fast", trace: { ...inputs[0].trace, case_id: "unpaired" } });
  stats.addInput({ versionId: "a_fast", trace: { ...inputs[0].trace, case_id: "pending" } });
  stats.addInput({ versionId: "b_fast", trace: { ...inputs[1].trace, case_id: "pending" } });
  stats.addResult(result);
  const record = stats.record("trace", Date.parse("2026-09-30T04:00:00Z"));
  const data = record.data as Record<string, any>;
  assert.equal(record.logtime, "2026-09-30 12:00:00.000");
  assert.equal(data.totalCaseCount, 3); assert.equal(data.caseCount, 1);
  assert.deepEqual(data.progress, { expectedBattleCount: 2, completedBattleCount: 1, completedCaseCount: 1 });
  assert.deepEqual(data.stats[1].accuracy, { correct: 1, count: 1, rate: 100 });
  assert.equal(data.stats[1].winRate, 100);
  assert.deepEqual(data.stats[1].first, { p50: 0, p90: 0, count: 1 });
  assert.deepEqual(Object.keys(data).sort(), ["caseCount", "difficultyLevels", "models", "progress", "requestDates", "scope", "source", "stats", "tasks", "totalCaseCount", "winRateTrend"]);
  assert.equal(data.tasks[0].count, 3); assert.equal(data.difficultyLevels[0].evaluatedCount, 1);
});

test("dashboard snapshot retains history, separates identical case IDs across dates and uses request dates", () => {
  const stats = new PublicationStatistics(configuredGroups);
  for (const day of ["2026-09-24", "2026-09-29"]) {
    inputs.forEach((input) => stats.addInput({ ...input, trace: { ...input.trace, batch_id: day, request_time: `${day} 12:00:00` } }));
    stats.addResult({ ...result, row: { ...result.row, case: { batch_id: day, case_id: "one" } } });
  }
  const record = stats.record("global", Date.now());
  const data = record.data as Record<string, any>;
  assert.equal(data.totalCaseCount, 2);
  assert.equal(data.caseCount, 2);
  assert.deepEqual(data.requestDates.map(({ date, count }: any) => ({ date, count })), [{ date: "2026-09-29", count: 1 }, { date: "2026-09-24", count: 1 }]);
  for (const day of data.requestDates) {
    assert.equal(day.caseCount, 1);
    assert.equal(day.totalCaseCount, day.count);
    assert.equal(day.progress.completedBattleCount, 1);
    assert.equal(day.tasks[0].count, 1);
    assert.equal(day.difficultyLevels[0].evaluatedCount, 1);
    assert.equal(day.stats[1].winRate, 100);
  }
  assert.deepEqual(new Set(data.winRateTrend.map((point: any) => point.date)), new Set(["2026-09-24", "2026-09-29"]));
  assert.deepEqual(data.scope, { matchup: "same-mode" });
  assert.equal(data.source, "/api/version-comparisons?matchup=same-mode");
});

test("latest snapshot refreshes existing dates and includes new dates without double counting", () => {
  const stats = new PublicationStatistics(configuredGroups);
  const add = (day: string, caseId: string, finish: number) => {
    for (const input of inputs) stats.addInput({ ...input, trace: { ...input.trace, batch_id: day, case_id: caseId,
      request_time: `${day} 12:00:00`, meta: { ...input.trace.meta as object, finish_answer_time_cost: finish } } });
  };
  add("2026-09-29", "old", 100);
  add("2026-09-29", "late", 200);
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: "2026-09-29", case_id: "old" } } });
  const before = stats.record("29", Date.now()).data as Record<string, any>;
  assert.equal(before.requestDates[0].progress.completedBattleCount, 1);
  add("2026-09-29", "old", 100);
  add("2026-09-30", "new", 1000);
  for (const [day, caseId] of [["2026-09-29", "late"], ["2026-09-30", "new"]])
    stats.addResult({ ...result, row: { ...result.row, case: { batch_id: day, case_id: caseId } } });
  const after = stats.record("30", Date.now()).data as Record<string, any>;
  assert.equal(after.totalCaseCount, 3);
  assert.equal(after.progress.completedBattleCount, 3);
  assert.equal(after.stats[0].total.p50, 200, "global percentiles come from answers, not averages of daily percentiles");
  assert.deepEqual(after.requestDates.map((day: any) => [day.date, day.count, day.progress.completedBattleCount]),
    [["2026-09-30", 1, 1], ["2026-09-29", 2, 2]]);
  const historical = stats.record("29", Date.now(), "2026-09-29").data as Record<string, any>;
  assert.equal(historical.totalCaseCount, 2);
  assert.equal(historical.requestDates.length, 1);
  assert.equal(historical.stats[0].total.p50, 150);
});

test("statistics read nested labels without guessing RUED difficulty or changing original metadata", () => {
  const stats = new PublicationStatistics(configuredGroups);
  const nested = inputs.map(input => ({ ...input, trace: { ...input.trace,
    meta: { info: { task: "嵌套分类", rued: { R: 4, U: 4, E: 4, D: 4 } } } } }));
  const before = structuredClone(nested);
  nested.forEach(input => stats.addInput(input));
  const data = stats.record("nested", Date.now()).data as Record<string, any>;
  assert.equal(data.tasks[0].id, "嵌套分类");
  assert.equal(data.difficultyLevels.find((row: any) => row.id === "unclassified").count, 1);
  assert.deepEqual(nested, before);
  const explicit = new PublicationStatistics(configuredGroups);
  inputs.forEach(input => explicit.addInput({ ...input, trace: { ...input.trace,
    meta: { task: "直接分类", difficulty: "", info: { task: "嵌套分类", difficulty: "复杂" } } } }));
  const direct = explicit.record("direct", Date.now()).data as Record<string, any>;
  assert.equal(direct.tasks[0].id, "直接分类");
  assert.equal(direct.difficultyLevels.find((row: any) => row.id === "unclassified").count, 1);
});

test("historical statistics supplements are task scoped and current Mongo difficulty takes precedence", async t => {
  const { directory } = await fixtureConfig();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  config.sourceDirectory = directory;
  config.publication = { ...config.publication, mongoUriEnv: "PATH" };
  const file = path.join(directory, "statistics-labels.jsonl");
  const label = { evaluationTaskId: config.id, batchId: date, caseId: "one", task: "补充分类", difficulty: "简单" };
  await writeJsonl(file, [label]);
  const state = { jobs: { [date]: { date, download: "ready" } } } as unknown as AutomationState;
  const dependencies: Parameters<typeof statisticsSnapshot>[3] = {
    labels: async () => [{ batchId: date, caseId: "one", difficulty: "复杂" }],
    snapshot: async () => ({ close: async () => {}, comparisons: configuredGroups,
      inputs: () => rows(inputs.map(input => ({ ...input, trace: { ...input.trace, meta: {} } }))),
      results: () => rows([result]) }),
  };
  const data = (await statisticsSnapshot(config, state, t.signal, dependencies)).record("supplement", Date.now()).data as Record<string, any>;
  assert.equal(data.tasks[0].id, "补充分类");
  assert.equal(data.tasks[0].progress.completedBattleCount, 1);
  assert.equal(data.difficultyLevels.find((row: any) => row.id === "L3").count, 1);
  await writeJsonl(file, [{ ...label, evaluationTaskId: "another-topic" }]);
  await assert.rejects(statisticsSnapshot(config, state, t.signal, dependencies), /invalid task/);
  await writeJsonl(file, [label, label]);
  await assert.rejects(statisticsSnapshot(config, state, t.signal, dependencies), /Duplicate statistics label/);
});

test("latest Mongo difficulty replaces old labels across models without losing battles", async () => {
  const stats = new PublicationStatistics(configuredGroups);
  const localInputs = [inputs[0], { ...inputs[1], trace: { ...inputs[1].trace, meta: {} } }];
  localInputs.forEach(input => stats.addInput(input));
  stats.addResult(result);
  stats.addLabels({ batchId: "2026-09-29", caseId: "one", task: "其他分类", difficulty: "复杂" });
  const data = stats.record("labels", Date.now()).data as Record<string, any>;
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].progress.completedBattleCount, 1);
  assert.equal(data.difficultyLevels[0].progress.completedBattleCount, 1);
  stats.addLabels({ batchId: date, caseId: "one", difficulty: "简单" });
  stats.addLabels({ batchId: date, caseId: "one", difficulty: "复杂" });
  const latest = stats.record("latest", Date.now()).data as Record<string, any>;
  assertStatisticsLog(stats.record("latest", Date.now()));
  assert.equal(latest.totalCaseCount, 1);
  assert.equal(latest.progress.completedBattleCount, 1);
  assert.deepEqual(latest.stats, data.stats);
  assert.equal(latest.tasks[0].id, "客观题");
  assert.equal(latest.difficultyLevels.find((row: any) => row.id === "L3").count, 1);
  assert.equal(latest.difficultyLevels.find((row: any) => row.id === "L3").progress.completedBattleCount, 1);
  assert.throws(() => stats.addLabels({ batchId: date, caseId: "one", task: "其他分类" }), /Conflicting statistics task labels/);
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  config.publication = { ...config.publication, mongoUriEnv: "PATH" };
  const state = { jobs: Object.fromEntries([[date, { date, download: "ready" }]]) } as AutomationState;
  const snapshot = await statisticsSnapshot(config, state, AbortSignal.timeout(5000), {
    labels: async () => ["简单", "复杂"].map(difficulty => ({ batchId: date, caseId: "one", difficulty })),
    snapshot: async () => ({ close: async () => {}, comparisons: configuredGroups, inputs: () => rows(localInputs), results: () => rows([result]) }),
  });
  assert.deepEqual(snapshot.record("latest", Date.now()).data, latest,
    "local input labels must not overwrite the latest Mongo difficulty");
  for (const difficulty of ["未分层", ""]) {
    snapshot.addLabels({ batchId: date, caseId: "one", difficulty });
    const unclassified = snapshot.record("latest", Date.now()).data as Record<string, any>;
    assert.equal(unclassified.difficultyLevels.find((row: any) => row.id === "unclassified").count, 1);
    assert.deepEqual(unclassified.stats, data.stats);
  }
});

for (const file of ["automations-six-models.example.json", "automations-post-training.json"])
test(`disabled statistics publication for ${file} never reads or appends a snapshot`, async () => {
  const config = await loadAutomationConfig(path.join(ROOT, "configs", file));
  assert.equal(config.publishStatisticsLog, false);
  const state = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} } as AutomationState;
  const store = new StatisticsDeliveryStore(path.join(config.stateDirectory, "unused-delivery.json"));
  await assert.rejects(generateStatisticsSnapshot(config, state, store, AbortSignal.timeout(1000), {
    snapshot: async () => assert.fail("must not read statistics"),
  }), /Statistics log publication is disabled/);
});

test("daily statistics use a paired request date or the batch date when all request timestamps are absent", () => {
  const stats = new PublicationStatistics(configuredGroups);
  for (const input of inputs) stats.addInput(input);
  stats.addResult(result);
  for (const [i, input] of inputs.entries()) stats.addInput({ ...input, trace: { ...input.trace, case_id: "dated",
    ...(i === 1 ? { request_time: "2026-09-28T18:00:00Z" } : {}) } });
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: date, case_id: "dated" } } });
  const data = stats.record("dates", Date.now()).data as Record<string, any>;
  assert.deepEqual(data.requestDates.map((row: any) => [row.date, row.count, row.progress.completedBattleCount]),
    [["2026-09-30", 1, 1], ["2026-09-29", 1, 1]]);
  assert.equal(data.requestDates.reduce((sum: number, row: any) => sum + row.count, 0), data.totalCaseCount);
});

test("statistics load case labels from Mongo and retain them across models and daily history", async () => {
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  config.publication = { ...config.publication, mongoUriEnv: "PATH" };
  const days = ["2026-09-24", "2026-09-30"];
  const state = { jobs: Object.fromEntries(days.map((date) => [date, { date, download: "ready" }])) } as AutomationState;
  const dependencies: Parameters<typeof statisticsSnapshot>[3] = {
    labels: async (settings, dates) => {
      assert.equal(settings.evaluationTaskId, config.id);
      assert.deepEqual(dates, days);
      return [{ batchId: days[0], caseId: "one", task: "数据查询类", difficulty: "简单" }];
    },
    snapshot: async (_config, job) => ({
      close: async () => {}, comparisons: configuredGroups,
      inputs: () => rows(inputs.map((input) => ({ ...input, trace: { ...input.trace, batch_id: job.date,
        request_time: `${job.date} 12:00:00`, meta: job.date === days[0] ? {} : input.trace.meta } }))),
      results: () => rows([{ ...result, row: { ...result.row, case: { batch_id: job.date, case_id: "one" } } }]),
    }),
  };
  const data = (await statisticsSnapshot(config, state, AbortSignal.timeout(5000), dependencies)).record("all", Date.now()).data as Record<string, any>;
  assert.equal(data.totalCaseCount, 2);
  const historical = data.requestDates.find((day: any) => day.date === days[0]);
  assert.equal(historical.tasks[0].id, "数据查询类");
  assert.equal(historical.tasks[0].progress.completedBattleCount, 1);
  assert.equal(historical.difficultyLevels[0].count, 1);
  assert.deepEqual(new Set(data.tasks.map((task: any) => task.id)), new Set(["数据查询类", "客观题"]));
  await assert.rejects(statisticsSnapshot(config, state, AbortSignal.timeout(5000), {
    ...dependencies, labels: async () => { throw new Error("label source unavailable"); },
  }), /label source unavailable/, "never publish a deceptively unclassified snapshot after a read failure");
});

test("statistics use installed inputs and accepted results while refreshed inputs are still downloading", async () => {
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  config.publication = { ...config.publication, mongoUriEnv: "PATH" };
  const state = { jobs: { [date]: { date, download: "downloading", downloaded: { a_fast: 1, b_fast: 1 },
    evaluation: "evaluating" } } } as unknown as AutomationState;
  const statistics = await statisticsSnapshot(config, state, AbortSignal.timeout(1000), {
    labels: async () => [{ batchId: date, caseId: "one", task: "数据查询类", difficulty: "中等" }],
    snapshot: async () => ({ close: async () => {}, comparisons: configuredGroups,
      inputs: () => rows(inputs.map(input => ({ ...input, trace: { ...input.trace, meta: {} } }))),
      results: () => rows([result]),
    }),
  });
  const data = statistics.record("during-refresh", Date.now()).data as Record<string, any>;
  assert.equal(data.progress.completedBattleCount, 1);
  assert.equal(data.tasks[0].id, "数据查询类");
  assert.equal(data.difficultyLevels.find((item: any) => item.id === "L2").count, 1);
  state.jobs[date].download = "installing";
  await assert.rejects(statisticsSnapshot(config, state, AbortSignal.timeout(1000), {
    labels: async () => { throw new Error("Must not read Mongo before input recovery"); },
    snapshot: async () => { throw new Error("Must not read during promotion"); },
  }), /Statistics input snapshot is not ready/);
});

test("dashboard statistics append once per window and register a pending relay delivery", async () => {
  const { directory } = await fixtureConfig();
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.publishStatisticsLog = true;
    config.publication = { ...config.publication, logFile: path.join(directory, "statistics.jsonl"), mongoUriEnv: "PATH" };
    const state = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} } as AutomationState;
    const store = new StatisticsDeliveryStore(path.join(directory, "delivery.json"));
    const dependencies = { snapshot: async () => {
      const stats = new PublicationStatistics(configuredGroups); inputs.forEach(input => stats.addInput(input)); stats.addResult(result); return stats;
    } };
    const first = await generateStatisticsSnapshot(config, state, store, AbortSignal.timeout(5000), dependencies);
    const second = await generateStatisticsSnapshot(config, state, store, AbortSignal.timeout(5000), dependencies);
    assert.equal(first.traceId, second.traceId);
    const lines = (await readFile(config.publication.logFile, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assertStatisticsLog(record);
    const deliveries = await store.list([{ id: config.id, logFile: config.publication.logFile, logUrl: config.publication.logUrl }]);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].status, "pending");
    assert.equal(deliveries[0].traceId, first.traceId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("structural drift is rejected before a statistics record is appended", async () => {
  const { directory } = await fixtureConfig();
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.publishStatisticsLog = true;
    config.publication = { ...config.publication, logFile: path.join(directory, "invalid.jsonl"), mongoUriEnv: "PATH" };
    const state = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0, jobs: {} } as AutomationState;
    const stats = new PublicationStatistics(configuredGroups);
    inputs.forEach(row => stats.addInput(row)); stats.addResult(result);
    const invalid = stats.record("invalid", Date.now());
    delete (invalid.data as Record<string, any>).requestDates[0].difficultyLevels;
    stats.record = () => invalid;
    await assert.rejects(generateStatisticsSnapshot(config, state,
      new StatisticsDeliveryStore(path.join(directory, "delivery.json")), AbortSignal.timeout(5000),
      { snapshot: async () => stats }), /frozen contract/);
    await assert.rejects(readFile(config.publication.logFile), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Mongo delivery streams ready inputs and results independently of the log schedule", async () => {
  const { directory } = await fixtureConfig();
  const key = "TEST_AUTOMATIONS_MONGO_URI", previous = process.env[key];
  process.env[key] = "mongodb://mock";
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.publication = { ...config.publication, mongoUriEnv: key, logFile: path.join(directory, "statistics.jsonl") };
    let ready: PublicationResult[] = [];
    const delivered: { inputs: PublicationInput[]; results: PublicationResult[] }[] = [];
    const dependencies: Parameters<typeof syncMongoDay>[3] = {
      snapshot: async () => ({ close: async () => {}, comparisons: configuredGroups, inputs: () => rows(inputs), results: () => rows(ready) }),
      mongo: async (settings, batch, inputRows, resultRows) => {
        assert.equal(batch, date);
        assert.equal(settings.evaluationTaskId, config.id);
        assert.equal(settings.inputsUnchanged, delivered.length === 1);
        const input: PublicationInput[] = [], output: PublicationResult[] = [];
        for await (const row of inputRows) input.push(row);
        for await (const row of resultRows) output.push(row);
        delivered.push({ inputs: input, results: output });
        return { inputs: input.length, comparisons: output.length, inserted: output.length, updated: 0 };
      },
    };
    const job = { date } as AutomationJob;
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    ready = [result];
    job.mongo = { target: automationMongoTarget(config), status: "running", attempts: 1, nextAt: 0,
      synced: { inputsUpdatedAt: 0, comparisons: 0 } };
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    job.mongo.target = "another-destination";
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    job.mongo.target = automationMongoTarget(config);
    job.inputsUpdatedAt = 10;
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    assert.deepEqual(delivered, [{ inputs, results: [] }, ...Array.from({ length: 3 }, () => ({ inputs, results: [result] }))]);
    ready = [{ ...result, row: { ...result.row, status: "needs_review" } }];
    await assert.rejects(syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies), /decided/);
    assert.equal(delivered.length, 4, "invalid results are rejected before the Mongo writer is invoked");
    await assert.rejects(readFile(config.publication.logFile), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
