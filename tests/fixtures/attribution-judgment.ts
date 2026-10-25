import type { AgentRequest,TaskAnalysis } from "@eval/contracts";
import { attributionNormDirectory,numericReferenceDirectory,responsibilityComponentName,type AttributionResult,type ProblemProposal } from "@eval/agents/attribution";
import { normSelection, setFixtureComponentCatalog } from "./attribution-submission.js";
type FixtureFinding = Omit<AttributionResult["findings"][number], "finding_id" | "problem" | "evidence" | "assessment"> & {
  norm_index?: number | null;
  assessment: Omit<AttributionResult["findings"][number]["assessment"], "requirement_index"> & { requirement_index?: number | null };
  problem?: ProblemProposal;
  evidence: { evidence_id: string }[];
};

/** Program-bound judgment for local business validation tests; never sent to a model submission tool. */
export function attributionJudgment(request: AgentRequest, result: AttributionResult) {
  setFixtureComponentCatalog(request);
  const { has_standard_answer: _derived, task_analysis: _shared, core_assessment, ...submission } = result;
  const refs = (evidence: AttributionResult["correctness_evidence"]) =>
    evidence.map(item => ({ evidence_id: item.evidence_id }));
  const requirements = (request.input.task_analysis as unknown as TaskAnalysis).requirements;
  const truth = request.input.ground_truth as { available: boolean; value: unknown };
  const directory = truth.available ? numericReferenceDirectory(truth.value) : [];
  const norms = attributionNormDirectory(request);
  const finding = (finding: AttributionResult["findings"][number]): FixtureFinding => {
    const { problem: _derivedProblem, finding_id: _id, context_evidence: _context, assessment, ...strength } = finding;
    const { requirement_index, ...observed } = assessment;
    return { ...strength,
      ...(finding.dimension === "instruction_following" ? { norm_index: normSelection(norms, finding), assessment: observed }
        : { assessment: { ...observed, requirement_index } }),
      ...(finding.type === "problem" ? { problem: {...structuredClone(finding.problem!),component:finding.problem!.component.map(cause=>{
        const actors=(request.input.answer as {component_catalog:import('@eval/tools').TraceComponentIdentity[]}).component_catalog;
        const actor_index=Math.max(0,actors.findIndex(actor=>actor.component===cause.component)+1)||cause.actor_index;
        return {...cause,actor_index,component:responsibilityComponentName(actors[actor_index-1],cause.business_component)};})} } : {}),
      evidence: refs(finding.evidence) };
  };
  const draft = {
    ...submission,
    correctness_evidence: refs(result.correctness_evidence),
    numeric_checks: result.numeric_checks.map(({ expected, matches: _computed, ...check }) => ({
      ...check, reference_index: directory.findIndex(item => item.expected === expected),
    })),
    core_assessment: {
      meets_core: core_assessment.meets_core,
      reason: core_assessment.reason,
      requirement_indices: core_assessment.criterion_ids.map(id => requirements.findIndex(criterion => criterion.id === id)),
    },
    criterion_assessments: result.criterion_assessments
      .filter(assessment => assessment.status !== "not_applicable")
      .map(({ context_evidence: _context, ...assessment }) => ({ ...assessment, evidence: refs(assessment.evidence) })),
    findings: result.findings.map(finding),
  };
  if (!(request.input.ground_truth as { available: boolean }).available) {
    const optional = draft as Partial<typeof draft>;
    delete optional.is_correct;
    delete optional.correctness_reason;
    delete optional.correctness_evidence;
  }
  return draft;
}

