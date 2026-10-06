import type { ComparisonInput, SourceReviewItem } from "@eval/agents/comparison";

/**
 * Program-owned conflict detection for the comparison input.
 *
 * Attributions verify each answer in isolation. When both answers assert different concrete
 * dates for the same common requirement, the two accepted facts cannot both be true; the pair
 * must stay pending instead of being decided from self-confirmed sources. Only explicit date
 * assertions in high-importance, established correctness/completeness strengths are compared,
 * so unrelated differences in coverage or wording never create a conflict.
 */
export interface ContestedFact {
  criterion_id: string;
  criterion_text: string;
  values: Record<string, string[]>;
}

const datePattern = /(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*[日号]|(?<!\d)\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}(?!\d)/gu;

/** Calendar day without the year, so 12月31日 and 2025-12-31 still compare as the same day. */
function monthDay(value: string): string {
  const normalized = value.replace(/\s/gu, "");
  const chinese = /^(?:\d{4}年)?(\d{1,2})月(\d{1,2})[日号]$/u.exec(normalized);
  const iso = /^(?:\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(normalized);
  const match = chinese ?? iso;
  return match ? `${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}` : normalized;
}

function assertedDates(finding: ComparisonInput["attributions"][string]["findings"][number]): string[] {
  if (finding.type !== "strength" || finding.importance !== "high" ||
    !["correctness", "completeness", "instruction_following"].includes(finding.dimension) ||
    finding.assessment.evidence_status !== "established") return [];
  const index = finding.assessment.requirement_index;
  if (index === null || index === undefined) return [];
  return [...new Set([...finding.text.matchAll(datePattern)].map((match) => match[0].replace(/\s/gu, "")))];
}

/** Dates asserted for the same pair-applicable requirement by every candidate, without cross-candidate sharing. */
export function contestedPairFacts(input: Pick<ComparisonInput, "task_analysis" | "candidates" | "attributions">): ContestedFact[] {
  const shared = new Map(input.task_analysis.requirements.map((criterion) => [criterion.id, criterion]));
  const candidates = Object.keys(input.candidates);
  const perCriterion = new Map<string, Record<string, string[]>>();
  for (const [label, attribution] of Object.entries(input.attributions)) {
    const requirementIds = attribution.task_analysis.requirements.map((criterion) => criterion.id);
    for (const finding of attribution.findings) {
      const index = finding.assessment.requirement_index;
      if (index === null || index === undefined) continue;
      const criterion = shared.get(requirementIds[index] ?? "");
      if (!criterion || criterion.applies_to.length) continue;
      const values = assertedDates(finding);
      if (!values.length) continue;
      const facts = perCriterion.get(criterion.id) ?? {};
      facts[label] = [...new Set([...(facts[label] ?? []), ...values])];
      perCriterion.set(criterion.id, facts);
    }
  }
  return [...perCriterion].flatMap(([criterion_id, values]) => {
    if (!candidates.every((label) => values[label]?.length)) return [];
    const days = candidates.map((label) => new Set(values[label].map(monthDay)));
    const overlap = days.some((set, index) => days.some((other, otherIndex) => otherIndex > index && [...set].some((day) => other.has(day))));
    return overlap ? [] : [{ criterion_id, criterion_text: shared.get(criterion_id)!.text, values }];
  });
}

/** Blocking review items keep the pair pending; the comparison still runs but cannot decide it. */
export function contestedFactReviews(facts: ContestedFact[], labels: string[]): Record<string, SourceReviewItem[]> {
  if (!facts.length) return {};
  const reason = (fact: ContestedFact) => `共同要求「${fact.criterion_id}：${fact.criterion_text}」双方给出不同结论：` +
    labels.map((label) => `${label}=${fact.values[label]!.join("、")}`).join("；") +
    "。双方结论不能同时成立，须独立复核哪一方正确后再判胜负；本对局暂不给出判决。";
  return Object.fromEntries(labels.map((label) => [label, facts.map((fact) => ({
    kind: "unresolved_conflict" as const, requires_review: true, reason: reason(fact),
  }))]));
}
