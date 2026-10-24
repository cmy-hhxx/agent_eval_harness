import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { blindMaterials } from "./blind.js";
import { instructionSources, resolveEvidence } from "@eval/tools";
import { bindTask } from "./workflow.js";
import { criterionInstructionSources } from "./instruction-bindings.js";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit, raw } from "../../../../tests/fixtures/comparison.js";
import type { AttributionResult, Candidate, RawInput, TaskData } from "./types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

const identities = { A: { version: "a_fast", name: "A组Fast", llm: "secret-model" } } as unknown as Record<string, Candidate>;

test("the complete Markdown norm remains one real evidence span after binding", () => {
  const section = "## 回答方式\n\n仅投资决策触发风险提示。\n\n### 边界\n\n资料不能扩大触发范围。";
  const trace: RawInput = { messages: [{ role: "system", content: `${section}\n\n## 其他\n\n不得编造。` },
    { role: "assistant", content: "结果。" }] };
  const rubric = criteriaResult();
  rubric.requirements = [{ id: "r1", text: section, applies_to: [], acceptance_rule: section }];
  const id = randomUUID();
  assert.deepEqual(criterionInstructionSources(trace, 1, rubric, id), {
    r1: [{ ...canonicalEvidence(id, 0, section), path: "/content" }],
  });
});

test("empty text parts preserve the catalogue's instruction paragraph boundaries", () => {
  const trace: RawInput = { messages: [
    { role: "system", content: [{ text: "条件段落。" }, { text: "" }, { text: "要求段落。" }] },
    { role: "assistant", content: "结果。" },
  ] };
  const rubric = criteriaResult();
  rubric.requirements = ["条件段落。", "要求段落。"].map((text, index) => ({ id: `r${index + 1}`,
    text, applies_to: [], acceptance_rule: text }));
  const id = randomUUID();
  assert.deepEqual(criterionInstructionSources(trace, 1, rubric, id), {
    r1: [{ ...canonicalEvidence(id, 0, "条件段落。", "/content/0/text"), path: "/content/0/text" }],
    r2: [{ ...canonicalEvidence(id, 0, "要求段落。", "/content/2/text"), path: "/content/2/text" }],
  });
});

test("blinding preserves final-answer instruction paths inside LLM contexts", () => {
  const original: RawInput = { messages: [
    { type: "message", role: "user", content: "评估风险" },
    { type: "llm_turn", input_messages: { model: "secret-model", messages: [
      { role: "system", content: "A组Fast：风险放在结论之后。" },
      { role: "user", content: "评估风险" },
    ] }, output: [{ role: "assistant", content: "结论。风险。" }] },
    { type: "message", role: "assistant", content: "结论。风险。" },
  ] };
  const before = structuredClone(original);
  const view = blindMaterials(identities).trace(original);
  const sources = instructionSources(view, evidenceInputId, 2);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.path, "/input_messages/messages/0/content");
  assert.match(String(sources[0]!.content), /风险放在结论之后/);
  assert(!JSON.stringify(view).includes("secret-model"));
  assert(!JSON.stringify(view).includes("A组Fast"));
  for (const evidence of sources[0]!.evidence) {
    assert.equal(resolveEvidence(view, { evidence_id: evidence.evidence_id }, "A", emptyAudit(), "evidence", evidenceInputId).quote, evidence.quote);
  }
  assert.deepEqual(original, before);
});

test("comparison removes source identity from prompt text, trace, and attribution without changing receipts", () => {
  const trace: RawInput = {
    version: "a_fast",
    meta: { usage: { type: "secret-model" } },
    messages: [
      { type: "message", role: "user", content: "评估计算结果" },
      { type: "message", role: "assistant", model: "secret-model", content: "A组Fast 给出 4" },
      { type: "function_call_output", name: "Search", content: { model_id: "a_fast", value: "A组Fast" } },
    ],
  };
  const finding = {
    finding_id: "f1", type: "problem", dimension: "correctness", stage: "execution", importance: "medium",
    text: "A组Fast 的 Search 可能异常", reason: "secret-model 尚待核实", evidence: [canonicalEvidence(evidenceInputId, 2, "A组Fast", "/content/value")],
    assessment: { requirement_index: null, observation: "疑似异常", evidence_status: "uncertain", impact: "若属实会影响结果" },
    problem: { component: [responsibilityFixture("Search", {evidence_ids: ([canonicalEvidence(evidenceInputId, 2, "A组Fast", "/content/value")]).map(item=>item.evidence_id)})], label: "调用结果异常", definition: "结果不完整" },
  } as AttributionResult["findings"][number];
  const attribution: AttributionResult = {
    criterion_assessments: [], core_assessment: { meets_core: true, reason: "已完成。", criterion_ids: ["r1"] },
    has_standard_answer: false, is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [],
    task_analysis: { task_type: "计算", goal: "得到结果", requirements: [{ id: "r1", text: "给出结果", applies_to: [], acceptance_rule: "给出结果" }], scoring_points: [], red_flags: [] },
    summary: "A组Fast 给出可用答案", findings: [finding],
  };
  const blind = blindMaterials(identities);
  const view = blind.trace(trace);
  const result = blind.attribution(attribution);
  assert.deepEqual(Object.keys(view), ["version", "meta", "messages"]);
  for (const name of ["a_fast", "A组Fast", "secret-model"]) {
    assert(!JSON.stringify(view).includes(name));
    assert(!JSON.stringify(result).includes(name));
  }
  assert.equal(view.messages[2]!.name, "Search");
  assert.match(String((view.messages[2]!.content as { model_id: string }).model_id), /^\[身份已隐去\d+\]$/);
  assert.equal(result.findings[0]!.evidence[0]!.quote, (view.messages[2]!.content as { value: string }).value);
  assert.equal(result.findings[0]!.assessment.evidence_status, "uncertain");
  assert.equal(attribution.summary, "A组Fast 给出可用答案");
  assert.equal(trace.messages[1]!.content, "A组Fast 给出 4");
});

