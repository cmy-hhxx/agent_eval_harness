import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import type { ComparisonResult, Finding } from "./types.js";
import schema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };

interface Input {
  ground_truth: { available: boolean; value: unknown };
  candidates: Record<string, unknown>;
  attributions?: Record<string, { is_correct: boolean | null; findings: Finding[] }>;
  strength_checks?: { candidate: string; finding_index: number }[];
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

  const covered = new Map(labels.map((label) => [label, new Set<number>()]));
  for (const [index, row] of value.decision_basis.comparisons.entries()) {
    const path = `/decision_basis/comparisons/${index}`;
    const compared = Object.keys(row.assessments);
    if (compared.length !== labels.length || !labels.every((label) => compared.includes(label)))
      issue("comparison_incomplete", `${path}/assessments`, "每个比较点必须在同一行包含全部候选的表现", undefined, compared);
    if (row.better_candidates.some((label) => !labels.includes(label)) || row.better_candidates.length >= labels.length)
      issue("comparison_advantage_invalid", `${path}/better_candidates`, "优势候选必须属于本组；共同优点或无已证实优势时填空数组", undefined, row.better_candidates);
    for (const [label, assessment] of Object.entries(row.assessments))
      for (const findingIndex of assessment.finding_indices) {
        if (!input.attributions?.[label]?.findings[findingIndex])
          issue("finding_missing", `${path}/assessments/${label}/finding_indices`, "比较点只能引用该候选的既有 finding", label, findingIndex);
        else covered.get(label)?.add(findingIndex);
      }
  }
  const materialProblems = Object.entries(input.attributions || {}).flatMap(([candidate, attribution]) =>
    attribution.findings.flatMap((finding, finding_index) => finding.type === "problem" && finding.importance !== "low"
      ? [{ candidate, finding_index }] : []),
  );
  for (const ref of [...(input.strength_checks || []), ...materialProblems, ...value.decision_basis.decisive_findings])
    if (!covered.get(ref.candidate)?.has(ref.finding_index))
      issue("comparison_finding_uncovered", "/decision_basis/comparisons", "逐项对照必须覆盖全部待核对优点、中高重要性问题和决定性发现，可在同一方面合并相关 finding", ref.candidate, ref.finding_index);

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
