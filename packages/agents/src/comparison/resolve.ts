import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { comparisonText, comparisonResourceText } from "@eval/prompts";
import schema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import type { ComparisonInput, ComparisonResult, ComparisonSubmission } from "./types.js";
import { criterionAppliesToPair } from "./pair-scope.js";
import { comparisonDecisiveFindings } from "./result-checks.js";
import { comparisonSlots, comparisonSlotChoices, comparisonSlotCellState, comparisonAdvantageCandidates, comparisonResourceMetrics, comparisonResourceAdvantage, comparisonResourcesComparable, requiredSourceReviews } from "./slots.js";

/** Model-facing and local validation share the same program-owned row identities. */
export function comparisonSubmissionSchema(request: AgentRequest) {
  const result = structuredClone(schema) as Record<string, any>, slots = comparisonSlots(request);
  const labels = Object.keys((request.input as unknown as ComparisonInput).candidates);
  const rowSchemas = (["criterion", "resource"] as const).flatMap(kind => {
    const indices = slots.flatMap((slot, index) => slot.kind === kind ? [index] : []);
    if (!indices.length) return [];
    const row = structuredClone(kind === "resource" ? schema.$defs.resource : schema.$defs.commentary) as Record<string, any>;
    row.properties.slot_index = { enum: indices };
    if (kind === "criterion") {
      row.properties.better_candidate = { enum: [...labels, null] };
    }
    return [row];
  });
  const requiredSlots = slots.filter(slot => !slot.optional).length;
  Object.assign(result.properties.comparisons, { minItems: requiredSlots, maxItems: slots.length, items: { oneOf: rowSchemas } });
  result.properties.quality_winner = { enum: [...labels, null] };
  result.properties.source_reviews.items.properties.candidate = { enum: labels };
  const scopeSlots = slots.flatMap((slot, index) => slot.kind === "criterion" && slot.shared && slot.criterion_ids.length ? [index] : []);
  if (scopeSlots.length) Object.assign(result.properties.scope_conflicts.items.properties.slot_index, { enum: scopeSlots });
  else Object.assign(result.properties.scope_conflicts, { maxItems: 0 });
  const reviewSlots = comparisonSlotChoices(request).filter(slot => slot.reviewable_candidates.length).map(slot => slot.slot_index);
  if (reviewSlots.length) Object.assign(result.properties.source_reviews.items.properties.slot_index, { enum: reviewSlots });
  else Object.assign(result.properties.source_reviews, { maxItems: 0 });
  return result;
}

/** Source review results never fabricate a comparative verdict. */
export function pendingComparison(request: AgentRequest, summaries: Record<string, { summary: string }>, reviews: ComparisonResult["review_requests"]): ComparisonResult {
  const input = request.input as unknown as ComparisonInput;
  const assessments = Object.fromEntries(Object.entries(summaries).map(([label,item])=>[label,{
    summary:item.summary,meets_core:null,core_failure_refs:[],
  }]));
  return { status: "needs_review", review_requests: structuredClone(reviews), assessments,
    task_analysis: structuredClone(input.task_analysis), ranking: [],
    decision_basis: { comparisons: [], decisive_findings: [], tradeoff: comparisonText("review_pending") } };
}