test("blinding masks structured keys without collapsing fields and preserves image bytes", () => {
  const blind = blindMaterials({
    A: { version: "aaaaaa", name: "ModelOne", llm: null },
    B: { version: "bbbbbb", name: "ModelTwo", llm: null },
  } as unknown as Record<string, Candidate>);
  const image = "data:image/png;base64,aaaaaaBBBB";
  const original: RawInput = { messages: [{
    type: "message", role: "assistant", content: { aaaaaa: "one", bbbbbb: "two", image },
  }] };
  const view = blind.trace(original);
  const content = view.messages[0]!.content as Record<string, string>;
  assert.equal(Object.keys(content).length, 3);
  assert.equal(content.image, image);
  const { image: _image, ...text } = content;
  assert(!JSON.stringify(text).includes("aaaaaa"));
  assert(!JSON.stringify(text).includes("bbbbbb"));
  assert.deepEqual(Object.keys(original.messages[0]!.content as object), ["aaaaaa", "bbbbbb", "image"]);
});

test("standalone short version IDs are masked without changing longer business tokens", () => {
  const blind = blindMaterials({ A: { version: "v1", name: "ExampleModel", llm: null } } as unknown as Record<string, Candidate>);
  const text = blind.value("v1 的输出；保留 v10、v1stock、版本v1");
  assert.match(text, /^\[身份已隐去\d+\] 的输出；保留 v10、v1stock、版本v1$/);
});

test("comparison binds the same blind rubric as its source attributions and preserves accepted criteria", () => {
  const candidates: Record<string, Candidate> = Object.fromEntries(["A", "B"].map((label) => [label, {
    batch_id: "b1", case_id: "q1", input_id: randomUUID(), version: `${label.toLowerCase()}_fast`, name: `${label}组Fast`,
    llm: `secret-model-${label}`, trace_id: null, source: `fixture-${label}.jsonl`, line: 1,
    question: "计算2+2", final_index: 1, reference: "4",
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: 1.2,
      source_unit: "milliseconds", source_values: {}, source_fields: {} },
  }]));
  const task: PlannedTask = {
    id: randomUUID(), stage: "comparison", inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    dependencies: { criteria: randomUUID(), A: randomUUID(), B: randomUUID() },
    data: { stage: "comparison", candidates, reference: "4", group: ["a_fast", "b_fast"] } satisfies TaskData,
  };
  const rubric = criteriaResult();
  rubric.goal = "核对 a_fast 与 b_fast 的加法结果";
  rubric.requirements[0].text = "A组Fast 和 B组Fast 都应给出正确结果";
  rubric.requirements[0].acceptance_rule = "secret-model-A 与 secret-model-B 的最终回答均须给出 4";
  const receipt = (label: string, evaluation: unknown): SubmissionReceipt => ({
    taskId: task.dependencies[label], attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation,
    audit: emptyAudit(), usage: emptyUsage(),
  });
  const dependencies = Object.fromEntries(["criteria", "A", "B"].map((label) => {
    if (label === "criteria") return [label, receipt(label, structuredClone(rubric))];
    const attribution = attributionResult(true, "2+2=4", true, candidates[label].input_id);
    attribution.task_analysis = structuredClone(rubric);
    return [label, receipt(label, attribution)];
  }));
  const accepted = structuredClone(dependencies);
  const criteriaTask: PlannedTask = { id: task.dependencies.criteria, stage: "criteria", inputIds: task.inputIds,
    dependencies: {}, data: { stage: "criteria", candidates, reference: "4" } satisfies TaskData };
  const binding = bindTask(task, Object.fromEntries(Object.values(candidates).map((candidate) => [candidate.input_id, raw()])), dependencies,
    { tasks: [criteriaTask, task] });
  const input = binding.request.input as { task_analysis: typeof rubric; attributions: Record<string, AttributionResult> };
  const scope = binding.modelInput!.comparison_scope as { common_criterion_ids: string[]; findings: Record<string, unknown[]> };
  assert.deepEqual(scope.common_criterion_ids, rubric.requirements.map(item => item.id));
  assert.deepEqual(Object.keys(scope.findings), ["A", "B"]);
  assert.equal(Object.hasOwn(binding.request.input, "comparison_scope"), false);
  assert.deepEqual(input.task_analysis, rubric);
  assert.notDeepEqual(binding.modelInput!.task_analysis, rubric, "identity masking is display-only");
  for (const attribution of Object.values(input.attributions)) assert.deepEqual(attribution.task_analysis, rubric, "accepted source analyses retain original program facts");
  for (const identity of Object.values(candidates).flatMap((candidate) => [candidate.version, candidate.name, candidate.llm!])) {
    assert(!JSON.stringify(binding.modelInput).includes(identity), identity);
  }
  assert.deepEqual(dependencies, accepted);
  for (const [label, source] of Object.entries(binding.request.sources)) assert.deepEqual(source.value, raw(), label);
  assert.deepEqual(dependencies.criteria.evaluation, rubric);
  const registry = new AgentRegistry([comparisonAgent]);
  const result = comparisonResult();
  result.task_analysis = structuredClone(input.task_analysis);
  assert.doesNotThrow(() => registry.validate(binding, result, emptyAudit()));
});
