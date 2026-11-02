export interface VerdictDecision {
  outcome: "win" | "both_good" | "both_bad";
  winner: "first" | "second" | null;
  /** Why a winner exists; drives the reason premise. */
  basis: "core" | "tier" | "incomplete" | null;
}
/** Tier index per blind label; best tier is 0. */
export function tierOf(ranking: string[][]): Map<string, number> {
  const tiers = new Map<string, number>();
  ranking.forEach((tier, index) => tier.forEach((label) => tiers.set(label, index)));
  return tiers;
}
/** Core completion plus tier position decide every two-way outcome; nothing else. */
export function decideVerdict(
  firstMeetsCore: boolean,
  secondMeetsCore: boolean,
  firstTier: number,
  secondTier: number,
): VerdictDecision {
  if (firstMeetsCore !== secondMeetsCore)
    return { outcome: "win", winner: firstMeetsCore ? "first" : "second", basis: "core" };
  if (firstTier !== secondTier)
    return { outcome: "win", winner: firstTier < secondTier ? "first" : "second", basis: firstMeetsCore ? "tier" : "incomplete" };
  if (!firstMeetsCore) return { outcome: "both_bad", winner: null, basis: null };
  return { outcome: "both_good", winner: null, basis: null };
}
/** Reason text for a decision; candidate labels stay blind until display mapping. */
export function verdictReason(decision: VerdictDecision, first: string, second: string): string {
  if (decision.outcome === "both_bad") return "双方都未完成核心要求，没有实质胜者。";
  if (decision.outcome === "both_good") return "双方都完成核心要求且没有实质差异。";
  const winner = decision.winner === "first" ? first : second;
  if (decision.basis === "incomplete") return `双方均未完成核心要求，【候选${winner}】相对更好，但仍不可直接使用。`;
  if (decision.basis === "core") {
    const loser = decision.winner === "first" ? second : first;
    return `【候选${winner}】完成核心要求而【候选${loser}】未完成。`;
  }
  return `双方都完成核心要求，【候选${winner}】实际可用性更优。`;
}
