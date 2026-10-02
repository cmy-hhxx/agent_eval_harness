import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest } from "@eval/contracts";
import { comparisonText } from "@eval/prompts";
import schema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import type { ComparisonInput, ComparisonResult, ComparisonSubmission, CriterionStatus, EvidenceStatus } from "./types.js";

const validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

/** Source-derived states never create findings or promote uncertain evidence. */
export function comparisonCellState(input: ComparisonInput, candidate: string, criterionIds: string[], findingIndices: number[]): {
  status: CriterionStatus; evidence_status: EvidenceStatus;
} {
  const attribution = input.attributions[candidate];
  const findings = findingIndices.map(index => attribution?.findings[index]);
  const uncertainFinding = findings.some(finding => !finding || finding.assessment.evidence_status === "uncertain");
  if (criterionIds.length) {
    const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
    const byId = new Map(criteria.map(criterion => [criterion.id, criterion]));
    const applicable = criterionIds.filter(id => {
      const criterion = byId.get(id);
      return criterion && (!criterion.applies_to.length || criterion.applies_to.includes(input.candidates[candidate]?.candidate_id));
    });
    const facts = applicable.flatMap(id => attribution?.criterion_assessments.filter(fact => fact.criterion_id === id) ?? []);
    if (criterionIds.some(id => !byId.has(id)) || applicable.some(id => facts.filter(fact => fact.criterion_id === id).length !== 1) ||
      facts.some(fact => fact.status === "not_applicable")) return { status: "unknown", evidence_status: "uncertain" };
    let status: CriterionStatus = facts.length ? "met" : "not_applicable";
    for (const candidateStatus of ["unknown", "unmet", "partial"] as const)
      if (facts.some(fact => fact.status === candidateStatus)) { status = candidateStatus; break; }
    return { status, evidence_status: status === "unknown" || uncertainFinding || facts.some(fact => fact.evidence_status === "uncertain")
      ? "uncertain" : "established" };
  }
  if (findingIndices.length) return uncertainFinding
    ? { status: "unknown", evidence_status: "uncertain" }
    : { status: "met", evidence_status: "established" };
  const material = input.candidates[candidate];
  const seconds = material?.original_answer_timing?.finish_seconds;
  const tokens = material?.original_answer_usage?.total_tokens;
  const hasMetric = (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) ||
    (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 && !material.original_answer_usage.issues.length);
  return hasMetric ? { status: "met", evidence_status: "established" } : { status: "unknown", evidence_status: "uncertain" };
}

export function resolveComparison(request: AgentRequest, draft: unknown): ComparisonResult {
  if (!validator(draft)) throw new ValidationError(schemaIssues(validator.errors, draft));
  const value = draft as ComparisonSubmission, input = request.input as unknown as ComparisonInput;
  const labels = Object.keys(input.candidates);
  const checkCandidates = (actual: string[], path: string, code: string) => {
    if (actual.length !== labels.length || !labels.every(label => actual.includes(label)))
      throw new ValidationError([{ category: "decision", code, path, actual,
        message: `必须恰好包含全部候选；合法候选标识为 ${JSON.stringify(labels)}，所有候选键和引用必须原样使用这些标识。` }]);
  };
  checkCandidates(Object.keys(value.assessments), "/assessments", "assessment_incomplete");
  const assessments = Object.fromEntries(Object.entries(value.assessments).map(([label, item]) => {
    const source = input.attributions[label]?.core_assessment;
    const reviewed = value.status === "needs_review" && value.review_requests.some(review => review.candidate === label);
    const meets_core = reviewed ? null : source?.meets_core ?? null;
    return [label, { summary: item.summary, meets_core,
      core_failure_refs: meets_core === false ? [...source!.criterion_ids] : [] }];
  }));
  const common = { status: value.status, review_requests: structuredClone(value.review_requests), assessments,
    task_analysis: structuredClone(input.task_analysis) };
  if (value.status === "needs_review") return { ...common, ranking: [],
    decision_basis: { comparisons: [], decisive_findings: [], tradeoff: comparisonText("review_pending") } };
  return { ...common, ranking: structuredClone(value.ranking), decision_basis: {
    tradeoff: value.decision_basis.tradeoff,
    decisive_findings: structuredClone(value.decision_basis.decisive_findings),
    comparisons: value.decision_basis.comparisons.map((row, index) => {
      checkCandidates(Object.keys(row.assessments), `/decision_basis/comparisons/${index}/assessments`, "comparison_incomplete");
      return { ...structuredClone(row), assessments: Object.fromEntries(Object.entries(row.assessments).map(([label, cell]) =>
        [label, { ...structuredClone(cell), ...comparisonCellState(input, label, row.criterion_ids, cell.finding_indices) }])) };
    }),
  } };
}
