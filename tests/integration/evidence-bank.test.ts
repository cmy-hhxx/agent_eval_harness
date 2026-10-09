import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, evidenceId, projectEvidenceReferences,
  type AgentBinding, type AgentProfile, type AttemptSpec, type AttemptStatus, type EvidenceBankUpdate,
  type RunRepository, type RunState, type Submission, type FailureContext, type AgentBackend, type WorkflowDefinition } from "@eval/contracts";
import { AgentRegistry, RunStore, runEvaluation } from "@eval/host";
import { createRunRepository, type RunCodec } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { piBackend } from "@eval/runtime/pi";
import { body, json, listen, request } from "@eval/runtime/http";
import { resolveEvidence } from "@eval/tools";
import { fakeIdentity } from "../fixtures/comparison.js";
import { waitForTestState } from "../fixtures/wait.js";

const id = "11111111-1111-4111-8111-111111111111";
const ref = evidenceId(id, 0, "text", "/content", 0, 4), second = evidenceId(id, 1, "text", "/content", 0, 4);
const refSchema = { type: "object", required: ["evidence_id"], additionalProperties: false, properties: { evidence_id: { type: "string" } } };
const schema = { type: "object", required: ["proof"], additionalProperties: false, properties: { proof: refSchema } };

/** Local SDK wire replay only: no external provider or real evaluation materials. */
test("Pi Worker persists choices before returning them and reuses their prefix across a failed attempt", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-bank-sdk-"));
  const source = { messages: [{ content: "原答一。" }, { content: "来源二。" },
    { content: { evidence_id: "business-id", source_input_id: "business-source", nested: { evidence_id: ref } } }] };
  const binding: AgentBinding = { agent: "bank", profile: "default", request: { input: {}, sources: { answer: { id, value: source } } },
    modelInput: { final: { reference: { evidence_id: ref }, quote: "原答一。" } }, projectModelInput: (value, bank) => projectEvidenceReferences(value, bank) };
  const profile: AgentProfile = { id: "default", evidenceSelections: true, requestSchema: { type: "object" }, submissionSchema: schema,
    systemPrompt: "Choose evidence.", instructions: "Choose evidence.", submissionNudge: "Submit.", toolNames: ["read_trace"], fileSubmission: false,
    toolDescriptions: { read_trace: "Read original evidence.", submit_evaluation: "Submit the choice." }, renderPrompt: value => JSON.stringify(value),
    validateSubmission(_request, value) {
      return (value as { proof?: { evidence_id?: string } }).proof?.evidence_id === ref ? [{ category: "evidence", code: "source_missing",
        path: "/proof", message: "Read the actual supporting source.", expected: { suggested_evidence: [{ quote: "来源二。", reference: { evidence_id: second } }] } }] : [];
    },
    resolve(_request, value, audit) {
      const result = value as { proof: { evidence_id: string } };
      resolveEvidence(source, result.proof, "answer", audit, "/proof", id);
      return result;
    } };
  const agents = new AgentRegistry([{ id: "bank", profiles: { default: profile } }]);
  const task = { id: "bank-task", stage: "bank", inputIds: { answer: id }, dependencies: {}, data: {} };
  const state: RunState = { manifest: { format: "evaluation-run", runId: "bank-test", debug: false, status: "running", engine: fakeIdentity,
    evaluatorVersion: "fixture", config: {}, tasks: [task], inputs: { [id]: { id, name: "answer" } }, states: { [task.id]: { status: "pending", attempts: 0 } },
    preflight: {}, startedAt: Date.now() }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const saved: RunState[] = [];
  const repository: RunRepository = { async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun(_run, value) { saved.push(structuredClone(value)); }, createResultWriter() { return async () => {}; } };
  const original = { ...source, messages: source.messages.map((message, index) => index === 1 ? { content: "raw" } : message) };
  const store = new RunStore(directory, state, { [id]: original }, { agents, repository, taskSource: { id: "bank", bind: () => binding } });
  const updates: EvidenceBankUpdate[] = [];
  const host = await listen(async (req, res, url) => {
    if (url.pathname === "/api/evidence-bank") {
      const update = await body(req) as unknown as EvidenceBankUpdate; updates.push(structuredClone(update));
      const result = await store.registerEvidenceBank(update);
      if (updates.length === 1) res.destroy(); else json(res, result); // Retrying the same append does not allocate another choice.
    } else if (url.pathname.endsWith("/checkpoint")) { await store.checkpoint(task.id, await body(req) as FailureContext); json(res, { saved: true }); }
    else if (url.pathname === "/api/submissions") json(res, await store.accept(await body(req) as Submission));
    else if (url.pathname.includes("/submissions/")) json(res, await store.findSubmission(url.pathname.split("/").at(-1)!));
    else json(res, source);
  });
  const requests: Record<string, unknown>[] = [];
  const gateway = await listen(async (req, res) => {
    const payload = await body(req) as Record<string, unknown>; requests.push(payload);
    const sequence = requests.length;
    if (sequence === 2) {
      assert.equal(saved.at(-1)!.manifest.states[task.id].failure!.evidenceBank!.length, 1,
        "rejection feedback cannot allocate an unpersisted choice");
      const offered = JSON.stringify(payload).replaceAll("\\", "");
      assert(!/"evidence_index"\s*:\s*2\b/.test(offered), "new suggested evidence must be read before receiving a number");
      assert(offered.includes("read_request")); assert(offered.includes("来源二。")); assert(!offered.includes(second));
    }
    if (sequence === 3) {
      const persisted = saved.at(-1)!.manifest.states[task.id].failure!.evidenceBank!;
      assert.equal(persisted.length, 2, "the second choice is durable before the SDK receives its tool result");
      assert(JSON.stringify(payload).includes('evidence_index'));
    }
    assert(sequence <= 4, "feedback read, failed choice and resumed successful submission");
    const args = sequence === 2 ? { candidate: "answer", message_index: 1, path: "/content", offset: 0, max_chars: 4 }
      : { proof: { evidence_index: sequence === 1 ? 1 : sequence === 3 ? 999 : 2 } };
    const name = sequence === 2 ? "read_trace" : "submit_evaluation";
    const call = { type: "function_call", id: `fc_${sequence}`, call_id: `call_${sequence}`, name, arguments: JSON.stringify(args) };
    const events = [{ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { id: `resp_${sequence}`, status: "completed", output: [call], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
  });
  const keyName = "EVIDENCE_BANK_TEST_KEY", previous = process.env[keyName], previousOffline = process.env.PI_OFFLINE;
  process.env[keyName] = "local-fixture-secret"; process.env.PI_OFFLINE = "1";
  const worker = await startWorker(piBackend(fakeIdentity), path.join(directory, "worker"));
  const policy = { ...DEFAULT_POLICY, repairAttempts: 1, timeoutSeconds: 15, idleTimeoutSeconds: 10 };
  const start = async (attemptId: string) => {
    const recovery = state.manifest.states[task.id].failure, prepared = agents.prepare(binding);
    const spec: AttemptSpec = { runId: "bank-test", taskId: task.id, attemptId, inputRevision: 1, engine: fakeIdentity,
      evaluation: prepared.evaluation, policy, prompt: prepared.renderAttempt(policy, recovery), evidenceBank: [...prepared.evidenceBank], recovery,
      inputs: [{ id, name: "answer" }], hostUrl: host.url, deadline: Date.now() + 15000,
      model: { provider: "fixture", baseUrl: gateway.url + "/v1", api: "openai-responses", apiKeyEnv: keyName,
        model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } };
    await store.activate(spec);
    if (attemptId === "first") {
      for (const invalid of [evidenceId("22222222-2222-4222-8222-222222222222", 0, "text", "/content", 0, 1),
        evidenceId(id, 1, "text", "/content", 0, 1000)])
        await assert.rejects(store.registerEvidenceBank({ taskId: task.id, attemptId, evidenceBank: [...spec.evidenceBank, invalid] }));
      assert.deepEqual(state.manifest.states[task.id].failure!.evidenceBank, spec.evidenceBank);
    }
    await request(worker.url + "/api/attempts", "POST", spec);
    const status = await waitForTestState(
      () => request<AttemptStatus>(`${worker.url}/api/attempts/${attemptId}`, "GET"),
      state => state.state !== "running",
      `Evidence-bank Worker attempt ${attemptId} did not settle`,
      20000,
    );
    return { status, spec };
  };
  try {
    const first = await start("first"); assert.equal(first.status.state, "failed");
    const prefix = [...state.manifest.states[task.id].failure!.evidenceBank!];
    assert.equal(prefix.length, 2); assert.deepEqual(updates[0]!.evidenceBank, updates[1]!.evidenceBank);
    assert.deepEqual(state.manifest.states[task.id].failure!.draft, { proof: { evidence_index: 999 } });
    await store.endAttempt(first.spec, "failed", "retry current failed attempt");
    const second = await start("second"); assert.equal(second.status.state, "succeeded");
    assert.deepEqual(second.spec.evidenceBank, prefix);
    const receipt = await store.receipt(task.id);
    assert.deepEqual(receipt!.audit.evidenceBank, prefix);
    assert.deepEqual(receipt!.submitted, { proof: { evidence_index: 2 } });
    assert.equal((receipt!.evaluation as { proof: { evidence_id: string } }).proof.evidence_id, prefix[1]);
    assert.equal(requests.length, 4); assert.equal(receipt!.submissionStats!.contentSubmissions, 3);
    await assert.rejects(store.registerEvidenceBank({ taskId: task.id, attemptId: "first", evidenceBank: [...prefix].reverse() }));
  } finally {
    await worker.close(); await host.close(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
  }
});

test("Host resumes after one same-session draft reminder with the committed evidence directory and submission count", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-bank-host-retry-")), runId = "bank-auto";
  const run = path.join(directory, "runs", runId), task = { id: "bank-task", stage: "bank", inputIds: { answer: id }, dependencies: {}, data: {} };
  const source = { messages: [{ content: "原答一。" }, { content: "来源二。" }] };
  const binding: AgentBinding = { agent: "bank", profile: "default", request: { input: {}, sources: { answer: { id, value: source } } },
    modelInput: { final: { quote: "原答一。", reference: { evidence_id: ref } } }, projectModelInput: (value, bank) => projectEvidenceReferences(value, bank) };
  const profile: AgentProfile = { id: "default", evidenceSelections: true, requestSchema: { type: "object" }, submissionSchema: schema,
    systemPrompt: "Choose actual source evidence.", instructions: "Choose evidence.", submissionNudge: "Submit.", toolNames: ["read_trace"], fileSubmission: false,
    toolDescriptions: { read_trace: "Read actual source.", submit_evaluation: "Submit the choice." },
    renderPrompt: (value, _policy, recovery) => JSON.stringify({ value, ...(recovery ? { draft: recovery.draft, errors: recovery.errors } : {}) }),
    resolve(_request, value, audit) { resolveEvidence(source, (value as { proof: { evidence_id: string } }).proof, "answer", audit, "/proof", id); return value; } };
  const plan = { tasks: [task], inputs: { [id]: source }, summary: {} };
  const workflow: WorkflowDefinition = { id: "bank", plan: async () => plan, bind: () => binding };
  const codec: RunCodec<RunState> = { encode: value => structuredClone(value), decode: value => value, references: () => [], resultId: row => String(row.id) };
  const repository = createRunRepository(codec, (task, state) => ({ id: task.id, file: "proofs.jsonl", row: { id: task.id, result: state.receipts[task.id]!.evaluation } }));
  const started: AttemptSpec[] = [], runs: number[] = [], prefix = [ref, second];
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    const sessionIndex = started.length;
    started.push(structuredClone(options.spec));
    runs.push(0);
    return { async run() {
      runs[sessionIndex]++;
      if (started.length === 1) {
        const read = await options.execute("read_trace", { candidate: "answer", message_index: 1, path: "/content" });
        const displayed = JSON.parse(read.content[0]!.text!).evidence[0];
        assert.deepEqual(displayed.reference, { evidence_index: 2 });
        assert.deepEqual((await repository.readRun(run)).manifest.states[task.id]!.failure!.evidenceBank, prefix);
        assert.equal((await options.execute("submit_evaluation", { proof: { evidence_index: 999 } })).isError, true);
        return;
      }
      assert.equal(started.length, 2);
      assert.deepEqual(options.spec.evidenceBank, prefix);
      assert.deepEqual(options.spec.recovery!.evidenceBank, prefix);
      assert.deepEqual(options.spec.recovery!.draft, { proof: { evidence_index: 999 } });
      assert.equal(options.spec.recovery!.contentSubmissions, 2);
      assert(!options.spec.prompt.includes(second));
      assert.equal((await options.execute("submit_evaluation", { proof: { evidence_index: 2 } })).terminate, true);
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const summary = await runEvaluation({ runId, output: { kind: "directory", path: path.join(directory, "runs") }, config: {}, plan,
      taskSource: workflow, repository, agents: new AgentRegistry([{ id: "bank", profiles: { default: profile } }]),
      runtime: { root: directory, workerEntry: "unused-with-external-worker" }, engine: "pi", identity: fakeIdentity, evaluatorVersion: "fixture",
      policy: { ...DEFAULT_POLICY, repairAttempts: 2, timeoutSeconds: 10, idleTimeoutSeconds: 5 },
      modelForStage: () => ({ provider: "fixture", baseUrl: "http://127.0.0.1:1", api: "openai-responses", apiKeyEnv: "LOCAL_TEST_KEY",
        model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 }),
      concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url] });
    assert.equal(summary.execution_task_statuses.succeeded, 1);
    const saved = await repository.readRun(run), receipt = saved.receipts[task.id]!;
    assert.equal(saved.manifest.states[task.id]!.attempts, 2);
    assert.deepEqual(runs, [2, 1], "one same-session reminder precedes the resumed attempt");
    assert.deepEqual(receipt.submissionStats, { contentSubmissions: 3, fileErrors: 0 });
    assert.deepEqual(receipt.audit.evidenceBank, prefix);
    assert.deepEqual(receipt.submitted, { proof: { evidence_index: 2 } });
    assert.equal((receipt.evaluation as { proof: { evidence_id: string } }).proof.evidence_id, second);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
