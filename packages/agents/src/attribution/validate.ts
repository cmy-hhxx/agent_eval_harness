import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { validateTraceEvidence } from "@eval/tools";
import type { AttributionResult } from "./types.js";
import schema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };

interface Input {
  ground_truth: { available: boolean; value: unknown };
  answer: {
    final_message_index: number;
    catalog: { type: string; role?: string; name?: string | null }[];
  };
}

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const value = result as AttributionResult;
  const repairErrors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    repairErrors.push({ category: "decision", code, path, message, actual, expected });

  if (value.has_standard_answer !== input.ground_truth.available)
    issue(
      "standard_answer_mismatch",
      "/has_standard_answer",
      "has_standard_answer 必须与本题是否有标准答案一致",
      value.has_standard_answer,
      input.ground_truth.available,
    );
  if (input.ground_truth.available) {
    if (typeof value.is_correct !== "boolean")
      issue("correctness_required", "/is_correct", "有标准答案时必须判定 is_correct", value.is_correct);
    if (!value.correctness_reason)
      issue("correctness_reason_required", "/correctness_reason", "有标准答案时必须给出核对理由");
    if (!value.correctness_evidence.length)
      issue("correctness_evidence_required", "/correctness_evidence", "有标准答案时必须给出最终回答证据");
  } else {
    if (value.is_correct !== null)
      issue("correctness_forbidden", "/is_correct", "无标准答案时 is_correct 必须为 null", value.is_correct);
    if (value.correctness_reason)
      issue("correctness_reason_forbidden", "/correctness_reason", "无标准答案时 correctness_reason 必须为空");
    if (value.correctness_evidence.length)
      issue("correctness_evidence_forbidden", "/correctness_evidence", "无标准答案时不得给出对错证据");
  }

  const toolMessages = new Set(["function_call", "function_call_output", "tool_call", "tool_result"]);
  const tools = new Set(input.answer.catalog.flatMap((message) =>
    message.name && (toolMessages.has(message.type) || message.role === "tool") ? [message.name] : [],
  ));
  const toolNames = [...tools];
  const findingIds = new Set<string>();
  value.findings.forEach((finding, index) => {
    if (findingIds.has(finding.finding_id))
      issue(
        "finding_id_duplicate",
        `/findings/${index}/finding_id`,
        "每个 finding_id 必须在本条回答内唯一",
        finding.finding_id,
      );
    findingIds.add(finding.finding_id);
    if (finding.assessment.requirement_index !== null &&
      finding.assessment.requirement_index >= value.task_analysis.requirements.length)
      issue(
        "requirement_index_invalid",
        `/findings/${index}/assessment/requirement_index`,
        "发现关联了不存在的任务要求",
        finding.assessment.requirement_index,
        value.task_analysis.requirements.length,
      );
    if (finding.type === "strength" && finding.problem !== null)
      issue(
        "strength_problem_forbidden",
        `/findings/${index}/problem`,
        "优势的 problem 必须为 null",
        finding.problem,
      );
    if (finding.type === "problem" && finding.problem === null)
      issue("problem_required", `/findings/${index}/problem`, "问题型发现必须描述问题");
    if (finding.problem && !finding.problem.label.trim())
      issue("problem_label_empty", `/findings/${index}/problem/label`, "问题名称不能为空");
    if (finding.problem && !finding.problem.definition.trim())
      issue("problem_definition_empty", `/findings/${index}/problem/definition`, "问题定义不能为空");
    if (
      finding.type === "problem" &&
      finding.problem &&
      finding.problem.component !== "模型自身推理" &&
      !tools.has(finding.problem.component)
    )
      issue(
        "problem_component_not_tool",
        `/findings/${index}/problem/component`,
        "problem.component 必须是该回答调用链中的工具名，或「模型自身推理」；不要用阶段/能力名",
        finding.problem.component,
        toolNames.join(", ") || "模型自身推理",
      );
  });

  const candidate = input.answer;
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  repairErrors.push(
    ...validateTraceEvidence(
      raw,
      value.correctness_evidence.map((item, i) => ({ item, location: `correctness_evidence[${i}]` })),
      "answer",
      audit,
      candidate.final_message_index,
    ),
  );
  value.findings.forEach((finding, i) =>
    repairErrors.push(
      ...validateTraceEvidence(
        raw,
        finding.evidence.map((item, j) => ({ item, location: `findings[${i}].evidence[${j}]` })),
        "answer",
        audit,
        undefined,
      ),
    ),
  );
  if (repairErrors.length) throw new ValidationError(repairErrors);
}
