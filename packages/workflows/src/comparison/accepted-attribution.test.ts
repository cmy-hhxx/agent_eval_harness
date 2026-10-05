import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { projectEvidenceReferences, ValidationError, emptyUsage, type AgentBinding, type SubmissionReceipt, type ToolAudit, type PlannedTask, type RunState } from "@eval/contracts";
import { attributionAgent, type AttributionResult } from "@eval/agents/attribution";
import { AgentRegistry } from "@eval/host";
import { evidenceId } from "@eval/tools";
import example from "../../../agents/src/attribution/fixtures/example.json" with { type: "json" };
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { acceptedAttributionView } from "./accepted-attribution.js";
import { encodeResult } from "./results.js";

function fixture() {
  const request = structuredClone(example.request);
  // A bound original rule is expanded by the current resolver, independently of model-selected evidence.
  request.input.task_analysis.requirements[0].text = "计算2+2";
  setFixtureNormDirectory(request);
  const result = structuredClone(example.result) as AttributionResult;
  const draft = attributionSubmission(request, result);
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] };
  const submitted = projectEvidenceReferences(draft, audit.evidenceBank!);
  const binding: AgentBinding = { agent: "attribution", profile: "default", request };
  const registry = new AgentRegistry([attributionAgent]);
  const evaluation = registry.resolve(binding, submitted, audit) as AttributionResult;
  registry.validate(binding, evaluation, audit);
  const receipt: SubmissionReceipt = { taskId: randomUUID(), attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "test", judge: "test", submitted, evaluation, audit, usage: emptyUsage() };
  return { receipt, request };
}

function rejected(action: () => unknown, path: string) {
  assert.throws(action, (error: unknown) => error instanceof ValidationError && !!error.issues?.some(issue => issue.path === path));
}

test("accepted canonical coordinates preserve every business field and receipt", () => {
  const { receipt, request } = fixture(), before = structuredClone({ receipt, request });
  const view = acceptedAttributionView(receipt, request);
  assert.deepEqual(view, receipt.evaluation);
  assert.equal(view.findings[0].evidence.length, 2, "the original full norm is program-derived even though the model selected only actual output");
  assert.deepEqual({ receipt, request }, before);
  assert.notEqual(view, receipt.evaluation);
});

test("accepted canonical origins are independent of current model submission rules and evidence-bank contents", () => {
  const { receipt, request } = fixture();
  const submitted = receipt.submitted as Record<string, unknown>;
  for (const draft of [{ ...submitted, unrelated_responsibility_field: true }, {}, undefined]) {
    const historical = structuredClone(receipt);
    historical.submitted = draft;
    historical.audit.evidenceBank = [];
    const before = structuredClone({ historical, request });
    assert.deepEqual(acceptedAttributionView(historical, request), historical.evaluation);
    assert.deepEqual({ historical, request }, before, "source projection never re-runs the current submission resolver or changes accepted history");
  }
});

test("an existing foreign or duplicate-text coordinate is rejected rather than overwritten", () => {
  const { receipt, request } = fixture();
  const result = receipt.evaluation as AttributionResult;
  result.findings[0].evidence[0].evidence_id = evidenceId(randomUUID(), 1, "text", "/content", 0, 5);
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
  request.sources.answer.value.messages.push({ type: "message", role: "assistant", content: "2+2=4" });
  result.findings[0].evidence[0].evidence_id = evidenceId(request.sources.answer.id, 2, "text", "/content", 0, 5);
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
});

test("a stored origin cannot replace a changed accepted quote or source ownership", () => {
  const { receipt, request } = fixture(), result = receipt.evaluation as AttributionResult;
  result.findings[0].evidence[0].quote = "4";
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
  result.findings[0].evidence[0].quote = "2+2=4";
  Object.assign(result.findings[0].evidence[0], { source: "peer", source_input_id: randomUUID() });
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
});

