import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import type { CriteriaInput, TaskAnalysis } from "./types.js";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/criteria/result.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile<unknown>(requestSchema);
const validateResult = ajv.compile<unknown>(resultSchema);

export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  void audit;
  if (!validateRequest(request.input)) throw new ValidationError(schemaIssues(validateRequest.errors, request.input));
  if (!validateResult(result)) throw new ValidationError(schemaIssues(validateResult.errors, result));
  const input = request.input as unknown as CriteriaInput;
  const value = result as TaskAnalysis;
  const errors: ValidationIssue[] = [];
  const candidates = new Set(input.candidates.map((candidate) => candidate.candidate_id));
  if (candidates.size !== input.candidates.length) errors.push({
    category: "decision", code: "criteria_candidate_duplicate", path: "/candidates",
    message: "candidate_id 必须是本题互不重复的输入 UUID", actual: input.candidates.map((candidate) => candidate.candidate_id),
  });
  const ids = new Set<string>();
  for (const group of ["requirements", "scoring_points", "red_flags"] as const)
    value[group].forEach((criterion, index) => {
      const location = `/${group}/${index}`;
      if (ids.has(criterion.id)) errors.push({
        category: "decision", code: "criterion_id_duplicate", path: `${location}/id`,
        message: "判据 ID 必须在 requirements、scoring_points 和 red_flags 三数组内全局唯一", actual: criterion.id,
      });
      ids.add(criterion.id);
      for (const candidate of criterion.applies_to) if (!candidates.has(candidate)) errors.push({
        category: "decision", code: "criterion_scope_unknown", path: `${location}/applies_to`, candidate,
        message: "applies_to 只能引用本题真实 candidate_id；[] 表示适用于全部候选", actual: candidate, expected: [...candidates],
      });
      for (const field of ["text", "acceptance_rule"] as const) if (!criterion[field].trim()) errors.push({
        category: "decision", code: "criterion_text_empty", path: `${location}/${field}`,
        message: `${field} 必须包含可核对的要求或验收规则`, actual: criterion[field],
      });
    });
  const count = value.requirements.length + value.scoring_points.length + value.red_flags.length;
  for (const candidate of candidates) if (!value.requirements.some((criterion) =>
    !criterion.applies_to.length || criterion.applies_to.includes(candidate))) errors.push({
    category: "decision", code: "criterion_requirement_scope_empty", path: "/requirements", candidate,
    message: "每个候选至少需要一条适用的 requirements；共同任务目标用 applies_to=[]，不能只为另一候选设置验收要求", actual: candidate,
  });
  if (count > 24) errors.push({
    category: "decision", code: "criteria_budget_exceeded", path: "/",
    message: "requirements、scoring_points 和 red_flags 合计最多 24 条；合并重复判据", actual: count, expected: 24,
  });
  if (errors.length) throw new ValidationError(errors);
}
