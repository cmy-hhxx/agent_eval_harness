import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { readJson, writeJson, hasLiveRunOwner } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import { runPipeline, type AutomationState, type EvaluationSummary } from "@eval/automations";
import { automationMongoTarget, automationSourceFiles, createAutomationMongoLane, validateAutomationTasks } from "../../../apps/host/src/automation-sources.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationCommand } from "../../../apps/host/src/automation-command.js";
import { fixtureConfig, raw } from "../../fixtures/comparison.js";
import { createMongoResultPublisher } from "../../../apps/host/src/automation-result-publication.js";
import { ROOT } from "../../fixtures/services.js";

const configuredSources = ["automations.json", "automations-six-models.example.json", "automations-post-training.json", "automations-prediction.json"]
  .map(file => path.join(ROOT, "configs", file));
const configFiles = async (command: string, configured?: string[]) =>
  (await automationSourceFiles({ command, configured })).map(source => source.file);

test("automation defaults to the registered daily source", async () => {
  for (const command of ["run", "check", "status", "publish-log", "resolve-log", "retry"])
    assert.deepEqual(await configFiles(command), [configuredSources[0]]);
});

test("local-only task installs inputs without Mongo credentials or delivery", { timeout: 15000 }, async () => {
  const { directory, config: host } = await fixtureConfig();
  const config = await loadAutomationConfig(configuredSources[2]);
  const date = config.fromDate, requests: string[] = [];
  const server = await listen(async (_req, res, url) => {
    requests.push(url.pathname);
    if (url.pathname.endsWith("/dashboard-data")) return json(res, { dates: [{ date, ready: true,
      models: Object.fromEntries(config.remoteModels.map(model => [model, { ready: true, row_count: 1 }])) }] });
    const content = Buffer.from(JSON.stringify({ ...raw(), batch_id: date }) + "\n");
    res.writeHead(200, { "content-length": content.length }); res.end(content);
  });
  const previous = process.env.EVAL_AUTOMATION_SCHEDULING_FILE, exitCode = process.exitCode;
  try {
    config.sourceUrl = server.url;
    config.stateDirectory = path.join(directory, "state");
    config.sourceDirectory = path.join(directory, "inputs");
    config.publishProgress = false;
    config.publication.mongoUriEnv = "UNCONFIGURED_SPECIAL_TASK_MONGO";
    config.hostConfigs = [path.join(directory, "host.json")];
    await writeJson(config.hostConfigs[0], { ...host, evaluatorVersion: "fixture",
      models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "medium" } },
      bindings: Object.fromEntries(["criteria", "attribution", "comparison", "rewrite"].map(stage => [stage, { profile: "judge" }])),
      inputs: { ...host.inputs, versions: config.remoteModels.map(id => ({ ...host.inputs.versions[0], id, name: id, display_name: id })) },
      comparisons: [config.remoteModels] });
    process.env.EVAL_AUTOMATION_SCHEDULING_FILE = path.join(directory, "scheduling.json");
    await writeJson(process.env.EVAL_AUTOMATION_SCHEDULING_FILE, { sources: { [config.id]: { concurrency: 0 } } });
    const file = path.join(directory, "task.json");
    await writeJson(file, config);
    await automationCommand(["run", "--once", "--config", file]);
    const state = await readJson<AutomationState>(path.join(config.stateDirectory, "state.json"));
    assert.equal(state.jobs[date].download, "ready");
    assert.equal(state.jobs[date].mongo, undefined);
    assert.equal(requests.filter(url => url.endsWith(".jsonl")).length, 2);
    let deliveries = 0;
    config.publication.mongoUriEnv = "PATH";
    const publisher = createMongoResultPublisher(config, async error => { throw error; }, async () => {
      deliveries++; return { inputs: 0, comparisons: 1, inserted: 1, updated: 0, waitingForInputs: 0 };
    });
    publisher.observe({ ...state.jobs[date], summary: { stages: {}, skipped: 0, issues: 0, readyComparisons: 1 } }, AbortSignal.timeout(1000));
    await publisher.settled();
    assert.equal(deliveries, 0, "local-only results must not upload even when credentials exist");
    for (const publishMongo of [undefined, "false", 0]) {
      await writeJson(file, { ...config, publishMongo });
      await assert.rejects(loadAutomationConfig(file), /Invalid automations.publishMongo/);
    }
    await writeJson(file, { ...await loadAutomationConfig(configuredSources[3]), publishMongo: false });
    await assert.rejects(loadAutomationConfig(file), /Prediction requires Mongo publication/);
  } finally {
    if (previous === undefined) delete process.env.EVAL_AUTOMATION_SCHEDULING_FILE;
    else process.env.EVAL_AUTOMATION_SCHEDULING_FILE = previous;
    process.exitCode = exitCode;
    await server.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("explicit sources retain independent delivery and model allocation", async () => {
  const files = await configFiles("run", configuredSources);
  assert.deepEqual(await configFiles("check", configuredSources), files);
  assert.deepEqual(await configFiles("status", configuredSources), files);
  const [four, gpt, post, prediction] = await Promise.all(files.map(loadAutomationConfig));
  assert.deepEqual(four.remoteModels, ["a_fast", "b_fast", "a_expert", "b_expert"]);
  assert.equal(new URL(four.sourceUrl).pathname, "/data/wencai");
  assert.equal(new URL(gpt.sourceUrl).pathname, "/data/gpt");
  assert.equal(gpt.remoteModels.length, 6);
  assert.equal(four.publishStatisticsLog, true);
  assert.equal(gpt.publishStatisticsLog, false);
  assert.notEqual(four.stateDirectory, gpt.stateDirectory);
  assert.notEqual(four.sourceDirectory, gpt.sourceDirectory);
  assert.notEqual(four.runPrefix, gpt.runPrefix);
  assert.equal(new URL(post.sourceUrl).pathname, "/data/post_training_model");
  assert.deepEqual(post.remoteModels, ["b_fast", "b_post_train_fast"]);
  assert.equal(post.publishStatisticsLog, false);
  assert.deepEqual([four.publishMongo, gpt.publishMongo, post.publishMongo, prediction.publishMongo], [true, true, false, true]);
  assert.equal(post.fromDate, "2026-10-19");
  assert.equal(post.throughDate, "2026-10-19");
  for (const key of ["stateDirectory", "sourceDirectory", "runPrefix"] as const)
    assert.equal(new Set([four, gpt, post].map(config => config[key])).size, 3);
  assert.equal(four.publication.mongoCollection, gpt.publication.mongoCollection);
  assert.equal(post.publication.mongoCollection, four.publication.mongoCollection);
  assert.equal(prediction.id, "prediction-evaluation");
  assert.equal(prediction.publishStatisticsLog, false);
  assert.equal(prediction.publishProgress, false);
  assert.equal(prediction.sourceDirectory, four.predictionResults);
  assert.equal(new URL(prediction.sourceUrl).protocol, "file:");
  assert.equal(new Set([four, gpt, post].map(automationMongoTarget)).size, 3);
  validateAutomationTasks([four, gpt, post, prediction]);
  for (const config of [four, gpt, post, prediction]) {
    assert.deepEqual(config.channelConcurrency, config === post ? { "evaluation-gateway": 32 } : { openai: 1 });
    const budget = await readJson<{ execution: { concurrency: number } }>(config.hostConfigs.at(-1)!);
    assert.equal(budget.execution.concurrency, config === post ? 32 : 6);
  }
  assert.deepEqual(await configFiles("run", [files[1]]), [files[1]]);
  assert.deepEqual(await configFiles("publish-log"), [files[0]]);
  await assert.rejects(configFiles("run", [files[0], files[0]]), /Duplicate/);
  await assert.rejects(configFiles("retry", files), /one --config/);
});

test("independent experiments may share a source and collection but cannot share checkpoints or runs", async t => {
  const { directory } = await fixtureConfig();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = await loadAutomationConfig((await configFiles("run", configuredSources))[2]);
  const experiment = { ...original, id: "post-training-experiment-2", runPrefix: "experiment-2-", publishProgress: false,
    stateDirectory: path.join(directory, "state-2"), sourceDirectory: path.join(directory, "inputs-2") };
  validateAutomationTasks([original, experiment]);
  assert.throws(() => validateAutomationTasks([original, { ...experiment, publishProgress: true }]), /disable shared progress publication/);
  assert.notEqual(automationMongoTarget(original), automationMongoTarget(experiment));
  for (const key of ["id", "stateDirectory", "sourceDirectory", "runPrefix"] as const) {
    const first = { ...original, hostConfigs: [path.join(directory, "must-not-load.json")] };
    const second = { ...experiment, [key]: original[key], hostConfigs: first.hostConfigs };
    const files = [path.join(directory, "first.json"), path.join(directory, "second.json")];
    await writeJson(files[0], first); await writeJson(files[1], second);
    await assert.rejects(automationCommand(["run", ...files.flatMap(file => ["--config", file])]),
      new RegExp(`share ${key}`));
  }
});

test("sources with no LLM allocation still discover, download and deliver completed output", { timeout: 5000 }, async t => {
  const configs = await Promise.all((await configFiles("run", configuredSources)).map(loadAutomationConfig));
  const mongo = createAutomationMongoLane(), date = "2026-10-19";
  const downloaded: string[] = [], evaluated: string[] = [], delivered: string[] = [];
  let active = 0, peak = 0;
  const states = configs.map(config => ({ id: config.id, sourceUrl: config.sourceUrl, status: "stopped",
    startedAt: 0, updatedAt: 0, jobs: {} }) as AutomationState);
  const summary: EvaluationSummary = { stages: {}, skipped: 0, issues: 0, readyComparisons: 1 };
  await Promise.all(configs.map((config, index) => runPipeline(states[index], { ...config, mongoTarget: automationMongoTarget(config), once: true }, {
    discover: async () => [{ date, rows: Object.fromEntries(config.remoteModels.map(id => [id, 1])) }],
    initialize: async () => ({ runIds: [config.runPrefix + date], adopted: false }),
    sync: async (_job, _day, _signal, beforeReplace) => { downloaded.push(config.id); await beforeReplace(); return { changed: true, bytes: 100, rows: _day.rows }; },
    evaluationConcurrency: () => config.prediction ? 1 : 0,
    evaluate: async () => { evaluated.push(config.id); return { status: "completed", summary }; },
    syncMongo: (_job, signal) => mongo(async () => {
      peak = Math.max(peak, ++active); await Promise.resolve(); active--;
      delivered.push(config.id); return { inputs: config.remoteModels.length, comparisons: 1, inserted: 1, updated: 0 };
    }, signal, automationMongoTarget(config)),
    save: async () => {}, event: async () => {},
  }, t.signal)));
  assert(peak >= 1);
  assert.deepEqual(new Set(downloaded), new Set(configs.map(config => config.id)));
  assert.deepEqual(new Set(delivered), new Set(configs.map(config => config.id)));
  assert.deepEqual(evaluated, ["prediction-evaluation"]);
  for (const [index, config] of configs.entries()) {
    assert.equal(states[index].status, "stopped");
    assert.equal(states[index].jobs[date].evaluation, config.prediction ? "completed" : "pending");
  }
});

test("Mongo delivery waits only for writes to the same task and date", async t => {
  const mongo = createAutomationMongoLane(), started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = mongo(async () => { started.push("ordinary"); await gate; }, t.signal, "ordinary:2026-10-19");
  const same = mongo(async () => { started.push("prediction"); }, t.signal, "ordinary:2026-10-19");
  const other = mongo(async () => { started.push("post-training"); }, t.signal, "post-training:2026-10-19");
  const date = mongo(async () => { started.push("another-date"); }, t.signal, "ordinary:2026-10-18");
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(started, ["ordinary", "post-training", "another-date"]);
  } finally { release(); await Promise.all([first, same, other, date]); }
  assert.equal(started.at(-1), "prediction");
});

