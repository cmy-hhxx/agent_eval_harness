import type { AgentRequest, TaskAnalysis } from "@eval/contracts";
import { attributionNormDirectory, numericReferenceDirectory, type AttributionResult, type ProblemProposal, type ProblemSubmission } from "@eval/agents/attribution";
import { parseEvidenceCoordinates } from "@eval/tools";
type NormChoice = { norm_index: number; requirement_index: number | null; evidence: { evidence_id: string }[] };
type FixtureFinding = Omit<AttributionResult["findings"][number], "finding_id" | "problem" | "evidence" | "assessment"> & {
  norm_index?: number | null;
  assessment: Omit<AttributionResult["findings"][number]["assessment"], "requirement_index"> & { requirement_index?: number | null };
  problem?: ProblemSubmission;
  evidence: { evidence_id: string }[];
};

/** Construct the current program-owned directory for a hand-built request. */
export function setFixtureNormDirectory(request: AgentRequest) {
  const directory = attributionNormDirectory(request);
  Object.assign(request.input.answer as object, { norm_directory: directory });
  return directory;
}

/** Invert a known fixture using its genuine requirement owner or unique physical norm, never its prose. */
export function normSelection(directory: NormChoice[], finding: AttributionResult["findings"][number]): number | null {
  const index = finding.assessment.requirement_index;
  if (index !== null) {
    const associated = directory.filter(norm => norm.requirement_index === index);
    if (associated.length === 1) return associated[0]!.norm_index;
    if (associated.length > 1) throw new Error(`Fixture requirement ${index} has ambiguous norm owners`);
  }
  const own = finding.evidence.filter(item => item.source === undefined && item.source_input_id === undefined);
  const intersects = (selected: { evidence_id: string }, norm: { evidence_id: string }) => {
    const a = parseEvidenceCoordinates(selected.evidence_id), b = parseEvidenceCoordinates(norm.evidence_id);
    return a?.kind === "text" && b?.kind === "text" && a.input_id === b.input_id && a.message_index === b.message_index &&
      a.path === b.path && a.start < b.end && b.start < a.end;
  };
  const selected = directory.filter(norm => norm.requirement_index === null &&
    norm.evidence.some(origin => own.some(item => intersects(item, origin))));
  if (selected.length === 1) return selected[0]!.norm_index;
  if (!selected.length && finding.assessment.evidence_status === "uncertain") return null;
  throw new Error(`Fixture finding ${finding.finding_id} has no unique genuine norm owner: ${selected.map(item => item.norm_index).join(",")}`);
}

/** Invert known canonical fixture responsibility without treating other source citations as responsible. */
export function problemSubmission(problem: ProblemProposal, evidence: AttributionResult["correctness_evidence"],
  catalog: { message_index: number; name?: string | null; type: string; role?: string }[]): ProblemSubmission {
  return { model_responsible: problem.component.includes("模型自身推理"),
    tool_evidence_indices: problem.component.filter(component => component !== "模型自身推理").map(component => {
      const index = evidence.findIndex(item => item.source === undefined && item.source_input_id === undefined &&
        catalog.some(message => message.message_index === item.message_index && message.name === component &&
          (["function_call", "function_call_output", "tool_call", "tool_result"].includes(message.type) || message.role === "tool")));
      if (index < 0) throw new Error(`Fixture responsibility has no own selected evidence: ${component}`);
      return index;
    }), label: problem.label, definition: problem.definition };
}

/** Current fixture contract only; resolveFixtureEvidence registers these coordinates as numeric choices. */
export function attributionSubmission(request: AgentRequest, result: AttributionResult) {
  const { has_standard_answer: _derived, task_analysis: _shared, core_assessment, ...submission } = result;
  const refs = (evidence: AttributionResult["correctness_evidence"]) =>
    evidence.map(item => ({ evidence_id: item.evidence_id }));
  const requirements = (request.input.task_analysis as unknown as TaskAnalysis).requirements;
  const truth = request.input.ground_truth as { available: boolean; value: unknown };
  const directory = truth.available ? numericReferenceDirectory(truth.value) : [];
  const norms = attributionNormDirectory(request);
  const finding = (finding: AttributionResult["findings"][number]): FixtureFinding => {
    const { problem: _derivedProblem, finding_id: _id, assessment, ...strength } = finding;
    const { requirement_index, ...observed } = assessment;
    return { ...strength,
      ...(finding.dimension === "instruction_following" ? { norm_index: normSelection(norms, finding), assessment: observed }
        : { assessment: { ...observed, requirement_index } }),
      ...(finding.type === "problem" ? { problem: problemSubmission(finding.problem!, finding.evidence,
        (request.input.answer as { catalog: { message_index: number; name?: string | null; type: string; role?: string }[] }).catalog) } : {}),
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
      .map(assessment => ({ ...assessment, evidence: refs(assessment.evidence) })),
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
