import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import type { ComparisonResult, Finding } from "./types.js";
import schema from "./profiles/default/resolved.schema.json" with { type: "json" };

interface Input {
  ground_truth: { available: boolean; value: unknown };
  candidates: Record<string, unknown>;
  attributions?: Record<string, { is_correct: boolean | null; findings: Finding[] }>;
}

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  void audit;
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const value = result as ComparisonResult;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual });

  const labels = Object.keys(input.candidates);
  const ranked = value.ranking.flat();
  if (new Set(ranked).size !== ranked.length)
    issue("ranking_duplicate", "/ranking", "排名包含重复候选", undefined, ranked);
  if (ranked.length !== labels.length || !labels.every((label) => ranked.includes(label)))
    issue("ranking_incomplete", "/ranking", "排名必须恰好包含本组全部候选", undefined, ranked);
  if (ranked.length < 2) issue("ranking_too_small", "/ranking", "对比至少需要两个候选");
  const assessed = Object.keys(value.assessments);
  if (assessed.length !== labels.length || !labels.every((label) => assessed.includes(label)))
    issue("assessment_incomplete", "/assessments", "必须为本组每个候选给出 meets_core 与 summary", undefined, assessed);

  for (const [index, ref] of value.decision_basis.decisive_findings.entries()) {
    const findings = input.attributions?.[ref.candidate]?.findings;
    if (!findings?.[ref.finding_index])
      issue(
        "finding_missing",
        `/decision_basis/decisive_findings/${index}`,
        "决定性发现必须引用归因结果中的既有 finding",
        ref.candidate,
        ref.finding_index,
      );
  }
  if (input.ground_truth.available)
    for (const label of labels)
      if (input.attributions?.[label]?.is_correct === false && value.assessments[label]?.meets_core)
        issue(
          "correctness_contradiction",
          `/assessments/${label}/meets_core`,
          `${label} 的独立归因判为错误，不能同时判定满足核心要求`,
          label,
        );

  if (errors.length) throw new ValidationError(errors);
}
