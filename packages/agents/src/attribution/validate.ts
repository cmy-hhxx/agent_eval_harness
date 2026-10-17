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
import { images, traceReadCoverage } from "@eval/tools";
import type { AttributionResult } from "./types.js";
import { attributionTableReview } from "./table-review.js";
import schema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };
import { instructionEvidenceIssues, instructionSubmissionIssues } from "./instructions.js";
import { submissionEvidenceIssues } from "./submission-evidence.js";
import { correctnessEvidenceScopeIssues, foreignActualIssues, referenceMaterialIssues, validateAttributionEvidence } from "./source-evidence.js";
import { numericLedgerIssues } from "./numeric-ledger.js";
import { normDirectoryIssues, findingNormSelectionIssues, attributionNormDirectory, submissionFindingEntries } from "./norm-directory.js";
import { responsibilityChoices, responsibilityIssues } from "./responsibility.js";

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
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const statuses = ["met", "partial", "unmet", "unknown", "not_applicable"];

/** Final-image coverage depends only on trusted source material and this attempt's audit. */
function finalImageReadIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as Input;
  const index = input.answer.final_message_index;
  const raw = request.sources.answer.value as { messages: unknown[] };
  return images(raw.messages[index]).length && !audit.viewedImages.includes(`answer:${index}`)
    ? [{ category: "decision", code: "final_image_not_viewed", path: "/findings",
      message: `最终回答含图片，必须先 view_image(candidate="answer", message_index=${index}) 再判交付是否缺失；表格/名单可能在图片里。` }]
    : [];
}

/** Business rules that can be checked before evidence references are resolved. */
export function validateJudgment(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[] {
  return [...normDirectoryIssues(request), ...findingNormSelectionIssues(request, draft, audit), ...referenceMaterialIssues(request), ...finalImageReadIssues(request, audit), ...validateIndependentRules(request, draft, "submission"), ...numericSubmissionIssues(draft), ...numericLedgerIssues(request, draft, "submission", audit), ...submissionEvidenceIssues(request, draft, audit),
    ...instructionSubmissionIssues(request, draft, audit)];
}

/** Native actuals may use JSON numbers; uncertain precision still requires an exact string. */
function numericSubmissionIssues(draft: unknown): ValidationIssue[] {
  const checks = object(draft)?.numeric_checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check, index) => {
    const actual = object(check)?.actual;
    if (typeof actual !== "number" || Number.isFinite(actual) && (!Number.isInteger(actual) || Number.isSafeInteger(actual))) return [];
    return [{ category: "structure", code: "numeric_actual_unsafe", path: `/numeric_checks/${index}/actual`,
      message: "actual 的 JSON number 必须有限，整数须在安全整数范围内；大整数请保留最终回答中的原十进制字符串，不能提交已失去精度的数值。",
      actual, expected: { finite_number: true, safe_integer: true } } as ValidationIssue];
  });
}

/** Presence and ownership are determined by the trusted standard-answer flag. */
function correctnessSubmissionIssues(request: AgentRequest, draft: unknown): ValidationIssue[] {
  const value = object(draft);
  if (!value) return [];
  const available = (request.input.ground_truth as unknown as Input["ground_truth"]).available;
  return ["is_correct", "correctness_reason", "correctness_evidence"].flatMap((field) => {
    const present = Object.hasOwn(value, field);
    if (present === available) return [];
    const code = field === "is_correct" ? "correctness" : field;
    return [{ category: "decision" as const, code: `${code}_${available ? "required" : "forbidden"}`,
      path: `/${field}`, actual: value[field],
      expected: available ? { required_field: field } : { remove_fields: [field] },
      message: available
        ? `有标准答案时必须提交 ${field}，按实际核对结果填写。`
        : `无标准答案时请删除 ${field} 字段，不提交 null、空文本或空数组占位。`,
    }];
  });
}

