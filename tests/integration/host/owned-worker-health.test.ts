import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEvaluation } from "@eval/host";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

for (const [crash, slots] of [[false, 1], [true, 1], [true, 4]] as const)
test(`owned Worker ${crash ? "is replaced after confirmed exit" : "survives a transient health failure"} (${slots} slots)`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const workerEntry = path.join(directory, "worker.mjs"), starts = path.join(directory, "starts.jsonl");
  await writeFile(workerEntry, `
import { appendFile } from "node:fs/promises";
import { startWorkerPool } from ${JSON.stringify(import.meta.resolve("@eval/runtime/worker"))};
import { fakeIdentity, submitFor, draftFor, taskResult } from ${JSON.stringify(new URL("../../fixtures/comparison.js", import.meta.url).href)};
const slots=Number(process.argv[process.argv.indexOf("--slots")+1]);
await appendFile(${JSON.stringify(starts)}, JSON.stringify({pid:process.pid,slots})+"\\n");
const backend={identity:fakeIdentity,async createSession(options){return {
  async run(){await submitFor(options,draftFor(options.spec,taskResult(options.spec)));},async abort(){},async dispose(){}
};}};
const worker=await startWorkerPool(backend,process.argv[process.argv.indexOf("--directory")+1],slots);
process.send({type:"ready",url:worker.urls[0],urls:worker.urls});
process.once("SIGTERM",async()=>{await worker.close();process.exit(0);});
process.once("disconnect",async()=>{await worker.close();process.exit(0);});
`);
  const original = globalThis.fetch;
  let healthCalls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/health") && ++healthCalls === slots + 1) {
      if (crash) process.kill(JSON.parse((await readFile(starts, "utf8")).trim()).pid, "SIGKILL");
      return Response.json({ error: "temporary observation failure" }, { status: 503 });
    }
    return original(input, init);
  };
  try {
    const runId = "owned-health";
    await runEvaluation({ ...services, runtime: { ...services.runtime, workerEntry, workerSlots: slots }, runId,
      output: config.output, config, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      plan: await buildPlan(config), policy: config.execution, modelForStage, concurrency: slots, retries: 0, retryDelaySeconds: 0,
      signal: AbortSignal.timeout(20000) });
    const state = await readRunState(path.join(config.output.path, runId));
    const states = Object.values(state.manifest.states);
    assert(states.every(s => s.status === "succeeded"), JSON.stringify(state.manifest.states));
    // A live process is retained on observation failure. Actual pool exit can interrupt up to one attempt per slot.
    assert(states.every(s => s.attempts >= 1 && s.attempts <= (crash ? 2 : 1)), JSON.stringify(state.manifest.states));
    assert(states.filter(s => s.attempts === 2).length <= (crash ? slots : 0));
    assert.equal(Object.keys(state.receipts).length, states.length);
    assert(Object.values(state.receipts).every(receipt => receipt.judge === "code" || receipt.submissionStats?.contentSubmissions === 1),
      "replacing the pool preserves accepted work and never repeats an accepted content submission");
    assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, crash ? 2 : 1,
      "an observation failure retains the live Worker; a confirmed exit replaces its pool exactly once");
    assert((await readFile(starts, "utf8")).trim().split("\n").every(line => JSON.parse(line).slots === slots),
      "replacing a process must preserve its whole pool instead of launching one process per lost slot");
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});
