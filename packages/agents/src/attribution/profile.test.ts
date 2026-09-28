import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { evidenceId } from "@eval/tools";

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("numeric ledger verifies rounded values against final-answer evidence", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "2023年9.4";
  request.sources.answer.value.messages[1]!.content = "2023年9.36";
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [{ message_index: 1, quote: "2023年9.36" }];
  result.findings = [];
  result.numeric_checks = [{ label: "2023", expected: "9.4", actual: "9.36", scale: "1", mode: "rounded", matches: false,
    evidence_index: 0 }];
  assert.throws(() => attributionProfile.validate!(request, result, audit), /matches 应为 true/);
  result.numeric_checks[0]!.matches = true;
  attributionProfile.validate!(request, result, audit);
  result.numeric_checks[0]!.actual = "19.36";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /原始数值/);
  result.numeric_checks[0]!.actual = "9.36";
  result.numeric_checks[0]!.expected = "9.5";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /来自标准答案/);
  result.numeric_checks[0]!.scale = "0";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /比例必须大于零/);
  result.numeric_checks[0] = { label: "2023", expected: "9.4", actual: null, scale: "1", mode: "rounded", matches: false, evidence_index: 0 };
  result.is_correct = false;
  attributionProfile.validate!(request, result, audit);
});

test("final-answer images must be inspected before claiming a missing deliverable", () => {
  const request = structuredClone(example.request);
  Object.assign(request.sources.answer.value.messages[1]!, { content: [
    { type: "text", text: "2+2=4" }, { type: "image", mimeType: "image/png", data: "AA==" },
  ] });
  assert.throws(() => attributionProfile.validate!(request, example.result, audit), /最终回答含图片/);
  attributionProfile.validate!(request, example.result, { ...audit, viewedImages: ["answer:1"] });
});
test("unresolved root cause cannot be assigned to the model", () => {
  const result = structuredClone(example.result) as AttributionResult;
  result.findings[0]!.type = "problem";
  result.findings[0]!.problem = {
    component: ["模型自身推理"], label: "数值偏差",
    definition: "现有材料能确认结果偏差，但不能确定是上游数据、口径还是模型计算的具体根因。",
  };
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /根因.*待定位/);
  result.findings[0]!.problem!.component = [];
  attributionProfile.validate!(example.request, result, audit);
  result.findings[0]!.problem!.component = ["模型自身推理"];
  result.findings[0]!.problem!.definition = "模型将前复权字段误写为不复权，忽略可见冲突；FinQuery是否返回错误字段尚未确定，因此不将FinQuery列为责任组件。";
  attributionProfile.validate!(example.request, result, audit);
});
test("Attribution judges one answer, conditionally on the standard answer", () => {
  assert.deepEqual(Object.keys(attributionAgent.profiles), ["default"]);
  attributionProfile.validate!(example.request, example.result, audit);
  const { has_standard_answer: _derived, ...submission } = example.result;
  const draft = {
    ...submission,
    correctness_evidence: [{ evidence_id: evidenceId(1, "text", "/content", 0, 5) }],
    findings: example.result.findings.map((finding) => ({
      ...finding,
      finding_id: "f1",
      evidence: [{ evidence_id: evidenceId(1, "text", "/content", 0, 5) }],
    })),
  };
  assert.deepEqual(attributionProfile.resolve!(example.request, draft, audit), example.result);

  const duplicateFindingId = structuredClone(example.result);
  duplicateFindingId.findings = [duplicateFindingId.findings[0]!, duplicateFindingId.findings[0]!];
  assert.throws(() => attributionProfile.validate!(example.request, duplicateFindingId, audit), /finding_id.*唯一/);

  const subjective = structuredClone(example.request);
  subjective.input.ground_truth.available = false;
  const nulled = {
    ...example.result,
    has_standard_answer: false,
    is_correct: null,
    correctness_reason: "",
    correctness_evidence: [],
  };
  attributionProfile.validate!(subjective, nulled, audit);
  assert.throws(() => attributionProfile.validate!(subjective, example.result, audit), /无标准答案/);

  const wrongScope = structuredClone(example.result);
  wrongScope.correctness_evidence = [{ message_index: 0, quote: "计算2+2" }];
  assert.throws(() => attributionProfile.validate!(example.request, wrongScope, audit), /只能引用最终回答/);

  const incomplete = structuredClone(example.result) as unknown as {
    findings: { type: string; problem: Record<string, unknown> | null }[];
  };
  incomplete.findings[0]!.type = "problem";
  incomplete.findings[0]!.problem = { component: ["模型自身推理"], label: "问题" };
  assert.throws(
    () => attributionProfile.validate!(example.request, incomplete, audit),
    /required|输出结构无效/,
  );

  const blankLabel = structuredClone(example.result) as unknown as AttributionResult;
  blankLabel.findings[0]!.type = "problem";
  blankLabel.findings[0]!.problem = { component: ["模型自身推理"], label: "  ", definition: "说明" };
  assert.throws(() => attributionProfile.validate!(example.request, blankLabel, audit), /问题名称不能为空/);
});

