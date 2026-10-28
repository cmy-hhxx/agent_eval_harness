import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type AgentBackend, type PlannedTask, type RunRepository, type RunState } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { startWorkerPool } from "@eval/runtime/worker";
import { fakeIdentity } from "../../fixtures/comparison.js";

test("Host shares active material across Worker slots without mixing presentations or writable session files", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-material-sharing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { messages: [{ role: "assistant", content: "Model Alpha answer" }] };
  const tasks: PlannedTask[] = Array.from({ length: 4 }, () => ({
    id: randomUUID(), stage: "review", inputIds: { source: "source" }, dependencies: {}, data: null,
  }));
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
  const urls: string[] = [], ids = new Map<string, string>(), files = new Map<string, string>();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (/\/api\/(materials|inputs)\//u.test(String(input))) urls.push(String(input));
    return fetch(input, init);
  });
  let ready!: () => void, mutated!: () => void, firstFinished!: () => void;
  const allReady = new Promise<void>(resolve => { ready = resolve; });
  const changed = new Promise<void>(resolve => { mutated = resolve; });
  const firstDone = new Promise<void>(resolve => { firstFinished = resolve; });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      const index = tasks.findIndex(task => task.id === options.spec.taskId);
      const file = path.join(options.workdir, "inputs/source.json");
      const visible = index === 2 ? "Candidate B answer" : "Candidate A answer";
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { messages: [{ role: "assistant", content: visible }] });
      ids.set(options.spec.taskId, options.spec.inputs[0].materialId!);
      files.set(options.spec.taskId, file);
      if (files.size === 4) ready();
      await allReady;
      if (index === 0) {
        await writeFile(file, "changed by one session");
        mutated();
      }
      await changed;
      if (index !== 0) assert.equal(JSON.parse(await readFile(file, "utf8")).messages[0].content, visible);
      if (index !== 0) await firstDone;
      if (index === 1) {
        const response = await fetch(`${options.spec.hostUrl}/api/materials/${ids.get(tasks[0].id)}`);
        assert.equal(response.status, 200, "the first finished attempt cannot remove another active attempt's source");
        assert.deepEqual(await response.json(), source);
      }
      assert.equal((await options.execute("submit_evaluation", {})).isError, undefined);
    }, async abort() {}, async dispose() {},
  }; } };
  const pool = await startWorkerPool(backend, path.join(directory, "worker"), 4);
  t.after(() => pool.close());
  await runEvaluation({ repository, agents, runtime: { root: directory, workerEntry: "unused" },
    taskSource: { id: "fixture", bind(task) {
      const index = tasks.findIndex(item => item.id === task.id);
      return { agent: "fixture", profile: "default", request: {
        input: {}, sources: { source: { id: "source", value: index === 3 ? structuredClone(source) : source,
          presentation: { redactions: [{ text: "Model Alpha", replacement: index === 2 ? "Candidate B" : "Candidate A" }], omitMessageKeys: [] } } },
      } };
    } }, runId: "shared", output: { kind: "directory", path: directory }, config: {},
    plan: { tasks, inputs: {}, summary: {} }, engine: "pi", identity: fakeIdentity, evaluatorVersion: "fixture",
    policy: { ...DEFAULT_POLICY, timeoutSeconds: 10, idleTimeoutSeconds: 10 },
    modelForStage: () => ({ provider: "fixture", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
      apiKeyEnv: "MATERIAL_SHARING_KEY", model: "fixture", thinking: "off", contextWindow: 4096, maxOutputTokens: 100 }),
    concurrency: 4, retries: 0, retryDelaySeconds: 0, workerUrls: pool.urls,
    onProgress(message) { if (message === `succeeded review ${tasks[0].id}`) firstFinished(); },
  });
  const state = await repository.readRun(path.join(directory, "shared"));
  assert.equal(Object.values(state.receipts).filter(receipt => receipt.status === "succeeded").length, 4);
  assert.equal(urls.length, 3, "two equal views share one download; another presentation and another source remain separate");
  assert.equal(new Set(urls).size, 2, "body equality does not merge distinct source objects");
  assert.equal(ids.get(tasks[0].id), ids.get(tasks[1].id));
  assert.notEqual(ids.get(tasks[0].id), ids.get(tasks[3].id));
  assert.deepEqual(source, { messages: [{ role: "assistant", content: "Model Alpha answer" }] });
  assert.deepEqual(await readdir(path.join(directory, "worker/materials")), [], "the last session releases shared files");
});
