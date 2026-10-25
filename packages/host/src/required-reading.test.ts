import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, emptyUsage, HttpError, ValidationError, type AgentBinding, type AgentProfile, type AttemptSpec,
  type RunRepository, type RunState, type Submission, type TraceRead } from "@eval/contracts";
import { AgentRegistry } from "./agents.js";
import { RunStore } from "./store.js";

const id = "11111111-1111-4111-8111-111111111111";
const target: TraceRead = { candidate: "answer", message_index: 0, kind: "text", path: "/content", start: 0, end: 4 };

for (const mode of ["initial", "dynamic", "inspection"]) test(`Host protected reads use bound trace sources (${mode})`, async () => {
  const initial = mode === "initial", inspection = mode === "inspection";
  // AIME storage has traces[], while the task adapter exposes messages[] to the Worker.
  const source = { messages: [{ content: "真实字段" }] };
  const binding: AgentBinding = { agent: "reads", profile: "default", request: {
    input: {}, sources: { answer: { id, value: source } },
  } };
  if (inspection) { binding.modelInput = {}; binding.inspectionInput = {}; }
  const profile: AgentProfile = {
    id: "default", requestSchema: { type: "object" }, submissionSchema: { type: "object" },
    systemPrompt: "Read sources.", instructions: "Read sources.", submissionNudge: "Submit.",
    fileSubmission: false, toolNames: ["read_trace", ...(inspection ? ["inspect_material"] : [])],
    toolDescriptions: { read_trace: "Read source.", submit_evaluation: "Submit.", ...(inspection ? { inspect_material: "Register source review." } : {}) },
    renderPrompt: () => "Read sources.", requiredReads: () => initial ? [target] : [],
    resolve: (_request, value) => value,
    validateSubmission: (_request, _value, audit) => audit?.traceReads.some(read =>
      read.candidate === target.candidate && read.message_index === target.message_index && read.path === target.path &&
      read.start === 0 && read.end === 4) ? [] : [{ category: "evidence", code: "investigation_read_required",
      path: "/proof", message: "Read the actual source.", expected: target }],
  };
  if (inspection) profile.inspection = { schema: { type: "object" }, validate(request, value, audit) {
    const issues = profile.validateSubmission!(request, value, audit);
    if (issues.length) throw new ValidationError(issues);
  } };
  const agents = new AgentRegistry([{ id: "reads", profiles: { default: profile } }]);
  const task = { id: "read-task", stage: "reads", inputIds: { answer: id }, dependencies: {}, data: {} };
  const engine = { engine: "pi" as const, version: "test", commit: "test", buildId: "test" };
  const state: RunState = { manifest: { format: "evaluation-run", runId: "read-test", debug: false, status: "running",
    engine, evaluatorVersion: "fixture", config: {}, tasks: [task], inputs: { [id]: { id, name: "answer" } },
    states: { [task.id]: { status: "pending", attempts: 0 } }, preflight: {}, startedAt: Date.now() },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const repository: RunRepository = { async readRun() { return structuredClone(state); }, async readTasks() { return structuredClone(state); },
    async writeRun() {}, createResultWriter() { return async () => {}; } };
  const store = new RunStore("/unused-fixture", state, { [id]: { traces: [source] } },
    { agents, repository, taskSource: { id: "reads", bind: () => binding } });
  const prepared = agents.prepare(binding);
  const spec: AttemptSpec = { runId: "read-test", taskId: task.id, attemptId: "attempt", inputRevision: 1, engine,
    evaluation: prepared.evaluation, policy: { ...DEFAULT_POLICY, maxToolCalls: 0 }, prompt: "Read sources.",
    evidenceBank: [], inputs: [{ id, name: "answer" }], hostUrl: "http://127.0.0.1", deadline: Date.now() + 60000,
    model: { provider: "fixture", baseUrl: "http://127.0.0.1", api: "openai-completions", apiKeyEnv: "FIXTURE_KEY",
      model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } };
  await store.activate(spec);
  const submission: Submission = { taskId: task.id, attemptId: spec.attemptId, submissionId: "first", evaluation: {},
    usage: emptyUsage(), audit: { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [],
      calculations: [], artifacts: [], tableChecks: [], evidenceBank: [] } };
  const inspect = (audit: typeof submission.audit) => store.inspect({ inspectionId: "checkpoint", taskId: task.id,
    attemptId: spec.attemptId, value: {}, audit, contentSubmissions: 1 });
  await assert.rejects(inspection ? inspect(submission.audit) : store.accept(submission), (error: unknown) => error instanceof HttpError &&
    error.issues?.some(issue => issue.code === "investigation_read_required") === true);
  assert.deepEqual(spec.evaluation.requiredReads, [target]);
  // A fabricated page or double charge still cannot consume the protected allowance.
  await assert.rejects(store.accept({ ...submission, submissionId: "invalid", audit: { ...submission.audit,
    calls: 1, requiredReadCalls: 1, traceReads: [{ ...target, end: 5 }] } }), /Invalid tool audit/);
  const readAudit = { ...submission.audit, calls: 1, requiredReadCalls: 1, traceReads: [target] };
  const checkpoint = inspection ? (await inspect(readAudit)).inspection : undefined;
  const receipt = await store.accept({ ...submission, submissionId: "second",
    ...(inspection ? { submissionStats: { contentSubmissions: 2, fileErrors: 0 } } : {}),
    audit: { ...readAudit, ...(checkpoint ? { inspection: checkpoint } : {}) } });
  assert.equal(receipt.status, "succeeded");
});
