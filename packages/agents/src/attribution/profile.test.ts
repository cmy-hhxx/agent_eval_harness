import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { evidenceId } from "@eval/tools";
import { ValidationError, type TaskAnalysis, type ToolAudit } from "@eval/contracts";

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
test("numeric ledger verifies rounded values against final-answer evidence", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "2023年9.4";
  request.sources.answer.value.messages[1]!.content = "2023年9.36";
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [{ message_index: 1, quote: "2023年9.36" }];
  result.criterion_assessments.forEach((assessment) => { assessment.evidence = result.correctness_evidence; });
  result.findings = [];
  result.numeric_checks = [{ label: "2023", expected: "9.4", actual: "9.36", scale: "1", mode: "rounded", matches: false,
    evidence_index: 0 }];
  assert.throws(() => attributionProfile.validate!(request, result, audit), /matches 应为 true/);
  result.numeric_checks[0]!.matches = true;
  attributionProfile.validate!(request, result, audit);
  result.numeric_checks[0]!.actual = "19.36";
  assert.throws(() => attributionProfile.validate!(request, result, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues?.find((issue) => issue.code === "numeric_answer_missing")?.actual,
      { number: "19.36", quote: "2023年9.36" });
    return true;
  });
  result.numeric_checks[0]!.actual = "9.36";
  result.numeric_checks[0]!.expected = "9.5";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /来自标准答案/);
  result.numeric_checks[0]!.scale = "0";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /比例必须大于零/);
  result.numeric_checks[0] = { label: "2023", expected: "9.4", actual: null, scale: "1", mode: "rounded", matches: false, evidence_index: 0 };
  result.is_correct = false;
  attributionProfile.validate!(request, result, audit);

  request.input.ground_truth.value = "1.13018E+12元";
  request.sources.answer.value.messages[1]!.content = "非流动资产1130181000000元";
  result.correctness_evidence = [{ message_index: 1, quote: "非流动资产1130181000000元" }];
  result.criterion_assessments.forEach((assessment) => { assessment.evidence = result.correctness_evidence; });
  result.is_correct = true;
  result.numeric_checks[0] = { label: "非流动资产", expected: "1.13018E+12", actual: "1130181000000", scale: "1", mode: "rounded", matches: true, evidence_index: 0 };
  attributionProfile.validate!(request, result, audit);
  result.numeric_checks[0].expected = "1130180000000";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /保留原有小数位和科学计数法指数/);
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
  const { has_standard_answer: _derived, task_analysis: _shared, ...submission } = example.result;
  const draft = {
    ...submission,
    correctness_evidence: [{ evidence_id: evidenceId(1, "text", "/content", 0, 5) }],
    criterion_assessments: example.result.criterion_assessments.map((assessment) => ({
      ...assessment, evidence: [{ evidence_id: evidenceId(1, "text", "/content", 0, 5) }],
    })),
    findings: example.result.findings.map((finding) => ({
      ...finding,
      finding_id: "f1",
      evidence: [{ evidence_id: evidenceId(1, "text", "/content", 0, 5) }],
    })),
  };
  assert.deepEqual(attributionProfile.resolve!(example.request, draft, audit), example.result);
  assert.throws(() => attributionProfile.resolve!(example.request, { ...draft, task_analysis: example.result.task_analysis }, audit), /输出结构无效/);

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
    criterion_assessments: example.result.criterion_assessments.map((assessment) => ({
      ...assessment, evidence: [{ message_index: 3, quote: "2+2=4" }],
    })),
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

test("shared criteria are immutable and assessed exactly once", () => {
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis.requirements[0]!.text = "按回答另设标准";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /镜像请求中的共享判据/);
  result.task_analysis = structuredClone(example.request.input.task_analysis);
  result.criterion_assessments.pop();
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /全部覆盖/);
  result.criterion_assessments = structuredClone(example.result.criterion_assessments) as AttributionResult["criterion_assessments"];
  result.criterion_assessments.push(result.criterion_assessments[0]!);
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /只能评审一次/);
  result.criterion_assessments.pop();
  result.criterion_assessments[0]!.criterion_id = "r99";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /必须引用共享判据/);
});