test("problem components must name a tool from the answer call chain", () => {
  const request = structuredClone(example.request);
  (request.input.answer as { catalog: { message_index: number; name: string; type: string; role?: string }[] }).catalog = [
    { message_index: 1, name: "Search", type: "function_call_output" },
    { message_index: 2, name: "FinQuery", type: "function_call_output" },
    { message_index: 3, name: "NotATool", type: "message", role: "assistant" },
  ];
  request.sources.answer.value.messages.splice(1, 0,
    { type: "function_call_output", role: "tool", content: "检索超时" },
    { type: "function_call_output", role: "tool", content: "查询失败" },
  );
  request.input.answer.final_message_index = 3;
  const finding = (component: string) => ({
    ...example.result,
    correctness_evidence: [{ message_index: 3, quote: "2+2=4" }],
    findings: [
      {
        ...example.result.findings[0],
        type: "problem",
        problem: { component: [component], label: "取数失败", definition: "多次查询失败" },
        evidence: component === "FinQuery"
          ? [{ message_index: 2, quote: "查询失败" }]
          : [{ message_index: 1, quote: "检索超时" }],
      },
    ],
  });
  attributionProfile.validate!(request, finding("Search"), audit);
  const multiple = finding("Search");
  multiple.findings[0]!.problem.component = ["Search", "FinQuery", "模型自身推理"];
  assert.throws(() => attributionProfile.validate!(request, multiple, audit), /必须引用该工具/);
  multiple.findings[0]!.evidence.push({ message_index: 2, quote: "查询失败" });
  attributionProfile.validate!(request, multiple, audit);
  multiple.findings[0]!.problem.component = [];
  attributionProfile.validate!(request, multiple, audit);
  for (const components of [["Search", "Search"]]) {
    multiple.findings[0]!.problem.component = components;
    assert.throws(() => attributionProfile.validate!(request, multiple, audit), /输出结构无效/);
  }
  const unsupported = finding("FinQuery");
  unsupported.findings[0]!.evidence = [{ message_index: 3, quote: "2+2=4" }];
  assert.throws(() => attributionProfile.validate!(request, unsupported, audit), /必须引用该工具/);
  unsupported.findings[0]!.evidence = [{ message_index: 1, quote: "检索超时" }];
  assert.throws(() => attributionProfile.validate!(request, unsupported, audit), /必须引用该工具/);
  const suspected = finding("FinQuery") as AttributionResult;
  suspected.findings[0]!.assessment.evidence_status = "uncertain";
  suspected.findings[0]!.assessment.requirement_index = null;
  suspected.task_analysis.scoring_points = [];
  suspected.task_analysis.red_flags = [];
  attributionProfile.validate!(request, suspected, audit);
  attributionProfile.validate!(request, { ...suspected, findings: [] }, audit);
  assert.throws(() => attributionProfile.validate!(request, finding("search"), audit), /调用链中的工具名/);
  attributionProfile.validate!(request, finding("模型自身推理"), audit);
  for (const component of ["Context Recall", "上下文召回", "检索阶段", "WebSearch", "NotATool"])
    assert.throws(
      () => attributionProfile.validate!(request, finding(component), audit),
      /调用链中的工具名/,
      component,
    );
});
