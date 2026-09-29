import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { images, validateTraceEvidence } from "@eval/tools";
import type { AttributionResult } from "./types.js";
import { containsNumber, matchesReference } from "./numeric.js";
import schema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };

interface Input {
  ground_truth: { available: boolean; value: unknown };
  answer: {
    final_message_index: number;
    catalog: { message_index: number; type: string; role?: string; name?: string | null }[];
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
  if (!input.ground_truth.available && value.numeric_checks.length)
    issue("numeric_checks_without_reference", "/numeric_checks", "没有标准答案时数值核对表必须为空");
  for (const [index, check] of value.numeric_checks.entries()) {
    const location = `/numeric_checks/${index}`;
    let matches: boolean;
    try { matches = check.actual !== null && matchesReference(check.actual, check.expected, check.scale, check.mode); }
    catch (error) {
      issue("numeric_invalid", location, (error as Error).message);
      continue;
    }
    if (check.matches !== matches)
      issue("numeric_rounding_mismatch", `${location}/matches`,
        `${check.label}：${check.actual} × ${check.scale} 与标准值 ${check.expected} 按 ${check.mode} 核验，matches 应为 ${matches}；同步修正理由和 findings，不能把精度等价写成错误。`, check.matches, matches);
    if (!containsNumber(JSON.stringify(input.ground_truth.value), check.expected, true))
      issue("numeric_reference_missing", `${location}/expected`, "expected 必须来自标准答案，保留原有小数位和科学计数法指数；例如1.13018E+12须原样填写，不能展开为整数、换算标准或编造容差。自算值不能放expected；分数或复合单位请在correctness_reason说明推导并移除此数值表项");
    const evidence = value.correctness_evidence[check.evidence_index];
    if (!evidence || (check.actual !== null && !containsNumber(evidence.quote, check.actual)))
      issue("numeric_answer_missing", `${location}/evidence_index`,
        `${check.label} 的原始数值 ${check.actual} 未出现在 correctness_evidence[${check.evidence_index}]；` +
        `选最终消息 ${input.answer.final_message_index} 的原文加入 correctness_evidence，并填写其零起始 evidence_index。` +
        `有值时用 search_trace(candidate="answer", query="${check.actual}") 定位。actual 必须照抄原文数值及正负号，不能先换算；例如原文2900万、标准以元计，则actual="2900"、scale="10000"，不能填29000000。未提供值用 actual=null、matches=false，不能补0或自己拼证据ID。复合单位、数名单或图表解码得到的派生值请在correctness_reason保留证据和计算过程，并移除此数值表项；不要把派生值伪装成原文字面值。请逐字核对 actual.quote 返回的真实原文，observation 中自行声称出现的数值不是原文证据。`,
        { number: check.actual, quote: evidence?.quote ?? null });
    if (value.is_correct === true && !matches)
      issue("numeric_correctness_contradiction", "/is_correct", "存在未通过的标准数值核对，不能判全部正确；先核查数值、单位、口径是否选对");
  }
  const tools = new Set(input.answer.catalog.flatMap((message) =>
    message.name && (toolMessages.has(message.type) || message.role === "tool") ? [message.name] : [],
  ));
  const toolNames = [...tools];
  const toolLocations = new Map(input.answer.catalog
    .filter((message) => message.name && (toolMessages.has(message.type) || message.role === "tool"))
    .map((message) => [message.message_index, message.name]));
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
    if (finding.problem?.component.length &&
      /(?:不能|无法|未能)[^。；\n]{0,15}(?:确定|确认|定位|查明)[^。；\n]{0,60}(?:具体根因|根本原因|责任归属)|(?:根因|责任归属)(?:仍|尚|还)?(?:不明|未知|待查|待定位)/u.test(finding.problem.definition))
      issue("unresolved_component", `/findings/${index}/problem/component`,
        "定义仍称根因或责任待定位，不能同时列责任组件；没有独立错误证据就填 []。如已有证据证明某组件独立失误，应明确该失误并将未知部分与已知责任分开描述。");
    for (const [componentIndex, component] of (finding.problem?.component ?? []).entries()) {
      if (component !== "模型自身推理" && !tools.has(component))
        issue(
          "problem_component_not_tool",
          `/findings/${index}/problem/component/${componentIndex}`,
          "problem.component 每项必须是该回答调用链中的工具名，或「模型自身推理」；不要用阶段/能力名",
          component,
          toolNames.join(", ") || "模型自身推理",
        );
      if (tools.has(component) &&
        !finding.evidence.some((item) => toolLocations.get(item.message_index) === component))
        issue(
          "problem_component_evidence_missing",
          `/findings/${index}/evidence`,
          "每个工具型 component 必须引用该工具的调用或返回证据，不能仅凭最终回答或其他工具定位根因",
          component,
        );
    }
  });

  const candidate = input.answer;
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  if (images(raw.messages[candidate.final_message_index]).length &&
      !audit.viewedImages.includes(`answer:${candidate.final_message_index}`))
    issue("final_image_not_viewed", "/findings",
      `最终回答含图片，必须先 view_image(candidate="answer", message_index=${candidate.final_message_index}) 再判交付是否缺失；表格/名单可能在图片里。`);
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
