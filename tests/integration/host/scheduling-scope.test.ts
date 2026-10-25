import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, type AgentBackend, type EngineIdentity, type ModelConfig, type PlannedTask, type RunRepository, type RunState, type SubmissionReceipt, type TaskState } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";

const identity: EngineIdentity = { engine: "pi", version: "fixture", commit: "fixture", buildId: "fixture" };
const model: ModelConfig = { provider: "fixture", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
  apiKeyEnv: "SCHEDULING_SCOPE_FIXTURE_KEY", model: "fixture", thinking: "off", contextWindow: 4096, maxOutputTokens: 100 };

for (const outsidePerStage of [0, 1, 100]) test(`frozen scope prioritizes primary stages with ${outsidePerStage} outside tasks per upstream stage`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-scheduling-scope-"));
  const acceptedId = randomUUID(), tasks: PlannedTask[] = [{ id: acceptedId, stage: "criteria", dependencies: {}, inputIds: {}, data: null }], scope: string[] = [acceptedId];
  for (const stage of ["criteria", "attribution", "rewrite"]) {
    for (let index = 0; index < (stage === "rewrite" ? 0 : outsidePerStage); index++)
      tasks.push({ id: `outside-${stage}-${index}`, stage, dependencies: {}, inputIds: {}, data: null });
    for (let index = 0; index < 3; index++) {
      const id = `selected-${stage}-${index}`;
      tasks.push({ id, stage, dependencies: {}, inputIds: {}, data: null });
      scope.push(id);
    }
  }
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
  const acceptedProgress: TaskState = { status: "succeeded", attempts: 2, revision: 3, channel: "previous-channel",
    failure: { errors: [], contentSubmissions: 2, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: randomUUID() } };
  const accepted: SubmissionReceipt = { taskId: acceptedId, attemptId: acceptedProgress.failure!.attemptId, submissionId: randomUUID(),
    status: "succeeded", acceptedAt: 1, evaluatorVersion: "previous-fixture", judge: "previous-model", evaluation: { accepted: true },
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
    submissionStats: { contentSubmissions: 2, fileErrors: 0 } };
  await repository.writeRun(path.join(directory, "scope"), {
    manifest: { format: "evaluation-run", debug: false, runId: "scope", status: "interrupted", engine: identity,
      evaluatorVersion: "previous-fixture", config: {}, tasks, inputs: {}, preflight: {}, startedAt: 1, executionScope: scope,
      states: Object.fromEntries(tasks.map(task => [task.id, task.id === acceptedId ? acceptedProgress : { status: "pending", attempts: 0 }])) },
    receipts: { [acceptedId]: accepted }, usage: emptyUsage(), recordedAttempts: 2,
  });
  const started: string[] = [], controller = new AbortController();
  const backend: AgentBackend = { identity, async createSession(options) {
    let release = () => {};
    return { async run() {
      const stopped = new Promise<void>(resolve => { release = resolve; });
      started.push(options.spec.taskId);
      if (started.length === 3) controller.abort();
      await stopped;
    }, async abort() { release(); }, async dispose() {} };
  } };
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  try {
    for (let index = 0; index < 3; index++) workers.push(await startWorker(backend, path.join(directory, "worker-" + index)));
    const result = await runEvaluation({ repository, agents,
      taskSource: { id: "fixture", bind(task, _inputs, _dependencies, context) {
        assert.equal(context.tasks.length, tasks.length, "binding still receives the full frozen plan");
        return { agent: "fixture", profile: "default", request: { input: { taskId: task.id }, sources: {} } };
      } },
      runtime: { root: path.resolve("."), workerEntry: "unused" }, runId: "scope", output: { kind: "directory", path: directory },
      config: {}, plan: { tasks, inputs: {}, summary: {} }, engine: "pi", identity, evaluatorVersion: "fixture",
      policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 10 }, modelForStage: () => model,
      concurrency: 3, retries: 0, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    });
    assert.equal(result.status, "interrupted");
    assert.equal(started.length, 3);
    assert.deepEqual(started.map(id => tasks.find(task => task.id === id)!.stage).sort(), ["attribution", "attribution", "criteria"],
      "outside-scope ready work must not occupy virtual stage slots before dispatch filtering");
    assert(started.every(id => scope.includes(id)), "no outside task reaches a Worker");
    const saved = await repository.readRun(path.join(directory, "scope"));
    assert.deepEqual(saved.manifest.executionScope, scope);
    assert.equal(saved.manifest.tasks.length, tasks.length);
    assert.deepEqual(saved.receipts[acceptedId], accepted, "saved source UUID, verdict, version and content receipt remain unchanged");
    assert.deepEqual(saved.manifest.states[acceptedId], acceptedProgress, "accepted attempts and content progress are never reset or rerun");
    for (const task of tasks.filter(task => !scope.includes(task.id)))
      assert.deepEqual(saved.manifest.states[task.id], { status: "pending", attempts: 0 }, "outside tasks retain their state and budget");
  } finally {
    controller.abort();
    await Promise.all(workers.map(worker => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