test("one automation command serves all sources on one dashboard and releases its listener and checkpoints", { timeout: 15000 }, async () => {
  const { directory } = await fixtureConfig();
  const requests: string[] = [];
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const discovered = new Promise<void>(resolve => { ready = resolve; });
  const server = await listen(async (_req, res, url) => {
    requests.push(url.pathname);
    if (requests.length === 3) ready();
    await held; json(res, { dates: [] });
  });
  const reservation = await listen(async () => {});
  const dashboardUrl = reservation.url, port = new URL(dashboardUrl).port;
  await reservation.close();
  const previousExitCode = process.exitCode;
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  try {
    const files: string[] = [], states: string[] = [];
    const models = path.join(directory, "models.json");
    await writeJson(models, { models: { judge: { model: "fixture" } } });
    const remoteConfigs = (await Promise.all((await configFiles("run", configuredSources)).map(loadAutomationConfig))).filter(config => !config.prediction);
    for (const [index, config] of remoteConfigs.entries()) {
      const file = path.join(directory, `source-${index}.json`);
      config.sourceUrl = server.url + new URL(config.sourceUrl).pathname.replace(/\/$/, "");
      config.stateDirectory = path.join(directory, `state-${index}`);
      config.sourceDirectory = path.join(directory, `input-${index}`);
      config.hostConfigs = [path.join(ROOT, "configs/host.json"), ...(index ? [path.join(ROOT, index === 1 ? "configs/six-models.json" : "configs/post-training-models.json")] : []), models];
      config.channelConcurrency = undefined;
      config.publication.mongoUriEnv = "PATH";
      await writeJson(file, config); files.push(file); states.push(config.stateDirectory);
    }
    const running = automationCommand(["run", "--once", "--dashboard", "--port", port, ...files.flatMap(file => ["--config", file])]);
    try {
      await Promise.race([discovered, running.then(() => { throw new Error("Automation stopped before discovery"); })]);
      const snapshot = await (await fetch(dashboardUrl + "/api/status")).json() as { id: string; sources: { id: string }[] };
      assert.equal(snapshot.id, "remote-evaluation");
      assert.equal(snapshot.sources.length, 3);
      for (const source of snapshot.sources) {
        const current = await (await fetch(`${dashboardUrl}/api/status?source=${source.id}`)).json() as { id: string };
        assert.equal(current.id, source.id);
      }
    } finally { release(); await running; }
    await assert.rejects(fetch(dashboardUrl + "/api/status"), /fetch failed/);
    assert.deepEqual(new Set(requests), new Set(["/data/wencai/dashboard-data", "/data/gpt/dashboard-data", "/data/post_training_model/dashboard-data"]));
    for (const directory of states) {
      assert.equal((await readJson<AutomationState>(path.join(directory, "state.json"))).status, "stopped");
      assert.equal(await hasLiveRunOwner(directory), false);
    }
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
    const broken = await readJson<Record<string, unknown>>(files[1]);
    await writeJson(files[1], { ...broken, hostConfigs: [path.join(directory, "missing.json")] });
    await assert.rejects(automationCommand(["run", "--dashboard", "--port", port, ...files.flatMap(file => ["--config", file])]), /ENOENT/);
    await assert.rejects(fetch(dashboardUrl + "/api/status"), /fetch failed/);
    for (const directory of states) assert.equal(await hasLiveRunOwner(directory), false);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  } finally { release(); process.exitCode = previousExitCode; await server.close(); await rm(directory, { recursive: true, force: true }); }
});