test("a bound peer origin keeps its own source identity even when both sources contain identical text", () => {
  const { receipt, request } = fixture(), result = receipt.evaluation as AttributionResult;
  const peerId = randomUUID();
  const peerRequest = { ...request, sources: { ...request.sources,
    peer: { id: peerId, value: structuredClone(request.sources.answer.value) } } };
  const item = result.findings[0].evidence[0];
  Object.assign(item, { source: "peer", source_input_id: peerId, evidence_id: evidenceId(peerId, 1, "text", "/content", 0, 5) });
  const before = structuredClone({ receipt, peerRequest });
  assert.deepEqual(acceptedAttributionView(receipt, peerRequest), result);
  assert.deepEqual({ receipt, peerRequest }, before);
  item.source_input_id = request.sources.answer.id;
  rejected(() => acceptedAttributionView(receipt, peerRequest), "/findings/0/evidence/0");
  item.source_input_id = peerId;
  item.evidence_id = evidenceId(request.sources.answer.id, 1, "text", "/content", 0, 5);
  rejected(() => acceptedAttributionView(receipt, peerRequest), "/findings/0/evidence/0");
  delete item.source;
  rejected(() => acceptedAttributionView(receipt, peerRequest), "/findings/0/evidence/0");
});

test("canonical image origins require the original source image and its accepted viewing audit", () => {
  const { receipt, request } = fixture(), result = receipt.evaluation as AttributionResult;
  request.sources.answer.value.messages.push({ type: "message", role: "assistant", content: "data:image/png;base64,aW1hZ2U=" });
  const item = result.findings[0].evidence[0];
  Object.assign(item, { evidence_id: evidenceId(request.sources.answer.id, 2, "image"), message_index: 2, quote: "[图像观察]图中显示4" });
  receipt.audit.viewedImages = ["answer:2"];
  const before = structuredClone({ receipt, request });
  assert.deepEqual(acceptedAttributionView(receipt, request), result);
  assert.deepEqual({ receipt, request }, before);
  receipt.audit.viewedImages = ["peer:2"];
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
  receipt.audit.viewedImages = ["answer:2"];
  request.sources.answer.value.messages[2] = { type: "message", role: "assistant", content: "仅有文字4" };
  rejected(() => acceptedAttributionView(receipt, request), "/findings/0/evidence/0");
});

test("a receipt without a raw submission still requires valid complete formal origins", () => {
  const { receipt, request } = fixture();
  delete receipt.submitted;
  assert.deepEqual(acceptedAttributionView(receipt, request), receipt.evaluation);
  const result = receipt.evaluation as AttributionResult;
  result.correctness_evidence[0].evidence_id = evidenceId(randomUUID(), 1, "text", "/content", 0, 5);
  rejected(() => acceptedAttributionView(receipt, request), "/correctness_evidence/0");
  delete (result.correctness_evidence[0] as Partial<AttributionResult["correctness_evidence"][number]>).evidence_id;
  rejected(() => acceptedAttributionView(receipt, request), "/correctness_evidence/0");
});

test("each canonical criterion and table-resolution evidence slot is checked against its exact raw origin", () => {
  const { receipt, request } = fixture(), result = receipt.evaluation as AttributionResult;
  result.table_resolutions = [{ table_id: "table", row_index: 0, outcome: "supported", reason: "原来源支持该行。",
    evidence: [structuredClone(result.correctness_evidence[0])] }];
  assert.deepEqual(acceptedAttributionView(receipt, request), result);
  for (const [item, path] of [
    [result.criterion_assessments[0].evidence[0], "/criterion_assessments/0/evidence/0"],
    [result.table_resolutions[0].evidence[0], "/table_resolutions/0/evidence/0"],
  ] as const) {
    const original = item.evidence_id;
    item.evidence_id = evidenceId(randomUUID(), 1, "text", "/content", 0, 5);
    rejected(() => acceptedAttributionView(receipt, request), path);
    item.evidence_id = original;
  }
});

test("durable exports survive unavailable, narrowed and changed inputs without revalidating accepted tasks", () => {
  const { receipt, request } = fixture();
  const task = { id: receipt.taskId, stage: "attribution", inputIds: { answer: request.sources.answer.id },
    dependencies: {}, data: { stage: "attribution" } } as PlannedTask;
  receipt.exported = { id: task.id, file: "attribution.jsonl", row: { evaluation_type: "attribution", evaluation: receipt.evaluation } };
  const state = { receipts: { [task.id]: receipt } } as RunState;
  const before = structuredClone(receipt);
  for (const inputs of [{}, { unrelated: { messages: [] } }, { [request.sources.answer.id]: { messages: [{ content: "已更新原输入" }] } }]) {
    const exported = encodeResult(task, state, inputs);
    assert.deepEqual(exported, receipt.exported);
    assert.strictEqual(exported.row, receipt.exported.row);
    assert.deepEqual(receipt, before);
  }
  delete receipt.exported.file;
  const exported = encodeResult(task, state, {});
  assert.equal(exported.file, "attribution.jsonl");
  assert.strictEqual(exported.row, receipt.exported.row);
  assert.equal(Object.hasOwn(receipt.exported, "file"), false, "descriptor completion does not mutate the durable receipt");
});

