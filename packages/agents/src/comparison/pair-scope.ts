import type { AgentRequest, TaskCriterion } from "@eval/contracts";
import { evidenceCovers, evidenceId, hasSourceTextBlock, normativeSources, sourceContentBlocks } from "@eval/tools";
import type { ComparisonInput } from "./types.js";

/** A group-level criterion can be common to this pair without applying to a third candidate. */
export function criterionAppliesToPair(input: ComparisonInput, criterion: TaskCriterion): boolean {
  return Object.values(input.candidates).every(candidate =>
    !criterion.applies_to.length || criterion.applies_to.includes(candidate.candidate_id));
}

/** Requirement indexes address the finding owner's accepted analysis, never another candidate's array. */
export function findingCriterion(input: ComparisonInput, candidate: string, findingIndex: number): TaskCriterion | undefined {
  const attribution = input.attributions[candidate];
  const index = attribution?.findings[findingIndex]?.assessment.requirement_index;
  if (index === null || index === undefined) return undefined;
  const source = attribution.task_analysis.requirements[index];
  return source && input.task_analysis.requirements.find(criterion => criterion.id === source.id);
}

export function findingAppliesToPair(input: ComparisonInput, candidate: string, findingIndex: number, raw: unknown): boolean {
  const finding = input.attributions[candidate]?.findings[findingIndex];
  if (!finding) return false;
  const trace = raw && typeof raw === "object" && "messages" in raw && Array.isArray(raw.messages)
    ? raw as { messages: unknown[] } : undefined;
  const sources = trace ? normativeSources(trace, input.candidates[candidate].candidate_id, input.candidates[candidate].final_message_index) : [];
  // A dimension label cannot turn explicitly cited private rules into common evidence.
  // Require every real leaf origin of the complete block, never a coincident short phrase.
  const citedNorms = sources.flatMap(source => sourceContentBlocks(source.content, source.path).filter(block =>
    block.origins.length && block.origins.every(origin => finding.evidence.some(evidence =>
      evidence.source === undefined && evidence.source_input_id === undefined && evidenceCovers(trace!, input.candidates[candidate].candidate_id,
        evidence.evidence_id, evidenceId(input.candidates[candidate].candidate_id, source.message_index, "text", origin.path, origin.start, origin.end))))));
  if (citedNorms.some(block => !input.task_analysis.requirements.some(criterion =>
    criterionAppliesToPair(input, criterion) && hasSourceTextBlock(criterion.text, block.quote)))) return false;
  if (finding.assessment.requirement_index === null) return finding.dimension !== "instruction_following";
  const criterion = findingCriterion(input, candidate, findingIndex);
  if (!criterion || !criterionAppliesToPair(input, criterion)) return false;
  if (finding.dimension !== "instruction_following") return true;
  if (!trace) return false;
  // A model index is not provenance: the explicitly cited original norm must belong
  // to this common criterion before an instruction finding can affect the pair.
  return citedNorms.some(block => hasSourceTextBlock(criterion.text, block.quote));
}

/** Expose the same scope gate used by validation; scope alone does not prove a relative advantage. */
export function comparisonScope(request: AgentRequest) {
  const input = request.input as unknown as ComparisonInput;
  return {
    common_criterion_ids: [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags]
      .filter(criterion => criterionAppliesToPair(input, criterion)).map(criterion => criterion.id),
    findings: Object.fromEntries(Object.entries(input.attributions).map(([candidate, attribution]) => [candidate,
      attribution.findings.map((_, finding_index) => ({ finding_index,
        scope: findingAppliesToPair(input, candidate, finding_index, request.sources[candidate]?.value)
          ? "pair" as const : "source_only" as const,
      })),
    ])),
  };
}