export function resolveComparison(request: AgentRequest, draft: unknown): ComparisonResult {
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(comparisonSubmissionSchema(request));
  if (!validator(draft)) throw new ValidationError(schemaIssues(validator.errors, draft));
  const flat = draft as Record<string, any>, input = request.input as unknown as ComparisonInput;
  const sourceSlots = comparisonSlots(request);
  const value: ComparisonSubmission = {
    ...flat,
    relative_preference: flat.relative_preference, tradeoff: flat.tradeoff,
    assessments: (["A", "B"] as const).map(candidate => {
      const side = candidate.toLowerCase();
      return { candidate, meets_core: flat[`${side}_core`], core_failure_refs: flat[`${side}_core_refs`], summary: flat[`${side}_summary`] };
    }),
    comparisons: flat.comparisons.map((row: Record<string, any>) => ({
      slot_index: row.slot_index, kind: sourceSlots[row.slot_index].kind, importance: row.importance,
      better_candidate: row.better_candidate,
      ...(sourceSlots[row.slot_index].kind === "criterion" ? { assessments: (["A", "B"] as const).map(candidate => {
        const side = candidate.toLowerCase();
        const status = row[`${side}_status`], findings: number[] = row[`${side}_findings`];
        const evidence_status = status === "unknown" || findings.some(index =>
          input.attributions[candidate].Problem[index]?.evidence_status === "待核实") ? "待核实" : "已确认";
        return { candidate, status, evidence_status, summary: row[`${side}_summary`], finding_indices: findings };
      }) } : {}),
    })),
  };
  const qualityWinner = value.quality_winner ?? null;
  const labels = Object.keys(input.candidates), slots = comparisonSlots(request);
  const rowIssues: ValidationIssue[] = [];
  const assessments = Object.fromEntries(value.assessments.map(({ candidate, ...assessment }) => [candidate, assessment]));
  const reviews = requiredSourceReviews(request);
  const conflicts = value.scope_conflicts ?? [], conflictIssues: ValidationIssue[] = [], selected = new Set<number>();
  if (conflicts.length && (qualityWinner !== null || value.relative_preference !== null))
    conflictIssues.push({ category: "decision", code: "scope_conflict_preference", path: "/scope_conflicts",
      message: "共同口径尚未统一时不能同时给出正式或相对偏好；quality_winner 省略或填 null，relative_preference=null。" });
  conflicts.forEach((conflict, index) => {
    if (selected.has(conflict.slot_index)) conflictIssues.push({ category: "decision", code: "scope_conflict_duplicate",
      path: `/scope_conflicts/${index}/slot_index`, message: "同一共同槽位只提交一次口径冲突，合并说明双方采用的不同口径。" });
    selected.add(conflict.slot_index);
    const slot = slots[conflict.slot_index]; // The request-specific schema permits only existing shared criterion slots.
    reviews.push(...labels.map(candidate => ({ candidate, criterion_ids: [...slot.criterion_ids],
      finding_indices: [...slot.finding_indices[candidate]], reason: conflict.reason.trim() })));
  });
  const sourceReviews = value.source_reviews ?? [], choices = comparisonSlotChoices(request), selectedReviews = new Set<string>();
  if (sourceReviews.length && (qualityWinner !== null || value.relative_preference !== null))
    conflictIssues.push({ category: "decision", code: "source_review_preference", path: "/source_reviews",
      message: "决定性归因尚待核实，quality_winner 省略或填 null，relative_preference=null；不得同时保留胜负或相对偏好。" });
  sourceReviews.forEach((review, index) => {
    const slot = slots[review.slot_index], choice = choices[review.slot_index], key = `${review.slot_index}:${review.candidate}`;
    if (!choice?.reviewable_candidates.includes(review.candidate)) {
      conflictIssues.push({ category: "decision", code: "source_review_candidate", path: `/source_reviews/${index}/candidate`,
        message: "只选择该槽 reviewable_candidates 中的本方候选，不复核资源或不适用的候选。" });
      return;
    }
    if (selectedReviews.has(key) || selected.has(review.slot_index)) {
      conflictIssues.push({ category: "decision", code: "source_review_duplicate", path: `/source_reviews/${index}`,
        message: "同槽同候选只提请一次；已有 scope_conflicts 覆盖双方时，不重复提交 source_reviews。" });
      return;
    }
    selectedReviews.add(key);
    reviews.push({ candidate: review.candidate, criterion_ids: [...slot.criterion_ids],
      finding_indices: [...slot.finding_indices[review.candidate]], reason: review.reason.trim() });
  });
  if (conflictIssues.length) throw new ValidationError(conflictIssues);
  if (rowIssues.length) throw new ValidationError(rowIssues);
  if (reviews.length) return pendingComparison(request, assessments, reviews);
  const submittedRows = new Map<number, { row: ComparisonSubmission["comparisons"][number]; index: number }>();
  for (const [index, row] of value.comparisons.entries()) {
    if (submittedRows.has(row.slot_index))
      rowIssues.push({ category: "decision", code: "comparison_slot_duplicate", path: `/comparisons/${index}/slot_index`,
        message: "同一比较槽位只能提交一次。", actual: row.slot_index });
    else submittedRows.set(row.slot_index, { row, index });
  }
  for (const [index, slot] of slots.entries()) if (!slot.optional && !submittedRows.has(index))
    rowIssues.push({ category: "decision", code: "comparison_slot_required", path: "/comparisons",
      message: "必需要求、优点、中高重要性问题或已记录的资源指标须保留双方评审；仅候选专有槽可省略。",
      actual: [...submittedRows.keys()], expected: slots.flatMap((item, slotIndex) => item.optional ? [] : [slotIndex]) });
  const comparisons = slots.flatMap((slot, slotIndex) => {
    const submitted = submittedRows.get(slotIndex);
    if (!submitted) return [];
    const { row, index } = submitted;
    const betterCandidate = slot.kind === "resource" ? comparisonResourceAdvantage(input) : row.better_candidate ?? null;
    if (betterCandidate && !slot.shared) rowIssues.push({ category: "decision", code: "comparison_advantage_scope_mismatch",
      path: `/comparisons/${index}/better_candidate`, message: "该槽位属于候选专有要求；相对优势只可用于共同适用方面，保留本行并填 better_candidate=null。" });
    let rowAssessments: Record<string, ComparisonResult["decision_basis"]["comparisons"][number]["assessments"][string]>;
    if (slot.kind === "resource") rowAssessments = Object.fromEntries(labels.map(label => [label,
      { summary: comparisonResourceText(comparisonResourceMetrics(input,label)), finding_indices:[],
        ...comparisonSlotCellState(input,label,slot) }]));
    else rowAssessments = Object.fromEntries(row.assessments!.map(({ candidate, ...assessment }) => [candidate, assessment]));
    const resolved = { aspect: slot.aspect, criterion_ids: [...slot.criterion_ids], importance: row.importance,
      better_candidates: betterCandidate ? [betterCandidate] : [],
      assessments: rowAssessments };
    if (betterCandidate && slot.shared && !comparisonAdvantageCandidates(resolved.assessments,
      slot.kind !== 'resource' || comparisonResourcesComparable(input)).includes(betterCandidate))
      rowIssues.push({ category: "decision", code: "comparison_advantage_unproven", path: `/comparisons/${index}/better_candidate`,
        message: "相对优势需要双方在同一标准下都有已确认的事实；未知或不适用不能推定落后。保留本槽，better_candidate=null，点评由已接受事实呈现。" });
    return [resolved];
  });
  if (rowIssues.length) throw new ValidationError(rowIssues);
  const unresolved=labels.filter(label=>assessments[label].meets_core===null);
  if(unresolved.length) return pendingComparison(request,assessments,unresolved.map(candidate=>({candidate,
    criterion_ids:input.task_analysis.requirements.filter(item=>criterionAppliesToPair(input,item)).map(item=>item.id),
    finding_indices:[],reason:assessments[candidate].summary})));
  const failed = labels.filter(label => assessments[label].meets_core === false), passed = labels.filter(label => assessments[label].meets_core === true);
  const advantages = labels.filter(label => comparisons.some(row => row.importance !== "low" && row.better_candidates.includes(label)));
  let ranking: string[][];
  if (failed.length && passed.length) ranking = [passed, failed];
  else if (qualityWinner && advantages.includes(qualityWinner)) ranking = [[qualityWinner], labels.filter(label => label !== qualityWinner)];
  else if (qualityWinner) throw new ValidationError([{ category: "decision", code: "quality_winner_unproven", path: "/quality_winner",
    message: "正式胜者须有该候选已确认的中高重要性共同优势支持；没有实质优势时 quality_winner=null。" }]);
  else ranking = [labels];
  const winner = ranking.length > 1 ? ranking[0][0] : null;
  if (winner && value.relative_preference !== winner) throw new ValidationError([{ category: "decision", code: "relative_preference_winner_mismatch",
    path: "/relative_preference", message: "正式胜者已确定，relative_preference 必须与胜者一致。", expected: winner, actual: value.relative_preference }]);
  const resources = comparisons.find(row => !row.criterion_ids.length &&
    Object.values(row.assessments).every(cell => !cell.finding_indices.length));
  const resourceText = resources ? " " + labels.map(candidate => comparisonText("tradeoff_candidate")
    .replace("{candidate}", candidate).replace("{reason}", () => resources.assessments[candidate].summary)).join(" ") : "";
  const result: ComparisonResult = { status: "decided", review_requests: [], task_analysis: structuredClone(input.task_analysis), assessments, ranking,
    decision_basis: { tradeoff: (ranking.length === 1 && value.relative_preference
      ? comparisonText("relative_preference").replace("{candidate}", value.relative_preference) : "") + value.tradeoff.trim() + resourceText,
      comparisons, decisive_findings: [] } };
  result.decision_basis.decisive_findings = comparisonDecisiveFindings(input, result);
  return result;
}
