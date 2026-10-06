import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type TaskAnalysis,
  type ValidationIssue,
} from "@eval/contracts";
import { resolveAttributionEvidence } from "./source-evidence.js";
import type { Evidence, ProblemSubmission } from "./types.js";
import { resolveProblemSubmission } from "./responsibility.js";
import schema from "../../../../schemas/attribution/judgment.schema.json" with { type: "json" };
import { parseTraceTables } from "@eval/tools";
import { instructionEvidenceContext } from "./instructions.js";
import { validateJudgment, submissionCoreRequirements } from "./validate.js";
import { resolveNumericChecks, type NumericSubmissionCheck } from "./numeric-ledger.js";
import { attributionNormDirectory, finalAnswerScope, submissionFindingEntries } from "./norm-directory.js";

type EvidenceRef = { evidence_id: string; source?: string; observation?: string };
type DraftFinding = {
  evidence: EvidenceRef[];
  norm_index?: number | null;
  assessment: { requirement_index?: number | null; observation: string };
  [key: string]: unknown;
} & ({ type: "strength" } | { type: "problem"; problem: ProblemSubmission });
type DraftCriterionAssessment = { criterion_id: string; evidence: EvidenceRef[]; [key: string]: unknown };

const validate = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
export function resolveJudgment(request: AgentRequest, draft: unknown, audit: ToolAudit): unknown {
  const valid=validate(draft),issues=valid?[]:schemaIssues(validate.errors,draft);
  issues.push(...validateJudgment(request,draft,audit));
  if(issues.length)throw new ValidationError(issues);
  const core=submissionCoreRequirements(request,draft);
  const available = (request.input.ground_truth as { available: boolean }).available;
  const errors: ValidationIssue[] = [];
  const instructionContext = instructionEvidenceContext(request);
  errors.push(...instructionContext.bindingIssues);
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const orderedCriteria = [...task.requirements, ...task.scoring_points, ...task.red_flags];
  const submitted = new Map((draft as { criterion_assessments: DraftCriterionAssessment[] }).criterion_assessments
    .map((assessment, index) => [assessment.criterion_id, { assessment, index }]));
  const resolveSelected = (refs: EvidenceRef[], location: string): (Evidence | undefined)[] =>
    refs.map((value, i) => {
      try {
        return resolveAttributionEvidence(request, value, audit, `${location}/${i}`);
      } catch (error) {
        if (error instanceof ValidationError) errors.push(...error.issues!);
        else throw error;
        return undefined;
      }
    });
  const resolveRefs = (refs: EvidenceRef[], location: string) => resolveSelected(refs, location).filter((item): item is Evidence => item !== undefined);
  const value = structuredClone(draft) as {
    core_assessment: { meets_core: boolean | null; reason: string; requirement_indices: number[] };
    correctness_evidence?: EvidenceRef[];
    findings: DraftFinding[];
    numeric_checks: NumericSubmissionCheck[];
    criterion_assessments: DraftCriterionAssessment[];
    table_resolutions?: { table_index: number; row_index: number; outcome: "supported" | "conflict"; reason: string; evidence: EvidenceRef[] }[];
  };
  const withNorms = (refs: EvidenceRef[], criterion: TaskAnalysis["requirements"][number] | undefined, location: string) => {
    return instructionContext.appendNorms(resolveRefs(refs, location), instructionContext.forCriterion(criterion));
  };
  const directory = attributionNormDirectory(request);
  const findings = submissionFindingEntries(value).map(({ finding: entry, path }, index) => {
    const finding = entry as DraftFinding;
    const selected = resolveSelected(finding.evidence, `${path}/evidence`);
    // Responsibility indices refer only to the original submitted evidence, before program additions.
    const problem = finding.type === "problem"
      ? resolveProblemSubmission(request, finding.problem, selected, `${path}/problem`) : null;
    const ruleBound=Object.hasOwn(finding,"norm_index");
    const norm = ruleBound && finding.norm_index !== null ? directory[finding.norm_index!] : undefined;
    const requirementIndex = ruleBound ? norm?.requirement_index ?? null : finding.assessment.requirement_index ?? null;
    const { norm_index: _selection, ...canonicalFinding } = finding;
    let evidence = instructionContext.appendNorms(selected.filter((item): item is Evidence => item !== undefined),
      norm?.evidence ?? instructionContext.forRequirement(requirementIndex));
    if (finding.stage === "final_answer") evidence = instructionContext.appendNorms(evidence,
      finalAnswerScope(request, finding.assessment.observation, audit, `${path}/evidence`));
    return { ...canonicalFinding, finding_id: "f" + index,
      assessment: { ...finding.assessment, requirement_index: requirementIndex }, problem, evidence };
  });
  const correctnessEvidence = available ? resolveRefs(value.correctness_evidence!, "/correctness_evidence") : [];
  const resolved = {
    ...value,
    numeric_checks: resolveNumericChecks(request, value.numeric_checks, correctnessEvidence),
    core_assessment: { meets_core: value.core_assessment.meets_core, reason: value.core_assessment.reason,
      criterion_ids: core.criterionIds },
    has_standard_answer: available,
    task_analysis: structuredClone(request.input.task_analysis as unknown as TaskAnalysis),
    findings,
    criterion_assessments: orderedCriteria.map(criterion => {
      if (criterion.applies_to.length && !criterion.applies_to.includes(request.input.candidate_id as string)) return {
        criterion_id: criterion.id, status: "not_applicable", evidence_status: "established",
        summary: "该判据的 applies_to 不包含当前候选，本候选不适用。", evidence: [],
      };
      const { assessment, index } = submitted.get(criterion.id)!;
      return { ...structuredClone(assessment), evidence: withNorms(assessment.evidence, criterion, `/criterion_assessments/${index}/evidence`) };
    }),
    ...(available
      ? { correctness_evidence: correctnessEvidence }
      : { is_correct: null, correctness_reason: "", correctness_evidence: [] }),
    ...(value.table_resolutions ? { table_resolutions: (() => {
      const own = request.sources.answer;
      const tables = parseTraceTables(own.value as { messages: unknown[] }, own.id);
      const answer = request.input.answer as { final_message_index: number; table_check_results: { answer_table_id: string }[] };
      const available = new Set(answer.table_check_results.map(table => table.answer_table_id));
      const expected = tables.flatMap((table, index) => available.has(table.table_id) && table.message_index === answer.final_message_index ? [index + 1] : []);
      return value.table_resolutions!.flatMap(({ table_index, ...resolution }, index) => {
        const evidence = resolveRefs(resolution.evidence, `/table_resolutions/${index}/evidence`);
        const table = tables[table_index - 1];
        if (!expected.includes(table_index)) {
          errors.push({ category: "evidence", code: "table_resolution_table_index", path: `/table_resolutions/${index}/table_index`,
            message: "table_index 须选择本方固定表格目录中、当前 table_check_results 已列出的最终回答表编号。", actual: table_index, expected });
          return [];
        }
        return [{ ...resolution, table_id: table.table_id, evidence }];
      });
    })() } : {}),
  };
  if (errors.length) throw new ValidationError(errors);
  return resolved;
}
