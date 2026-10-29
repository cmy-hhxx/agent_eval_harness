import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEvaluation } from "@eval/host";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

for (const recover of [true, false]) test(`Worker startup timeout ${recover ? "rebuilds and recovers" : "exhausts bounded retries without aborting the lane"}`, async t => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], []]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plan = await buildPlan(config);
  plan.tasks = plan.tasks.filter(task => task.stage === "criteria");
  assert.equal(plan.tasks.length, 2);
  const workerEntry = path.join(directory, "worker.mjs"), starts = path.join(directory, "starts.jsonl");
  await writeFile(workerEntry, `import {appendFile,readFile} from "node:fs/promises";
await appendFile(${JSON.stringify(starts)},JSON.stringify({pid:process.pid})+"\\n");
const count=(await readFile(${JSON.stringify(starts)},"utf8")).trim().split("\\n").length;
if(${recover ? "count===1" : "true"}){process.stderr.write("fixture never ready");setInterval(()=>{},1000);}else{
const {startWorkerPool}=await import(${JSON.stringify(import.meta.resolve("@eval/runtime/worker"))});
const {fakeIdentity,submitFor,draftFor,taskResult}=await import(${JSON.stringify(new URL("../../fixtures/comparison.js", import.meta.url).href)});
const backend={identity:fakeIdentity,async createSession(options){return{async run(){await submitFor(options,draftFor(options.spec,taskResult(options.spec)));},async abort(){},async dispose(){}};}};
const w=await startWorkerPool(backend,process.argv[process.argv.indexOf("--directory")+1],1);
process.send({type:"ready",url:w.urls[0]});process.once("SIGTERM",async()=>{await w.close();process.exit(0);});process.once("disconnect",async()=>{await w.close();process.exit(0);});}`);
  const timer = globalThis.setTimeout;
  let startupTimerShortened = false;
  t.mock.method(globalThis, "setTimeout", ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 60000 && (!recover || !startupTimerShortened)) {
      args[1] = 1000;
      startupTimerShortened = true;
    }
    return timer(...args);
  }) as typeof setTimeout);
  const events: string[] = [], runId = "startup-retry";
  const result = await runEvaluation({ ...services, runtime: { ...services.runtime, workerEntry },
    runId, output: config.output, config, plan, engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: config.execution, modelForStage,
    concurrency: 1, retries: 2, retryDelaySeconds: 0, signal: AbortSignal.timeout(15000),
    onProgress: value => events.push(value) });
  const saved = await readRunState(path.join(config.output.path, runId));
  const launches = (await readFile(starts, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(new Set(launches.map(row => row.pid)).size, launches.length, "each retry creates a fresh Worker");
  if (recover) {
    assert.deepEqual(result.execution_task_statuses, { succeeded: 2 });
    assert.equal(launches.length, 2);
    assert(Object.values(saved.manifest.states).every(state => state.attempts === 1), "startup failures do not spend model attempts");
  } else {
    assert.deepEqual(result.execution_task_statuses, { pending: 2 });
    assert.equal(result.resource_pause, "worker_capacity_unavailable");
    assert.equal(launches.length, 3, "capacity, rather than each innocent record, owns the startup budget");
    assert(Object.values(saved.manifest.states).every(state => !state.transportFailures && state.attempts === 0));
    assert.equal(events.filter(event => event.startsWith("worker_capacity_quarantined ")).length, 1);
  }
});
