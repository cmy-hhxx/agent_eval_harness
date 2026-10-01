import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonical,
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type TaskAnalysis,
  type ValidationIssue,
} from "@eval/contracts";
import { images, traceReadCoverage, validateTraceEvidence } from "@eval/tools";
import type { AttributionResult } from "./types.js";
import { containsNumber, matchesReference } from "./numeric.js";
import schema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };

interface Input {
  candidate_id: string;
  task_analysis: TaskAnalysis;
  ground_truth: { available: boolean; value: unknown };
  answer: {
    final_message_index: number;
    deferred_final_material: { message_index: number; path: string; total_chars: number }[];
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

  if (canonical(value.task_analysis) !== canonical(input.task_analysis))
    issue("task_analysis_mismatch", "/task_analysis", "task_analysis 必须镜像请求中的共享判据，不能按回答改写", value.task_analysis, input.task_analysis);
  const applicable = (criterion: TaskAnalysis["requirements"][number]) =>
    !criterion.applies_to.length || criterion.applies_to.includes(input.candidate_id);
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const criterionMap = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const assessmentMap = new Map(value.criterion_assessments.map((assessment) => [assessment.criterion_id, assessment]));
  const assessmentIds = new Set<string>();
  value.criterion_assessments.forEach((assessment, index) => {
    const location = `/criterion_assessments/${index}`;
    const criterion = criterionMap.get(assessment.criterion_id);
    if (assessmentIds.has(assessment.criterion_id))
      issue("criterion_assessment_duplicate", `${location}/criterion_id`, "每条共享判据必须且只能评审一次", assessment.criterion_id);
    assessmentIds.add(assessment.criterion_id);
    if (!criterion) {
      issue("criterion_assessment_unknown", `${location}/criterion_id`, "criterion_id 必须引用共享判据", assessment.criterion_id);
      return;
    }
    if ((assessment.status === "not_applicable") !== !applicable(criterion))
      issue("criterion_applicability_mismatch", `${location}/status`, "只有 applies_to 不包含当前候选时才能且必须填 not_applicable；[] 适用于全部候选", assessment.status, applicable(criterion));
    if (assessment.status === "unknown" && assessment.evidence_status !== "uncertain")
      issue("criterion_unknown_established", `${location}/evidence_status`, "unknown 表示证据不足，evidence_status 必须为 uncertain");
    if (assessment.status === "not_applicable" && assessment.evidence.length)
      issue("criterion_not_applicable_evidence", `${location}/evidence`, "不适用由共享 scope 确定，不填写回答证据");
    if (["met", "partial", "unmet"].includes(assessment.status) && assessment.evidence_status === "established" && !assessment.evidence.length)
      issue("criterion_evidence_required", `${location}/evidence`, "已确认的适用判据结论必须引用支持判断的原文或已查看图片");
    if (!assessment.summary.trim())
      issue("criterion_summary_empty", `${location}/summary`, "逐项评审说明不能为空");
  });
  for (const criterion of criteria) if (!assessmentIds.has(criterion.id))
    issue("criterion_assessment_missing", "/criterion_assessments", "共享判据必须全部覆盖，含不适用判据", criterion.id);

  const requirements = new Map(input.task_analysis.requirements.map((criterion) => [criterion.id, criterion]));
  const coreEvidence = value.core_assessment.criterion_ids.flatMap((id, index) => {
    const criterion = requirements.get(id);
    if (!criterion || !applicable(criterion)) {
      issue("core_criterion_invalid", `/core_assessment/criterion_ids/${index}`, "核心可用性只能引用适用于当前候选的 requirements", id);
      return [];
    }
    const assessment = assessmentMap.get(id);
    return assessment ? [assessment] : [];
  });
  if (!value.core_assessment.reason.trim())
    issue("core_reason_empty", "/core_assessment/reason", "必须说明核心结果的独立用途、缺口和影响");
  if (value.core_assessment.meets_core === false && !coreEvidence.some((assessment) =>
    assessment.evidence_status === "established" && ["unmet", "partial"].includes(assessment.status)))
    issue("core_failure_unsupported", "/core_assessment", "判核心不可用必须引用适用 requirement 已确认的 unmet 或 partial，不能由疑似问题、加分项或风险标签推定");
  if (value.core_assessment.meets_core === null && !coreEvidence.some((assessment) =>
    assessment.status === "unknown" || assessment.evidence_status === "uncertain"))
    issue("core_unknown_unsupported", "/core_assessment", "核心可用性为 null 时必须引用证据不足的适用 requirement");
  if (value.core_assessment.meets_core === true && !coreEvidence.some((assessment) =>
    assessment.evidence_status === "established" && ["met", "partial"].includes(assessment.status)))
    issue("core_success_unsupported", "/core_assessment", "判核心可用必须引用适用 requirement 已确认的 met 或 partial，并说明仍可用的独立结果");

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
      finding.assessment.requirement_index >= input.task_analysis.requirements.length)
      issue(
        "requirement_index_invalid",
        `/findings/${index}/assessment/requirement_index`,
        "发现关联了不存在的任务要求",
        finding.assessment.requirement_index,
        input.task_analysis.requirements.length,
      );
    const requirement = finding.assessment.requirement_index === null ? undefined :
      input.task_analysis.requirements[finding.assessment.requirement_index];
    if (requirement && !applicable(requirement))
      issue("finding_requirement_not_applicable", `/findings/${index}/assessment/requirement_index`,
        "finding 不能关联不适用于当前候选的共享 requirement", finding.assessment.requirement_index);
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
  input.answer.deferred_final_material.forEach((material, index) => {
    const coverage = traceReadCoverage(audit, {
      candidate: "answer", message_index: material.message_index, kind: "text", path: material.path,
      start: 0, end: material.total_chars,
    });
    if (!coverage.covered) repairErrors.push({
      category: "evidence", code: "deferred_final_material_not_read", path: `/answer/deferred_final_material/${index}`,
      candidate: "answer", message: "未完整读取延后展示的最终材料；按缺口用 read_trace 补读并继续 next_offset。展示缺失不能推定没有交付。",
      actual: coverage.missing, expected: { message_index: material.message_index, path: material.path, start: 0, end: material.total_chars },
    });
  });
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
  value.criterion_assessments.forEach((assessment, i) => repairErrors.push(
    ...validateTraceEvidence(raw, assessment.evidence.map((item, j) => ({
      item, location: `criterion_assessments[${i}].evidence[${j}]`,
    })), "answer", audit),
  ));
  if (repairErrors.length) throw new ValidationError(repairErrors);
}