/** The model selects original requirement positions; persisted IDs remain program-owned. */
export function submissionCoreRequirements(request: AgentRequest, draft: unknown) {
  const indices = object(object(draft)?.core_assessment)?.requirement_indices;
  const identified = Array.isArray(indices) && indices.every(index => Number.isSafeInteger(index) && index >= 0);
  const criterionIds: string[] = [], issues: ValidationIssue[] = [];
  if (!identified) return { criterionIds, issues, identified };
  const input = request.input as unknown as Input;
  const requirements = input.task_analysis.requirements;
  const applicable = (criterion: TaskAnalysis["requirements"][number]) =>
    !criterion.applies_to.length || criterion.applies_to.includes(input.candidate_id);
  const expected = requirements.flatMap((criterion, index) => !criterion.applies_to.length ? [index] : []);
  indices.forEach((selection, index) => {
    const criterion = requirements[selection];
    if (!criterion || !applicable(criterion)) issues.push({ category: "decision",
      code: criterion ? "core_requirement_not_applicable" : "core_requirement_index_invalid",
      path: `/core_assessment/requirement_indices/${index}`, actual: selection, expected,
      message: "核心依据只选择本方适用 requirements 的原全局零起始 requirement_index；从 expected 选择，不按过滤后位置编号，也不选择 scoring_points、red_flags 或 finding。" });
    else if (criterion.applies_to.length) issues.push({ category: "decision", code: "core_requirement_private",
      path: `/core_assessment/requirement_indices/${index}`, actual: selection, expected,
      message: "本方专有要求只影响本方合规评审，不能决定共同核心可用性；保留该条逐项结论与真实问题，用共同任务结果及其必要限制判断核心。" });
    else criterionIds.push(criterion.id);
  });
  return { criterionIds, issues, identified };
}

/** The submitted assessments cover applicable criteria; resolved assessments cover the complete rubric. */
function validateCriterionAssessments(request: AgentRequest, draft: unknown, representation: "submission" | "result") {
  const value = object(draft);
  const assessmentMap = new Map<string, Record<string, unknown>>();
  if (!value) return { issues: [] as ValidationIssue[], assessmentMap, identifiedAssessments: false };
  const input = request.input as unknown as Input;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    errors.push({ category: "decision", code, path, message, actual, expected });
  const applicable = (criterion: TaskAnalysis["requirements"][number]) =>
    !criterion.applies_to.length || criterion.applies_to.includes(input.candidate_id);
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const criterionMap = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const assessments = Array.isArray(value.criterion_assessments) ? value.criterion_assessments : undefined;
  const identifiedAssessments = assessments?.every((assessment) => typeof object(assessment)?.criterion_id === "string");
  const assessmentIds = new Set<string>();
  assessments?.forEach((entry, index) => {
    const assessment = object(entry);
    if (!assessment || typeof assessment.criterion_id !== "string") return;
    const location = `/criterion_assessments/${index}`;
    const criterion = criterionMap.get(assessment.criterion_id);
    if (assessmentIds.has(assessment.criterion_id))
      issue("criterion_assessment_duplicate", `${location}/criterion_id`, "每条共享判据必须且只能评审一次", assessment.criterion_id);
    assessmentIds.add(assessment.criterion_id);
    assessmentMap.set(assessment.criterion_id, assessment);
    if (!criterion) {
      issue("criterion_assessment_unknown", `${location}/criterion_id`, "criterion_id 必须引用共享判据", assessment.criterion_id);
      return;
    }
    if (representation === "submission" && !applicable(criterion))
      issue("criterion_out_of_scope", `${location}/criterion_id`,
        "只提交当前候选适用的判据；本条不适用，请删除完整评审，不填写 not_applicable 或占位证据。",
        assessment.criterion_id, { candidate_id: input.candidate_id, applies_to: [...criterion.applies_to], target_path: location });
    if (representation === "result" && typeof assessment.status === "string" && statuses.includes(assessment.status) &&
      (assessment.status === "not_applicable") !== !applicable(criterion))
      issue("criterion_applicability_mismatch", `${location}/status`, "只有 applies_to 不包含当前候选时才能且必须填 not_applicable；[] 适用于全部候选", assessment.status, applicable(criterion));
    if (assessment.status === "unknown" && assessment.evidence_status === "established")
      issue("criterion_unknown_established", `${location}/evidence_status`, "unknown 表示证据不足，evidence_status 必须为 uncertain");
    if (representation === "result" && assessment.status === "not_applicable" && assessment.evidence_status !== "established")
      issue("criterion_scope_uncertain", `${location}/evidence_status`, "正式不适用结果由可信 applies_to 确定，evidence_status 必须为 established");
    if (Array.isArray(assessment.evidence)) {
      if (representation === "result" && assessment.status === "not_applicable" && assessment.evidence.length)
        issue("criterion_not_applicable_evidence", `${location}/evidence`, "不适用由共享 scope 确定，不填写回答证据");
      if (typeof assessment.status === "string" && ["met", "partial", "unmet"].includes(assessment.status) &&
        assessment.evidence_status === "established" && !assessment.evidence.length)
        issue("criterion_evidence_required", `${location}/evidence`, "已确认的适用判据结论必须引用支持判断的原文或已查看图片");
    }
    if (typeof assessment.summary === "string" && !assessment.summary.trim())
      issue("criterion_summary_empty", `${location}/summary`, "逐项评审说明不能为空");
  });
  if (identifiedAssessments) for (const criterion of criteria) if ((representation === "result" || applicable(criterion)) && !assessmentIds.has(criterion.id)) {
    issue("criterion_assessment_missing", "/criterion_assessments",
      `共享判据 ${criterion.id} 缺少评审；${representation === "submission" ? "程序绑定的适用检查项须完整" : "正式结果必须覆盖全部判据"}。`,
      criterion.id, { criterion: structuredClone(criterion), applicable: applicable(criterion) });
  }
  return { issues: errors, assessmentMap, identifiedAssessments };
}

