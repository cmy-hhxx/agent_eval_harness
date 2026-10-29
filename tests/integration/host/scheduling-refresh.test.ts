import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type EngineIdentity, type PlannedTask, type RunRepository, type RunState } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { comparisonWorkflow } from "@eval/workflows/comparison";

test("completion during Worker startup refreshes downstream admission before the upstream backlog", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scheduling-refresh-"));
  const controller = new AbortController(), started: string[] = [];
  const identity: EngineIdentity = { engine: "pi", version: "fixture", commit: "fixture", buildId: "fixture" };
  const tasks: PlannedTask[] = Array.from({ length: 6 }, () => ({
    id: randomUUID(), stage: "criteria", inputIds: {}, dependencies: {}, data: null,
  }));
  const downstream: PlannedTask = { id: randomUUID(), stage: "comparison", inputIds: {},
    dependencies: { source: tasks[0].id }, data: null };
  tasks.push(downstream);
  const agents = new AgentRegistry([{ id: "fixture", profiles: { default: {
    id: "default", requestSchema: { type: "object" }, submissionSchema: { type: "object" },
    systemPrompt: "fixture", instructions: "fixture", submissionNudge: "fixture", toolNames: [], fileSubmission: false,
    toolDescriptions: { submit_evaluation: "fixture" }, renderPrompt: () => "fixture",
  } } }]);
  const repository: RunRepository = {
    readRun: run => readJson<RunState>(path.join(run, "state.json")),
    readTasks: run => readJson<RunState>(path.join(run, "state.json")),
    writeRun: (run, state) => writeJson(path.join(run, "state.json"), state),
    createResultWriter: () => async () => {},
  };
  const workerEntry = path.join(directory, "worker.mjs"), finished = path.join(directory, "first-finished");
  await writeFile(workerEntry, `
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startWorker } from ${JSON.stringify(new URL("../../../packages/runtime/src/server.js", import.meta.url).href)};
const marker = ${JSON.stringify(path.join(directory, "worker-started"))};
const later = existsSync(marker);
writeFileSync(marker, "started");
if (later) while (!existsSync(${JSON.stringify(finished)})) await delay(5);
const worker = await startWorker({ identity: ${JSON.stringify(identity)}, async createSession(options) {
  return { async run() { await options.execute("submit_evaluation", {}); }, async abort() {}, async dispose() {} };
} }, process.argv[process.argv.indexOf("--directory") + 1]);
process.send({ type: "ready", url: worker.url });
const close = async () => { await worker.close(); process.exit(0); };
process.once("SIGTERM", close);
process.once("disconnect", close);
`);
  try {
    await runEvaluation({ repository, agents, runtime: { root: directory, workerEntry },
      taskSource: { id: "fixture", scheduling: comparisonWorkflow.scheduling,
        bind: () => ({ agent: "fixture", profile: "default", request: { input: {}, sources: {} } }) },
      runId: "refresh", output: { kind: "directory", path: directory }, config: {},
      plan: { tasks, inputs: {}, summary: {} }, engine: "pi", identity, evaluatorVersion: "fixture",
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 10 },
      modelForStage: () => ({ provider: "fixture", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
        apiKeyEnv: "SCHEDULING_REFRESH_KEY", model: "fixture", thinking: "off", contextWindow: 4096, maxOutputTokens: 100 }),
      concurrency: 4, retries: 0, retryDelaySeconds: 0,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      onProgress(message) {
        if (message === `succeeded criteria ${tasks[0].id}`)
          setImmediate(() => writeFileSync(finished, "finished"));
        if (message.startsWith("running ")) {
          started.push(message.split(" ")[2]);
          if (started.length === 3) controller.abort();
        }
      },
    });
    // Progress follows the Worker acknowledgement. The fourth slot can already
    // be dispatched when the third notification requests cancellation.
    assert(started.length >= 3 && started.length <= 4, JSON.stringify(started));
    assert(started.indexOf(downstream.id) > 0 && started.indexOf(downstream.id) <= 2,
      "newly ready comparison must be admitted among the first three starts while expansion is pending");
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});
