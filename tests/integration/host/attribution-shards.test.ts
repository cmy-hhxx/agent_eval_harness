import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { writeJsonl } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { attributionAgent } from "@eval/agents/attribution";
import { compactAgent } from "@eval/agents/compact";
import { attributionRepository, attributionWorkflow, planAttribution } from "@eval/workflows/attribution";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, submitFor, taskResult } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("a sharded attribution run dispatches before the corpus is read and holds the input window", async t => {
  const files = 6, window = 2;
  const f = await fixtureConfig([[], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const sources: string[] = [];
  for (let index = 0; index < files; index++) {
    const file = path.join(f.directory, "input-" + index + ".jsonl");
    await writeJsonl(file, [{ batch_id: "batch", case_id: "case-" + index, messages: [
      { type: "user_question", content: "生成工作簿。" },
      { type: "llm_turn", name: "planner-excel", output: "运行脚本。" },
      { type: "tool_call", name: "shell", call_id: "build", input: { command: "python make.py" } },
      { type: "tool_result", name: "shell", call_id: "build", output: { exit_code: 0, stdout: "saved workbook.xlsx" } },
      { type: "llm_turn", name: "llm-call-final", output: "已生成工作簿。" },
      { type: "final_answer", content: "已生成工作簿。" },
    ] }]);
    sources.push(file);
  }
  const version = f.config.inputs.versions[0]!;
  version.adapter = "b";
  version.sources = sources.map(file => ({ kind: "file" as const, path: file }));
  const config = { ...f.config, workflow: "attribution" as const, inputs: { ...f.config.inputs, versions: [version] } };
  config.execution.sessionWindow = window;
  config.execution.concurrency = 4;
  const runId = "sharded-window", run = path.join(config.output.path, runId);
  let shardsRead = 0, firstDispatchShards = -1;
  const bound: number[] = [];
  const taskSource = { ...attributionWorkflow,
    shards(...args: Parameters<NonNullable<typeof attributionWorkflow.shards>>) {
      const source = attributionWorkflow.shards!(...args);
      return { async next() { const shard = await source.next(); if (shard) shardsRead++; return shard; },
        done: () => source.done?.() ?? false };
    },
    bind(...args: Parameters<typeof attributionWorkflow.bind>) {
      bound.push(Object.keys(args[1]).length);
      return attributionWorkflow.bind(...args);
    },
  };
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (firstDispatchShards < 0) firstDispatchShards = shardsRead;
    return { async run() { assert.notEqual((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).isError, true); },
      async abort() {}, async dispose() {} };
  } }, path.join(f.directory, "worker"));
  t.after(() => worker.close());
  let stateBytes = 0, stateTasks = 0, sampling = true;
  const sampler = setInterval(() => {
    void readFile(path.join(run, "state.json"), "utf8").then(text => {
      if (!sampling) return;
      stateBytes = Math.max(stateBytes, Buffer.byteLength(text));
      stateTasks = Math.max(stateTasks, Object.keys((JSON.parse(text) as { tasks?: object }).tasks ?? {}).length);
    }).catch(() => {});
  }, 100);
  t.after(() => { sampling = false; clearInterval(sampler); });
  const result = await runEvaluation({ ...services, report: async () => ({}), agents: new AgentRegistry([compactAgent, attributionAgent]),
    repository: attributionRepository, taskSource, runId, output: config.output, config, plan: await planAttribution(config),
    engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
    modelForStage: f.modelForStage, concurrency: 4, retries: 0, retryDelaySeconds: 0,
    failureGuard: { enabled: false, windowSize: 50, threshold: 5 }, workerUrls: [worker.url], signal: AbortSignal.timeout(60_000) });
  assert.equal(result.outcome, "complete");
  assert.equal(shardsRead, files, "every physical file is planned, including the ones after the window");
  assert(firstDispatchShards >= 1 && firstDispatchShards < 3,
    `the first task runs after the first file, not after the whole corpus (read ${firstDispatchShards}/${files})`);
  assert(bound.length > 0);
  assert(Math.max(...bound) <= window - 1 + 1, "one file may overshoot the window, but only to its own boundary");
  const state = await attributionRepository.readRun(run);
  assert.equal(state.manifest.tasks.length, 0, "finished inputs leave the checkpoint");
  assert.equal(state.manifest.inputCatalog?.length ?? 0, 0);
  assert(stateTasks <= 4 * window, "bound inputs keep the checkpoint sized by the window, not the corpus: " + stateTasks);
  assert(stateBytes <= 2 * 1024 * 1024, "checkpoint bytes stay small: " + stateBytes);
});