function validateIndependentRules(request: AgentRequest, draft: unknown, representation: "submission" | "result"): ValidationIssue[] {
  const value = object(draft);
  if (!value) return [];
  const input = request.input as unknown as Input;
  const { issues: errors, assessmentMap, identifiedAssessments } = validateCriterionAssessments(request, draft, representation);
  if (representation === "submission") errors.push(...correctnessSubmissionIssues(request, draft));
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    errors.push({ category: "decision", code, path, message, actual, expected });
  const applicable = (criterion: TaskAnalysis["requirements"][number]) =>
    !criterion.applies_to.length || criterion.applies_to.includes(input.candidate_id);

  const core = object(value.core_assessment);
  const coreEvidence: Record<string, unknown>[] = [];
  let evidenceStatesValid = false;
  const selection = representation === "submission" ? submissionCoreRequirements(request, draft) : undefined;
  if (selection) errors.push(...selection.issues);
  const criterionIds = selection ? selection.identified ? selection.criterionIds : undefined
    : strings(core?.criterion_ids) ? core.criterion_ids : undefined;
  if (core && criterionIds) {
    const requirements = new Map(input.task_analysis.requirements.map((criterion) => [criterion.id, criterion]));
    criterionIds.forEach((id, index) => {
      const criterion = requirements.get(id);
      if (!criterion || !applicable(criterion))
        issue("core_criterion_invalid", `/core_assessment/criterion_ids/${index}`, "核心可用性只能引用适用于当前候选的 requirements；从 expected 列出的 ID 选择，不能引用 scoring_points、red_flags 或 finding_id", id,
          input.task_analysis.requirements.filter(applicable).map((item) => item.id));
      else if (criterion.applies_to.length)
        issue("core_criterion_private", `/core_assessment/criterion_ids/${index}`,
          "专有要求不得作为共同核心依据；本方合规结论保留在逐项评审与 finding。", id,
          input.task_analysis.requirements.filter(item => !item.applies_to.length).map(item => item.id));
      else {
        const assessment = assessmentMap.get(id);
        if (assessment) coreEvidence.push(assessment);
      }
    });
    evidenceStatesValid = !!identifiedAssessments && !selection?.issues.length && criterionIds.every((id) => {
      const criterion = requirements.get(id);
      return !!criterion && !criterion.applies_to.length && assessmentMap.has(id);
    }) && coreEvidence.every((assessment) =>
      typeof assessment.status === "string" && statuses.includes(assessment.status) &&
      (assessment.evidence_status === "established" || assessment.evidence_status === "uncertain"));
    if (evidenceStatesValid) {
      if (core.meets_core === true && coreEvidence.some(assessment =>
        assessment.evidence_status === "established" && assessment.status === "unmet"))
        issue("core_success_unmet", "/core_assessment/meets_core",
          "已选为核心依据的要求存在已确认 unmet，不能同时声明核心完成。按原要求核对交付与必要限制；保留真实缺口，不靠删掉核心依据或降低确定性消除矛盾。局部仍有用途可记录 strength。",
          core.meets_core, { unmet_requirements: input.task_analysis.requirements.flatMap((criterion, requirement_index) =>
            criterionIds.includes(criterion.id) && assessmentMap.get(criterion.id)?.status === "unmet" &&
            assessmentMap.get(criterion.id)?.evidence_status === "established" ? [{ requirement_index, text: criterion.text }] : []) });
      if (core.meets_core === false && !coreEvidence.some((assessment) =>
        assessment.evidence_status === "established" && (assessment.status === "unmet" || assessment.status === "partial")))
        issue("core_failure_unsupported", "/core_assessment", "判核心不可用必须引用适用 requirement 已确认的 unmet 或 partial，不能由疑似问题、加分项或风险标签推定");
      if (core.meets_core === null && !coreEvidence.some((assessment) =>
        assessment.status === "unknown" || assessment.evidence_status === "uncertain"))
        issue("core_unknown_unsupported", "/core_assessment", "核心可用性为 null 时必须引用证据不足的适用 requirement");
      if (core.meets_core === true && !coreEvidence.some((assessment) =>
        assessment.evidence_status === "established" && (assessment.status === "met" || assessment.status === "partial")))
        issue("core_success_unsupported", "/core_assessment", "判核心可用必须引用适用 requirement 已确认的 met 或 partial，并说明仍可用的独立结果");
    }
  }
  if (typeof core?.reason === "string" && !core.reason.trim())
    issue("core_reason_empty", "/core_assessment/reason", "必须说明核心结果的独立用途、缺口和影响");
  const correctnessPendingReview = input.ground_truth.available && value.is_correct === null &&
    core?.meets_core === null && coreEvidence.some((assessment) =>
      assessment.status === "unknown" || assessment.evidence_status === "uncertain");
  if (input.ground_truth.available) {
    if (value.is_correct === null && !correctnessPendingReview && evidenceStatesValid &&
      (core?.meets_core === null || typeof core?.meets_core === "boolean"))
      issue("correctness_required", "/is_correct", "有标准答案时须判定is_correct；无法核实时仅可保留null，并同时将核心状态设为null、引用unknown/uncertain的适用requirement以请求独立复核。", value.is_correct);
    if (typeof value.correctness_reason === "string" && !value.correctness_reason.trim())
      issue("correctness_reason_required", "/correctness_reason", "有标准答案时必须给出核对理由");
    if (Array.isArray(value.correctness_evidence) && !value.correctness_evidence.length)
      issue("correctness_evidence_required", "/correctness_evidence", "有标准答案时必须给出最终回答证据");
  } else {
    if (representation === "result" && typeof value.is_correct === "boolean")
      issue("correctness_forbidden", "/is_correct", "无标准答案时 is_correct 必须为 null", value.is_correct);
    if (representation === "result" && typeof value.correctness_reason === "string" && value.correctness_reason)
      issue("correctness_reason_forbidden", "/correctness_reason", "无标准答案时 correctness_reason 必须为空");
    if (representation === "result" && Array.isArray(value.correctness_evidence) && value.correctness_evidence.length)
      issue("correctness_evidence_forbidden", "/correctness_evidence", "无标准答案时不得给出对错证据");
    if (Array.isArray(value.numeric_checks) && value.numeric_checks.length)
      issue("numeric_checks_without_reference", "/numeric_checks", "没有标准答案时数值核对表必须为空");
  }

  const components = new Set(responsibilityChoices(request));
  const findingIds = new Set<string>();
  const findingEntries = representation === "submission" ? submissionFindingEntries(draft)
    : Array.isArray(value.findings) ? value.findings.map((finding, index) => ({ finding, path: `/findings/${index}` })) : [];
  findingEntries.forEach(({ finding: entry, path: location }, index) => {
    const finding = object(entry);
    if (!finding) return;
    if (representation === "result" && typeof finding.finding_id === "string") {
      if (findingIds.has(finding.finding_id))
        issue("finding_id_duplicate", `${location}/finding_id`, "每个 finding_id 必须在本条回答内唯一", finding.finding_id);
      findingIds.add(finding.finding_id);
    }
    const originalAssessment = object(finding.assessment);
    const assessment = representation === "submission" && Object.hasOwn(finding,"norm_index")
      ? { ...originalAssessment, requirement_index: Number.isSafeInteger(finding.norm_index) && Number(finding.norm_index) >= 0
        ? attributionNormDirectory(request)[Number(finding.norm_index)]?.requirement_index : null } : originalAssessment;
    if (typeof assessment?.requirement_index === "number" && Number.isInteger(assessment.requirement_index) && assessment.requirement_index >= 0) {
      const requirement = input.task_analysis.requirements[assessment.requirement_index];
      if (assessment.requirement_index >= input.task_analysis.requirements.length)
        issue("requirement_index_invalid", `${location}/assessment/requirement_index`, "发现关联了不存在的任务要求", assessment.requirement_index, input.task_analysis.requirements.length);
      if (requirement && !applicable(requirement))
        issue("finding_requirement_not_applicable", `${location}/assessment/requirement_index`, "finding 不能关联不适用于当前候选的共享 requirement", assessment.requirement_index);
      const criterionAssessment = requirement && assessmentMap.get(requirement.id);
      if (finding.type === "problem" && finding.importance !== "low" && (representation === "submission" || assessment.evidence_status === "established") &&
        requirement && applicable(requirement) && criterionAssessment?.status === "met" && criterionAssessment.evidence_status === "established")
        issue("finding_requirement_conflict", `${location}/assessment/requirement_index`,
          `finding_index=${index}（零起始）${typeof finding.finding_id === "string" ? `、finding_id=${finding.finding_id}` : ""} 的 problem 关联 requirement ${requirement.id}，但同一判据声明已确认 met。请核对原要求和实际证据：已确认缺口时，将判据改为 partial 或 unmet；证据确实不足时保留 uncertain，不能同时声明已确认 met。若关联错误，instruction_following 重新选择本方 norm_directory 的 norm_index，其他维度填写正确的 requirement_index；其他维度的观察确实未入 requirements 中时填 null。没有真实问题时修正 finding；真实问题仍须保留，不能仅降低其确定性或解除真实关联来消除冲突。`,
          assessment.requirement_index, { criterion_id: requirement.id, status: criterionAssessment.status,
            evidence_status: criterionAssessment.evidence_status, finding_index: index,
            ...(typeof finding.finding_id === "string" ? { finding_id: finding.finding_id } : {}),
            criterion_status_path: `/criterion_assessments/${(value.criterion_assessments as unknown[]).findIndex(entry => entry === criterionAssessment)}/status` });
    }
    const problem = object(finding.problem);
    if (finding.type === "strength" && (representation === "submission" ? Object.hasOwn(finding, "problem") : finding.problem !== null))
      issue("strength_problem_forbidden", `${location}/problem`, representation === "submission"
        ? "本条 type=strength，请删除 problem 字段，不提交 null、空字符串或对象。"
        : "正式结果中 type=strength 的 problem 必须为 null", finding.problem);
    if (finding.type === "problem" && !problem)
      issue("problem_required", `${location}/problem`, representation === "submission"
        ? "type=problem 必须提交 problem 对象，填写 component、label、definition"
        : "type=problem 必须有包含 component、label、definition 的正式问题对象");
    if (!problem) return;
    if (typeof problem.label === "string" && !problem.label.trim())
      issue("problem_label_empty", `${location}/problem/label`, "问题名称不能为空");
    if (typeof problem.definition === "string" && !problem.definition.trim())
      issue("problem_definition_empty", `${location}/problem/definition`, "问题定义不能为空");
    if (representation === "submission" || !strings(problem.component)) return;
    problem.component.forEach((component, componentIndex) => {
      if (!components.has(component))
        issue("problem_component_invalid", `${location}/problem/component/${componentIndex}`, "正式 problem.component 必须选择本方工具名或本方材料支持的责任环节", component);
    });
  });
  return errors;
}

