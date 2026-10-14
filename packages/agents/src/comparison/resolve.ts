import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { comparisonText, comparisonResourceText } from "@eval/prompts";
import schema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import type { ComparisonInput, ComparisonResult, ComparisonSubmission } from "./types.js";
import { criterionAppliesToPair } from "./pair-scope.js";
import { comparisonSlots, comparisonSlotCellState, comparisonSlotSummary, comparisonAdvantageCandidates, comparisonResourceMetrics, comparisonResourceAdvantage, comparisonResourcesComparable, requiredSourceReviews } from "./slots.js";

/** Model-facing and local validation share the same program-owned row identities. */
export function comparisonSubmissionSchema(request: AgentRequest) {
  const result = structuredClone(schema), slots = comparisonSlots(request);
  Object.assign(result.properties.comparisons, { minItems: slots.length, maxItems: slots.length,
    prefixItems: slots.map(slot => ({ $ref: `#/$defs/${slot.kind === "resource" ? "resource" : "commentary"}` })) });
  return result;
}

/** Preserve source core context; failure refs include only proven requirements common to this pair. */
export function comparisonCoreFailureRefs(input: ComparisonInput, candidate: string): string[] {
  const attribution = input.attributions[candidate];
  if (attribution?.core_assessment.meets_core !== false) return [];
  const requirements = new Map(input.task_analysis.requirements.map(criterion => [criterion.id, criterion]));
  return attribution.core_assessment.criterion_ids.filter(id => {
    const criterion = requirements.get(id);
    if (!criterion || !criterionAppliesToPair(input, criterion)) return false;
    const facts = attribution.criterion_assessments.filter(fact => fact.criterion_id === id);
    return facts.length === 1 && facts[0].evidence_status === "established" && ["unmet", "partial"].includes(facts[0].status);
  });
}

/** Source review results never fabricate a comparative verdict. */
export function pendingComparison(request: AgentRequest, summaries: Record<string, { summary: string }>, reviews: ComparisonResult["review_requests"]): ComparisonResult {
  const input = request.input as unknown as ComparisonInput;
  const assessments = Object.fromEntries(Object.entries(summaries).map(([label, item]) => {
    const reviewed = reviews.some(review => review.candidate === label), source = input.attributions[label]?.core_assessment;
    const meets_core = reviewed ? null : source?.meets_core ?? null;
    return [label, { summary: item.summary, meets_core, core_failure_refs: meets_core === false ? comparisonCoreFailureRefs(input, label) : [] }];
  }));
  return { status: "needs_review", review_requests: structuredClone(reviews), assessments,
    task_analysis: structuredClone(input.task_analysis), ranking: [],
    decision_basis: { comparisons: [], decisive_findings: [], tradeoff: comparisonText("review_pending") } };
}

