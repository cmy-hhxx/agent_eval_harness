import type { JsonObject } from "@eval/contracts";

export interface ComparisonDiagramInput {
  reference: { runId: string; taskId: string };
  title: string;
  candidates: {
    model: string;
    summary: string;
    paths: {
      title: string;
      evidence: string;
      impact: string;
      assessment: "strength" | "problem" | "uncertain";
      highlights?: { evidence?: string; impact?: string };
    }[];
  }[];
  reason: string;
  reasonHighlight?: string;
  caveat?: string;
}

interface FormalPair {
  result: string;
  resultLabel: string;
  models: { model: string; modelName: string; result: "win" | "loss" | "both_good" | "both_bad" }[];
}

function validateHighlight(text: string, highlight: string | undefined, field: string) {
  if (highlight !== undefined && (text.indexOf(highlight) < 0 || text.indexOf(highlight) !== text.lastIndexOf(highlight)))
    throw new Error(`${field} 高亮必须是对应原文中唯一出现的连续片段`);
}

/** The accepted pair owns template order, identities and verdict. */
export function comparisonDiagram(input: ComparisonDiagramInput, receipt: JsonObject) {
  if (new Set(input.candidates.map(candidate => candidate.model)).size !== 2)
    throw new Error("比较图需要两个不同的模型");
  const highlightCount = input.candidates.flatMap(candidate => candidate.paths)
    .reduce((count, path) => count + Object.keys(path.highlights ?? {}).length, Number(input.reasonHighlight !== undefined));
  if (highlightCount > 2) throw new Error("比较图最多2处高亮（含顶部理由），只保留决定性差异");
  input.candidates.forEach((candidate, candidateIndex) => candidate.paths.forEach((path, pathIndex) => {
    for (const field of ["evidence", "impact"] as const)
      validateHighlight(path[field], path.highlights?.[field], `candidates[${candidateIndex}].paths[${pathIndex}].highlights.${field}`);
  }));
  validateHighlight(input.reason, input.reasonHighlight, "reasonHighlight");
  const scope = receipt.comparisonScope as { comparisons?: FormalPair[] } | undefined;
  const pairs = scope?.comparisons?.filter(pair => pair.models.length === 2
    && input.candidates.every(candidate => pair.models.some(model => model.model === candidate.model))) ?? [];
  const pair = pairs[0];
  if (receipt.kind !== "accepted-result" || !receipt.result || pairs.length !== 1 || !pair
    || !["win", "both_good", "both_bad"].includes(pair.result)
    || typeof pair.resultLabel !== "string" || !pair.resultLabel.trim()
    || pair.models.some(model => typeof model.modelName !== "string" || !model.modelName.trim()
      || !["win", "loss", "both_good", "both_bad"].includes(model.result)))
    throw new Error("比较图必须引用候选模型对应的唯一已决正式对局");
  return {
    title: input.title,
    candidates: pair.models.map(model => ({ ...input.candidates.find(candidate => candidate.model === model.model)!, name: model.modelName, outcome: model.result })),
    verdict: pair.resultLabel,
    reason: input.reason,
    ...(input.reasonHighlight === undefined ? {} : { reasonHighlight: input.reasonHighlight }),
    ...(input.caveat === undefined ? {} : { caveat: input.caveat }),
  };
}
