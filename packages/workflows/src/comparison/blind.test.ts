import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent } from "@eval/agents/comparison";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { blindMaterials } from "./blind.js";
import { bindTask } from "./workflow.js";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit, raw } from "../../../../tests/fixtures/comparison.js";
import type { AttributionResult, Candidate, RawInput, TaskData } from "./types.js";

const identities = { A: { version: "a_fast", name: "A组Fast", llm: "secret-model" } } as unknown as Record<string, Candidate>;

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
    text: "A组Fast 的 Search 可能异常", reason: "secret-model 尚待核实", evidence: [{ message_index: 2, quote: "A组Fast" }],
    assessment: { requirement_index: null, observation: "疑似异常", evidence_status: "uncertain", impact: "若属实会影响结果" },
    problem: { component: ["Search"], label: "调用结果异常", definition: "结果不完整" },
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
  assert.deepEqual(Object.keys(view), ["messages"]);
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
    const attribution = attributionResult();
    attribution.task_analysis = structuredClone(rubric);
    return [label, receipt(label, attribution)];
  }));
  const accepted = structuredClone(dependencies);
  const binding = bindTask(task, Object.fromEntries(Object.values(candidates).map((candidate) => [candidate.input_id, raw()])), dependencies);
  const input = binding.request.input as { task_analysis: typeof rubric; attributions: Record<string, AttributionResult> };
  assert.notDeepEqual(input.task_analysis, rubric);
  for (const attribution of Object.values(input.attributions)) assert.deepEqual(attribution.task_analysis, input.task_analysis);
  for (const identity of Object.values(candidates).flatMap((candidate) => [candidate.version, candidate.name, candidate.llm!])) {
    assert(!JSON.stringify(binding.request).includes(identity), identity);
  }
  assert.deepEqual(dependencies, accepted);
  assert.deepEqual(dependencies.criteria.evaluation, rubric);
  const registry = new AgentRegistry([comparisonAgent]);
  const result = comparisonResult();
  result.task_analysis = structuredClone(input.task_analysis);
  assert.doesNotThrow(() => registry.validate(binding, result, emptyAudit()));
});