test("candidate-specific requirements retain scope in assessments and findings", () => {
  const request = structuredClone(example.request);
  const result = structuredClone(example.result) as AttributionResult;
  (request.input.task_analysis.requirements as TaskAnalysis["requirements"]).push({
    id: "r2", text: "另一候选的指定格式", applies_to: ["22222222-2222-4222-8222-222222222222"], acceptance_rule: "另一候选须用JSON交付。",
  });
  result.task_analysis = structuredClone(request.input.task_analysis);
  result.criterion_assessments.push({ criterion_id: "r2", status: "not_applicable", evidence_status: "established", summary: "本候选不在该条scope中。", evidence: [] });
  attributionProfile.validate!(request, result, audit);
  result.criterion_assessments[3]!.status = "met";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
  result.criterion_assessments[3]!.status = "not_applicable";
  result.findings[0]!.assessment.requirement_index = 1;
  assert.throws(() => attributionProfile.validate!(request, result, audit), /不能关联不适用/);
  result.findings[0]!.assessment.requirement_index = 0;
  result.criterion_assessments[0]!.status = "not_applicable";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
});

test("core failure requires an established applicable requirement and partial can remain usable", () => {
  const result = structuredClone(example.result) as AttributionResult;
  result.criterion_assessments[0]!.status = "partial";
  attributionProfile.validate!(example.request, result, audit);
  result.core_assessment.meets_core = false;
  result.core_assessment.reason = "缺失部分使唯一所求结果不能使用。";
  attributionProfile.validate!(example.request, result, audit);
  result.criterion_assessments[0]!.evidence_status = "uncertain";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /核心不可用必须引用/);
  result.core_assessment.meets_core = null;
  attributionProfile.validate!(example.request, result, audit);
  result.criterion_assessments[0]!.status = "unknown";
  result.criterion_assessments[0]!.evidence_status = "established";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /unknown 表示证据不足/);
  result.criterion_assessments[0]!.evidence_status = "uncertain";
  attributionProfile.validate!(example.request, result, audit);
  result.core_assessment.meets_core = true;
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /核心可用必须引用/);
  result.core_assessment.meets_core = false;
  result.core_assessment.criterion_ids = ["s1"];
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /只能引用.*requirements/);
  result.core_assessment.criterion_ids = ["r1"];
  result.criterion_assessments[0]!.status = "unmet";
  result.criterion_assessments[0]!.evidence_status = "established";
  result.criterion_assessments[0]!.evidence = [];
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /必须引用支持判断的原文/);
});

test("all deferred final text must be read with exact candidate, path and character coverage", () => {
  const request = structuredClone(example.request);
  (request.input.answer.deferred_final_material as { message_index: number; path: string; total_chars: number }[])
    .push({ message_index: 1, path: "/content", total_chars: 5 });
  const read = (start: number, end: number) => ({ candidate: "answer", message_index: 1, kind: "text" as const, path: "/content", start, end });
  const partial: ToolAudit = { ...audit, traceReads: [read(0, 2), read(3, 5)] };
  assert.throws(() => attributionProfile.validate!(request, example.result, partial), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues?.find((item) => item.code === "deferred_final_material_not_read");
    assert.deepEqual(issue?.actual, [{ start: 2, end: 3 }]);
    assert.match(issue?.message ?? "", /展示缺失不能推定没有交付/);
    return true;
  });
  attributionProfile.validate!(request, example.result, { ...audit, traceReads: [read(3, 5), read(0, 3)] });
  for (const wrong of [
    { ...read(0, 5), candidate: "other" },
    { ...read(0, 5), path: "/content/text" },
    { ...read(0, 5), message_index: 0 },
    { ...read(0, 5), kind: "json" as const, path: "" },
  ]) assert.throws(() => attributionProfile.validate!(request, example.result, { ...audit, traceReads: [wrong] }), /未完整读取/);
});
