import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { evidenceId } from "@eval/tools";

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("Attribution judges one answer, conditionally on the standard answer", () => {
  assert.deepEqual(Object.keys(attributionAgent.profiles), ["default"]);
  attributionProfile.validate!(example.request, example.result, audit);
  const { has_standard_answer: _derived, ...submission } = example.result;
  const draft = {
    ...submission,
    correctness_evidence: [{ evidence_id: evidenceId("input-A", 1, "text", "/content", 0, 5) }],
    findings: example.result.findings.map((finding) => ({
      ...finding,
      finding_id: "f1",
      evidence: [{ evidence_id: evidenceId("input-A", 1, "text", "/content", 0, 5) }],
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
  incomplete.findings[0]!.problem = { component: "模型自身推理", label: "问题" };
  assert.throws(
    () => attributionProfile.validate!(example.request, incomplete, audit),
    /required|输出结构无效/,
  );

  const blankLabel = structuredClone(example.result) as unknown as AttributionResult;
  blankLabel.findings[0]!.type = "problem";
  blankLabel.findings[0]!.problem = { component: "模型自身推理", label: "  ", definition: "说明" };
  assert.throws(() => attributionProfile.validate!(example.request, blankLabel, audit), /问题名称不能为空/);
});

test("problem components must name a tool from the answer call chain", () => {
  const request = structuredClone(example.request);
  (request.input.answer as { catalog: { name: string; type: string; role?: string }[] }).catalog = [
    { name: "Search", type: "function_call" },
    { name: "FinQuery", type: "function_call_output" },
    { name: "NotATool", type: "message", role: "assistant" },
  ];
  const finding = (component: string) => ({
    ...example.result,
    findings: [
      {
        ...example.result.findings[0],
        type: "problem",
        problem: { component, label: "取数失败", definition: "多次查询失败" },
      },
    ],
  });
  attributionProfile.validate!(request, finding("Search"), audit);
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
