import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { writeJson } from "@eval/data";
import { loadIdentity } from "@eval/runtime/client";
import { readRunState, prepareComparisonRewrites, buildPlan } from "@eval/workflows/comparison";
import { runBatchCommand } from "../../../apps/host/src/batch-command.js";
import { services, initializeServices } from "@eval/host-app/composition";
import { ROOT } from "../../fixtures/services.js";
import { fixtureConfig, raw } from "../../fixtures/comparison.js";

test("the batch entry shares one Worker process across runs and restarting skips terminal runs", async t => {
  const f = await fixtureConfig([[raw("shared")], [], [raw("shared")], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  const oldEntry = services.runtime.workerEntry;
  const previous = { log: process.env.EVAL_LOG_DIR, lock: process.env.EVAL_LOG_LOCK_DIR };
  t.after(() => { services.runtime.workerEntry = oldEntry;
    if (previous.log === undefined) delete process.env.EVAL_LOG_DIR; else process.env.EVAL_LOG_DIR = previous.log;
    if (previous.lock === undefined) delete process.env.EVAL_LOG_LOCK_DIR; else process.env.EVAL_LOG_LOCK_DIR = previous.lock;
  });
  process.env.EVAL_LOG_DIR = path.join(f.directory, "log");
  process.env.EVAL_LOG_LOCK_DIR = path.join(f.directory, "log-lock");
  await initializeServices();
  const workerEntry = path.join(f.directory, "worker.mjs"), starts = path.join(f.directory, "starts.jsonl");
  const identity = await loadIdentity("pi", ROOT);
  await writeFile(workerEntry, `
import {appendFile} from "node:fs/promises";
import {startWorkerPool} from ${JSON.stringify(import.meta.resolve("@eval/runtime/worker"))};
import {inspectFor,submitFor,draftFor,taskResult} from ${JSON.stringify(new URL("../../fixtures/comparison.js", import.meta.url).href)};
await appendFile(${JSON.stringify(starts)},JSON.stringify({pid:process.pid})+"\\n");
const backend={identity:${JSON.stringify(identity)},async createSession(options){return{
async run(){await inspectFor(options);const result=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));if(result.isError)throw new Error(JSON.stringify(result));},async abort(){},async dispose(){}};}};
const worker=await startWorkerPool(backend,process.argv[process.argv.indexOf("--directory")+1],Number(process.argv[process.argv.indexOf("--slots")+1]));
process.send({type:"ready",url:worker.urls[0],urls:worker.urls});
const close=async()=>{await worker.close();process.exit(0);};process.once("SIGTERM",close);process.once("disconnect",close);
`);
  services.runtime.workerEntry = workerEntry;
  const runConfig = path.join(f.directory, "run.json"), batch = path.join(f.directory, "batch.json");
  await writeJson(runConfig, { ...f.config, models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } } });
  await writeJson(batch, { stateDirectory: "state", channels: { "evaluation-gateway": 2 },
    equivalentChannels: ["evaluation-gateway"], taskConcurrency: 2, workers: { slots: 2, retries: 0, retryDelaySeconds: 0 },
    runs: ["first", "second"].map((runId, priority) => ({ runId, priority,
      configs: [path.join(ROOT, "configs/host.json"), runConfig] })) });
  assert.equal(await runBatchCommand(batch, AbortSignal.timeout(20_000)), 0);
  for (const runId of ["first", "second"]) {
    const state = await readRunState(path.join(f.config.output.path, runId));
    assert.equal(state.manifest.status, "finished");
    assert(Object.values(state.manifest.states).every(task => task.status === "succeeded"));
  }
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1, "run ownership does not duplicate shared process capacity");
  const before = await readFile(starts, "utf8");
  assert.equal(await runBatchCommand(batch, AbortSignal.timeout(10_000)), 0);
  assert.equal(await readFile(starts, "utf8"), before, "terminal runs hand over without starting or reevaluating anything");
  const run = path.join(f.config.output.path, "first"), saved = await readRunState(run);
  const source = saved.manifest.tasks.find(task => task.stage === "comparison")!;
  const prepared = await prepareComparisonRewrites(run, { scope: "items", mode: "missing", taskIds: [source.id], apply: true });
  const rewrite = prepared.selected[0]!.rewrite_task_id!;
  const changed = { ...f.config, inputs: { ...f.config.inputs, case_ids: ["absent-from-current-selection"] } };
  assert.equal((await buildPlan(changed)).tasks.length, 0, "current selection cannot produce a fresh run");
  await writeJson(runConfig, { ...changed, models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } } });
  assert.equal(await runBatchCommand(batch, AbortSignal.timeout(20_000)), 0,
    "the batch resumes the frozen repair scope using its original source coordinates");
  assert.equal((await readRunState(run)).manifest.states[rewrite].status, "succeeded");
});
