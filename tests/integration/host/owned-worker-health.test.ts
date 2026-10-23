import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEvaluation } from "@eval/host";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

for (const crash of [false, true]) test(`owned Worker ${crash ? "is replaced after confirmed exit" : "survives a transient health failure"}`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const workerEntry = path.join(directory, "worker.mjs"), starts = path.join(directory, "starts.jsonl");
  await writeFile(workerEntry, `
import { appendFile } from "node:fs/promises";
import { startWorker } from ${JSON.stringify(import.meta.resolve("@eval/runtime/worker"))};
import { fakeIdentity, submitFor, draftFor, taskResult } from ${JSON.stringify(new URL("../../fixtures/comparison.js", import.meta.url).href)};
await appendFile(${JSON.stringify(starts)}, JSON.stringify({pid:process.pid})+"\\n");
const backend={identity:fakeIdentity,async createSession(options){return {
  async run(){await submitFor(options,draftFor(options.spec,taskResult(options.spec)));},async abort(){},async dispose(){}
};}};
const worker=await startWorker(backend,process.argv[process.argv.indexOf("--directory")+1]);
process.send({type:"ready",url:worker.url});
process.once("SIGTERM",async()=>{await worker.close();process.exit(0);});
process.once("disconnect",async()=>{await worker.close();process.exit(0);});
`);
  const original = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/health") && ++healthCalls === 2) {
      if (crash) process.kill(JSON.parse((await readFile(starts, "utf8")).trim()).pid, "SIGKILL");
      return Response.json({ error: "temporary observation failure" }, { status: 503 });
    }
    return original(input, init);
  };
  try {
    const runId = "owned-health";
    await runEvaluation({ ...services, runtime: { ...services.runtime, workerEntry }, runId,
      output: config.output, config, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      plan: await buildPlan(config), policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0,
      signal: AbortSignal.timeout(20000) });
    const state = await readRunState(path.join(config.output.path, runId));
    assert(Object.values(state.manifest.states).every(s => s.status === "succeeded" && s.attempts === 1));
    assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, crash ? 2 : 1,
      "an observation failure must not kill a live Worker or spend task attempts");
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});