export function resolveComparison(request: AgentRequest, draft: unknown): ComparisonResult {
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(comparisonSubmissionSchema(request));
  if (!validator(draft)) throw new ValidationError(schemaIssues(validator.errors, draft));
  const value = draft as unknown as ComparisonSubmission, input = request.input as unknown as ComparisonInput;
  const preference = value.preference ?? null;
  const labels = Object.keys(input.candidates), slots = comparisonSlots(request);
  const reviews = requiredSourceReviews(request);
  if (reviews.length) return pendingComparison(request, Object.fromEntries(labels.map(label => [label, { summary: label === "A" ? value.a_summary : value.b_summary }])), reviews);
  const rowIssues: ValidationIssue[] = [];
  const comparisons = value.comparisons.flatMap((row,index) => {
    const slot = slots[index];
    if (row === null) {
      if (slot.optional) return [];
      rowIssues.push({ category: "decision", code: "comparison_slot_required", path: `/comparisons/${index}`,
        message: "本槽位为必需要求、优点、中高重要性问题或已记录的资源指标，须保留双方评审；仅 optional 槽可填 null。" });
      return [];
    }
    const betterCandidate = slot.kind === "resource" ? comparisonResourceAdvantage(input) : row.better_candidate ?? null;
    if (betterCandidate && !slot.shared) rowIssues.push({ category: "decision", code: "comparison_advantage_scope_mismatch",
      path: `/comparisons/${index}/better_candidate`, message: "该槽位属于候选专有要求；相对优势只可用于共同适用方面，保留本行并填 better_candidate=null。" });
    const resolved = { aspect: slot.aspect, criterion_ids: [...slot.criterion_ids], importance: row.importance,
      better_candidates: betterCandidate ? [betterCandidate] : [],
      assessments: Object.fromEntries(labels.map(label => {
        const state = comparisonSlotCellState(input,label,slot);
        return [label, { summary: slot.kind === "resource" ? comparisonResourceText(comparisonResourceMetrics(input,label))
          : state.status === "not_applicable" ? comparisonText("not_applicable") : comparisonSlotSummary(input,label,slot),
          finding_indices: [...slot.finding_indices[label]], ...state }];
      })) };
    if (betterCandidate && slot.shared && !comparisonAdvantageCandidates(resolved.assessments,
      slot.kind !== 'resource' || comparisonResourcesComparable(input)).includes(betterCandidate))
      rowIssues.push({ category: "decision", code: "comparison_advantage_unproven", path: `/comparisons/${index}/better_candidate`,
        message: "相对优势需要双方在同一标准下都有已确认的事实；未知或不适用不能推定落后。保留本槽，better_candidate=null，点评由已接受事实呈现。" });
    return [resolved];
  });
  if (rowIssues.length) throw new ValidationError(rowIssues);
  const assessments = Object.fromEntries(labels.map(label => {
    const meets_core = input.attributions[label].core_assessment.meets_core;
    return [label, { summary: (label === "A" ? value.a_summary : value.b_summary), meets_core,
      core_failure_refs: meets_core === false ? comparisonCoreFailureRefs(input,label) : [] }];
  }));
  const failed = labels.filter(label => assessments[label].meets_core === false), passed = labels.filter(label => assessments[label].meets_core === true);
  const advantages = labels.filter(label => comparisons.some(row => row.importance !== "low" && row.better_candidates.includes(label)));
  let ranking: string[][];
  if (failed.length === labels.length) ranking = [labels];
  else if (failed.length) ranking = [passed, failed];
  else if (preference && advantages.includes(preference)) ranking = [[preference], labels.filter(label => label !== preference)];
  else if (preference) throw new ValidationError([{ category: "decision", code: "preference_unproven", path: "/preference",
    message: "偏好须有该候选已确认的中高重要性共同优势支持；没有实质优势时 preference=null。" }]);
  else ranking = [labels];
  const decisive_findings = comparisons.flatMap(row => row.importance === "low" || !row.better_candidates.length ? [] : labels.flatMap(candidate =>
    row.assessments[candidate].finding_indices.flatMap(finding_index => {
      const finding = input.attributions[candidate].findings[finding_index];
      return finding.assessment.evidence_status === "established" ? [{ candidate, finding_index }] : [];
    }))).filter((ref,index,all) => all.findIndex(item => item.candidate === ref.candidate && item.finding_index === ref.finding_index) === index).slice(0,24);
  const resources = comparisons.find(row => !row.criterion_ids.length &&
    Object.values(row.assessments).every(cell => !cell.finding_indices.length));
  const tradeoff = labels.map(candidate => comparisonText("tradeoff_candidate")
    .replace("{candidate}", candidate).replace("{reason}", () => candidate === "A" ? value.a_tradeoff : value.b_tradeoff) +
    (resources ? " " + resources.assessments[candidate].summary : "")).join(" ");
  return { status: "decided", review_requests: [], task_analysis: structuredClone(input.task_analysis), assessments, ranking,
    decision_basis: { tradeoff: (ranking.length === 1
      ? comparisonText("relative_preference").replace("{candidate}", value.relative_preference) : "") + tradeoff,
      comparisons, decisive_findings } };
}
