import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, schemaIssues, ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import type { CriteriaInput, TaskAnalysis } from "./types.js";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/criteria/result.schema.json" with { type: "json" };
import { criteriaText } from "@eval/prompts";
import { criteriaSources } from "./sources.js";
import { matchCriterionSources } from "./resolve.js";

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
  const catalogue = criteriaSources(input);
  const requiredSources = new Map<string, Set<string>>();
  if (value.goal !== input.question || value.task_type !== criteriaText("task_type")) errors.push({
    category: "decision", code: "criteria_summary_not_derived", path: "/goal",
    message: "goal 必须保留题目原文，task_type 必须由程序固定，不得在概括中新增标准",
  });
  const candidates = new Set(input.candidates.map((candidate) => candidate.candidate_id));
  if (candidates.size !== input.candidates.length) errors.push({
    category: "decision", code: "criteria_candidate_duplicate", path: "/candidates",
    message: "candidate_id 必须是本题互不重复的输入 UUID", actual: input.candidates.map((candidate) => candidate.candidate_id),
  });
  const ids = new Set<string>();
  const resolvedCriteria = new Map<string, { id: string; path: string }>();
  for (const group of ["requirements", "scoring_points", "red_flags"] as const)
    value[group].forEach((criterion, index) => {
      const location = `/${group}/${index}`;
      if (ids.has(criterion.id)) errors.push({
        category: "decision", code: "criterion_id_duplicate", path: `${location}/id`,
        message: "判据 ID 必须在 requirements、scoring_points 和 red_flags 三数组内全局唯一", actual: criterion.id,
      });
      ids.add(criterion.id);
      const key = canonical({ text: criterion.text, applies_to: [...criterion.applies_to].sort(), acceptance_rule: criterion.acceptance_rule });
      const duplicate = resolvedCriteria.get(key);
      if (duplicate) errors.push({
        category: "decision", code: "criterion_duplicate", path: location,
        message: "相同原文、作用域和验收规则只能保留一条判据；合并重复的来源选择，不因分组或ID不同重复评审", actual: criterion.id, expected: duplicate,
      });
      else resolvedCriteria.set(key, { id: criterion.id, path: location });
      const sources = matchCriterionSources(input, criterion, catalogue);
      if (!sources) errors.push({
        category: "decision", code: "criterion_source_mismatch", path: location,
        message: "text、acceptance_rule 与 applies_to 必须由完整原文来源生成，不能新增数值容差、替换单位或改变原句条件",
      });
      else if (group === "requirements") for (const source of sources) {
        const covered = requiredSources.get(source.id) ?? new Set<string>();
        for (const candidate of candidates) if (!criterion.applies_to.length || criterion.applies_to.includes(candidate)) covered.add(candidate);
        requiredSources.set(source.id, covered);
      }
      for (const candidate of criterion.applies_to) if (!candidates.has(candidate)) errors.push({
        category: "decision", code: "criterion_scope_unknown", path: `${location}/applies_to`, candidate,
        message: "applies_to 只能引用本题真实 candidate_id；[] 表示适用于全部候选", actual: candidate, expected: [...candidates],
      });
      for (const field of ["text", "acceptance_rule"] as const) if (!criterion[field].trim()) errors.push({
        category: "decision", code: "criterion_text_empty", path: `${location}/${field}`,
        message: `${field} 必须包含可核对的要求或验收规则`, actual: criterion[field],
      });
    });
  for (const source of catalogue.filter((source) => source.kind === "question" || source.kind === "reference"))
    for (const candidate of candidates) if (!requiredSources.get(source.id)?.has(candidate)) errors.push({
      category: "decision", code: "criterion_required_source_missing", path: "/requirements", candidate,
      message: "每个候选的 requirements 都必须保留题目原文和存在的标准答案", actual: source.id });
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