test("an accepted rewrite still merges its current slots into the durable source row", () => {
  const { receipt } = fixture();
  const source = { id: receipt.taskId, stage: "attribution", inputIds: {}, dependencies: {}, data: { stage: "attribution" } } as PlannedTask;
  receipt.exported = { id: source.id, file: "attribution.jsonl", row: { evaluation_type: "attribution", evaluation: {
    ...(receipt.evaluation as AttributionResult), rewritten: { evaluator_version: "test", rewrites: [{ id: "summary", text: "此前文案" }] },
  } } };
  const rewrite = { id: randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: source.id },
    data: { stage: "rewrite", rewriteOf: { stage: "attribution", taskId: source.id } } } as PlannedTask;
  const polish: SubmissionReceipt = { ...structuredClone(receipt), taskId: rewrite.id,
    evaluation: { rewrites: [{ id: "summary", text: "新的文案" }, { id: "findings.0.text", text: "保留新增槽位" }] } };
  const state = { receipts: { [source.id]: receipt, [rewrite.id]: polish }, manifest: { tasks: [source, rewrite] } } as unknown as RunState;
  const before = structuredClone(state);
  const exported = encodeResult(rewrite, state, {});
  assert.equal(exported.auxiliary, true);
  assert.equal(exported.id, source.id);
  assert.deepEqual((exported.row.evaluation as Record<string, unknown>).rewritten, {
    evaluator_version: "test", rewrites: [{ id: "summary", text: "新的文案" }, { id: "findings.0.text", text: "保留新增槽位" }],
  });
  assert.deepEqual(state, before, "polish projection does not edit accepted judgments or saved receipts");
});

test("historical rewrite replay uses the newest accepted owner per slot despite reversed task order", () => {
  const { receipt } = fixture();
  const source = { id: receipt.taskId, stage: "attribution", inputIds: {}, dependencies: {}, data: { stage: "attribution" } } as PlannedTask;
  receipt.exported = { id: source.id, file: "attribution.jsonl", row: { evaluation_type: "attribution", evaluation: receipt.evaluation } };
  const rewrite = (id: string): PlannedTask => ({ id, stage: "rewrite", inputIds: {}, dependencies: { source: source.id },
    data: { stage: "rewrite", rewriteOf: { stage: "attribution", taskId: source.id } } });
  const old = rewrite(randomUUID()), current = rewrite(randomUUID());
  const oldReceipt = { ...structuredClone(receipt), taskId: old.id, acceptedAt: 10, evaluatorVersion: "original-polish",
    evaluation: { rewrites: [{ id: "summary", text: "旧文案" }, { id: "findings.0.text", text: "未刷新槽位" }] } };
  const currentReceipt = { ...structuredClone(receipt), taskId: current.id, acceptedAt: 20, evaluatorVersion: "refreshed-polish",
    evaluation: { rewrites: [{ id: "summary", text: "新文案" }] } };
  const state = { receipts: { [source.id]: receipt, [old.id]: oldReceipt, [current.id]: currentReceipt },
    manifest: { tasks: [source, current, old] } } as unknown as RunState;
  const before = structuredClone(state);
  for (const task of [current, old]) assert.deepEqual((encodeResult(task, state, {}).row.evaluation as Record<string, unknown>).rewritten, {
    evaluator_version: "refreshed-polish", rewrites: [{ id: "summary", text: "新文案" }, { id: "findings.0.text", text: "未刷新槽位" }],
  });
  assert.deepEqual(state, before, "latest presentation projection leaves every historical receipt intact");
  currentReceipt.acceptedAt = 10;
  assert.equal(((encodeResult(current, state, {}).row.evaluation as Record<string, unknown>).rewritten as { rewrites: { text: string }[] }).rewrites[0]!.text,
    "旧文案", "equal real acceptance times use the final manifest occurrence as the stable tie breaker");
});
