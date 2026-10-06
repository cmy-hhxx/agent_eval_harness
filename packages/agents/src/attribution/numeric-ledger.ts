import { ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { numericReferenceDirectory, numericUnitIssue } from "./units.js";
import { matchesReference } from "./numeric.js";
import { resolveAttributionEvidence } from "./source-evidence.js";
import type { AttributionResult, Evidence } from "./types.js";

type NumericCheck = AttributionResult["numeric_checks"][number];
export type NumericSubmissionCheck = Omit<NumericCheck, "expected" | "matches" | "actual"> & {
  reference_index: number; actual: string | number | null;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Reference ownership is checkable even when an unrelated finding is malformed. */
export function numericReferenceSelectionIssues(request: AgentRequest, draft: unknown): ValidationIssue[] {
  const checks = object(draft)?.numeric_checks;
  if (!Array.isArray(checks)) return [];
  const groundTruth = request.input.ground_truth as { available: boolean; value: unknown };
  const directory = groundTruth.available ? numericReferenceDirectory(groundTruth.value) : [];
  return checks.flatMap((item, index) => {
    const selection = object(item)?.reference_index;
    if (Number.isSafeInteger(selection) && directory[selection as number]) return [];
    return [{ category: "decision", code: "numeric_reference_index_invalid", path: `/numeric_checks/${index}/reference_index`,
      actual: selection, expected: { numeric_references: directory },
      message: directory.length ? "reference_index 只选择 numeric_references 中列出的编号；先核对目标口径，不能以工具值或新计算值替换标准原值。"
        : "本标准没有可明确识别的数值目录项，numeric_checks 必须为 []；工具来源、日期、证券代码及标准之外的新计算值不能作为标准目标。" } as ValidationIssue];
  });
}

export function numericMatch(request: AgentRequest, check: Omit<NumericCheck, "matches">, evidence: Evidence | undefined) {
  const truth = request.input.ground_truth as { value: unknown };
  const answer = request.input.answer as { final_message_index: number };
  const source = request.sources.answer;
  const unitIssue = evidence ? numericUnitIssue(truth.value, evidence.quote, check,
    (source.value as { messages: unknown[] }).messages[answer.final_message_index], source.id) : null;
  const matches = unitIssue?.code !== "numeric_unit_mismatch" && check.actual !== null &&
    matchesReference(check.actual, check.expected, check.scale, check.mode);
  return { matches, unitIssue };
}

/** Program-owned standard precision and arithmetic; the selected position never enters formal output. */
export function resolveNumericChecks(request: AgentRequest, checks: NumericSubmissionCheck[], evidence: Evidence[]): NumericCheck[] {
  const errors = numericReferenceSelectionIssues(request, { numeric_checks: checks });
  if (errors.length) throw new ValidationError(errors);
  const truth = request.input.ground_truth as { value: unknown };
  const directory = numericReferenceDirectory(truth.value);
  return checks.map(({ reference_index, actual, ...check }) => {
    const resolved = { ...check, expected: directory[reference_index].expected,
      actual: typeof actual === "number" ? Object.is(actual, -0) ? "-0" : String(actual) : actual };
    return { ...resolved, matches: numericMatch(request, resolved, evidence[check.evidence_index]).matches };
  });
}

/** The same numeric rules run on safe submission fields and on complete formal results. */
export function numericLedgerIssues(request: AgentRequest, draft: unknown, representation: "submission" | "result", audit?: ToolAudit): ValidationIssue[] {
  const value = object(draft);
  if (!value || !Array.isArray(value.numeric_checks)) return [];
  const truth = request.input.ground_truth as { available: boolean; value: unknown };
  const directory = truth.available ? numericReferenceDirectory(truth.value) : [];
  const issues = representation === "submission" ? numericReferenceSelectionIssues(request, draft) : [];
  const issue = (code: string, path: string, message: string, actual?: unknown, expected?: unknown) =>
    issues.push({ category: "decision", code, path, message, actual, expected });
  const evidence = Array.isArray(value.correctness_evidence) ? value.correctness_evidence.map((raw, index): Evidence | undefined => {
    if (representation === "result") return typeof object(raw)?.quote === "string" ? raw as Evidence : undefined;
    const ref = object(raw);
    if (!ref || !audit) return undefined;
    try {
      return resolveAttributionEvidence(request, ref as { evidence_id: string }, audit, `/correctness_evidence/${index}`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return undefined; // Evidence diagnostics are already collected by submissionEvidenceIssues.
    }
  }) : [];
  value.numeric_checks.forEach((raw, index) => {
    const item = object(raw), location = `/numeric_checks/${index}`;
    if (!item) return;
    const expected = representation === "submission" ? directory[item.reference_index as number]?.expected : item.expected;
    if (typeof expected !== "string") return;
    if (representation === "result" && !directory.some(entry => entry.expected === expected)) {
      issue("numeric_reference_missing", `${location}/expected`, "expected 必须来自标准答案的数值目录并保留原有小数位和科学计数法指数，不能展开为整数、换算标准或编造容差。", expected, directory);
      return;
    }
    if (typeof item.actual !== "string" && item.actual !== null && typeof item.actual !== "number" ||
      typeof item.scale !== "string" || !["rounded", "exact"].includes(item.mode as string) || !Number.isSafeInteger(item.evidence_index)) return;
    if (typeof item.actual === "number" && (!Number.isFinite(item.actual) || Number.isInteger(item.actual) && !Number.isSafeInteger(item.actual))) return;
    const check = { ...item, expected, actual: typeof item.actual === "number" ? Object.is(item.actual, -0) ? "-0" : String(item.actual) : item.actual } as NumericCheck;
    const actualEvidence = evidence[check.evidence_index];
    let calculation: ReturnType<typeof numericMatch>;
    try { calculation = numericMatch(request, check, actualEvidence); }
    catch (error) { issue("numeric_invalid", location, (error as Error).message); return; }
    const { matches, unitIssue } = calculation;
    if (representation === "submission" && unitIssue?.code === "numeric_unit_mismatch" && value.is_correct !== false)
      issue(unitIssue.code, location,
        `${check.label}：${unitIssue.message}先核对指标定义：可直接比较但量纲确实错误时保留本项并判错；须解释标准简写、计算或解码才能比较时，不把该目标当直接点值，在 correctness_reason 写明原定义、核对过程和结论。`,
        { label: check.label, expected: check.expected, actual: check.actual, scale: check.scale });
    if (unitIssue?.code === "numeric_unit_mismatch" && !matchesReference(check.scale, "1", "1", "exact"))
      issue("numeric_scale_mismatch", `${location}/scale`, "不同维度没有单位等价倍率；保留scale=1，并在correctness_reason说明差异。");
    if (representation === "result" && check.matches !== matches)
      issue(unitIssue?.code === "numeric_unit_mismatch" ? unitIssue.code : "numeric_rounding_mismatch", `${location}/matches`,
        unitIssue?.code === "numeric_unit_mismatch" ? `${unitIssue.message} matches 必须为false。` :
          `${check.label}：${check.actual} × ${check.scale} 与标准值 ${check.expected} 按 ${check.mode} 核验，matches 应为 ${matches}；同步修正理由和 findings，不能把精度等价写成错误。`, check.matches, matches);
    if (unitIssue && unitIssue.code !== "numeric_unit_mismatch") issue(unitIssue.code, `${location}/scale`, unitIssue.message);
    if (actualEvidence && check.actual !== null && unitIssue?.code === "numeric_answer_context_missing")
      issue("numeric_answer_missing", `${location}/evidence_index`, `${check.label} 的原始数值 ${check.actual} 未出现在 correctness_evidence[${check.evidence_index}]；actual 保留最终回答原数值，不能先换算、补0或使用自行推导值。请选择包含真实原数值的最终回答证据。`,
        { number: check.actual, quote: actualEvidence.quote });
    if (value.is_correct === true && !matches)
      issue("numeric_correctness_contradiction", "/is_correct", "存在未通过的标准数值核对，不能判全部正确；先核查数值、单位、口径是否选对");
    if (value.is_correct === null && !matches)
      issue("numeric_uncertainty_contradiction", "/is_correct", "数值核对已确认缺失、不等价或不同量纲时必须明确判false，不能把已知错误改写成待核实。");
  });
  return issues;
}