export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const value = result as AttributionResult;
  const repairErrors = [...referenceMaterialIssues(request), ...validateIndependentRules(request, result, "result")];
  repairErrors.push(...attributionTableReview(request, value).errors);
  repairErrors.push(...instructionEvidenceIssues(request, value), ...foreignActualIssues(request, value));
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    repairErrors.push({ category: "decision", code, path, message, actual, expected });

  if (value.standard_conflict && request.input.allow_standard_conflict !== true)
    issue("standard_conflict_disabled", "/standard_conflict", "本次未开启标准答案复核，不能提交标准冲突。", true);
  if (canonical(value.task_analysis) !== canonical(input.task_analysis))
    issue("task_analysis_mismatch", "/task_analysis", "task_analysis 必须镜像请求中的共享判据，不能按回答改写", value.task_analysis, input.task_analysis);
  if (value.has_standard_answer !== input.ground_truth.available)
    issue("standard_answer_mismatch", "/has_standard_answer", "has_standard_answer 必须与本题是否有标准答案一致", value.has_standard_answer, input.ground_truth.available);
  repairErrors.push(...numericLedgerIssues(request, value, "result"));
  value.findings.forEach((finding, index) => {
    repairErrors.push(...responsibilityIssues(request, finding.problem, finding.evidence, `/findings/${index}/problem`));
  });

  input.answer.deferred_final_material.forEach((material, index) => {
    const coverage = traceReadCoverage(audit, {
      candidate: "answer", message_index: material.message_index, kind: "text", path: material.path,
      start: 0, end: material.total_chars,
    });
    if (!coverage.covered) repairErrors.push({
      category: "evidence", code: "deferred_final_material_not_read", path: `/answer/deferred_final_material/${index}`,
      candidate: "answer", message: "未完整读取延后展示的最终材料；按缺口用 read_trace 补读并继续 next_offset。展示缺失不能推定没有交付。",
      actual: coverage.missing, expected: { message_index: material.message_index, path: material.path, start: 0, end: material.total_chars,
        read_request: { candidate: "answer", message_index: material.message_index, path: material.path,
          offset: coverage.missing[0]!.start, max_chars: 16000 } },
    });
  });
  repairErrors.push(...finalImageReadIssues(request, audit));
  repairErrors.push(...correctnessEvidenceScopeIssues(request, value.correctness_evidence, value.numeric_checks));
  repairErrors.push(
    ...validateAttributionEvidence(
      request,
      value.correctness_evidence.map((item, i) => ({ item, location: `correctness_evidence[${i}]` })),
      audit,
    ),
  );
  value.findings.forEach((finding, i) =>
    repairErrors.push(
      ...validateAttributionEvidence(
        request,
        finding.evidence.map((item, j) => ({ item, location: `findings[${i}].evidence[${j}]` })),
        audit,
        undefined,
      ),
    ),
  );
  value.criterion_assessments.forEach((assessment, i) => repairErrors.push(
    ...validateAttributionEvidence(request, assessment.evidence.map((item, j) => ({
      item, location: `criterion_assessments[${i}].evidence[${j}]`,
    })), audit),
  ));
  value.table_resolutions?.forEach((resolution, i) => repairErrors.push(
    ...validateAttributionEvidence(request, resolution.evidence.map((item, j) => ({
      item, location: `table_resolutions[${i}].evidence[${j}]`,
    })), audit),
  ));
  for (const field of ["findings", "criterion_assessments"] as const) value[field].forEach((entry, i) =>
    repairErrors.push(...validateAttributionEvidence(request, (entry.context_evidence ?? []).map((item, j) => ({
      item, location: `/${field}/${i}/context_evidence/${j}`,
    })), audit)));
  if (repairErrors.length) throw new ValidationError(repairErrors);
}
