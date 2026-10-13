import type { AnalysisCaseLookup, JsonObject } from "@eval/contracts";

export interface ComparisonDiagramInput {
  complete?: boolean;
  reference: { runId: string; taskId: string } | AnalysisCaseLookup;
  title: string;
  candidates: {
    model: string;
    summary: string;
    paths: {
      title: string;
      evidence: string;
      counterEvidence?: string | null;
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

/** The accepted pair owns template order, identities and verdict. */
export function comparisonDiagram(input: ComparisonDiagramInput, receipt: JsonObject) {
  if (new Set(input.candidates.map(candidate => candidate.model)).size !== 2)
    throw new Error("比较图需要两个不同的模型");
  const omittedHighlights: string[] = [];
  let remainingHighlights = 2;
  const highlight = (text: string, phrase: string | undefined, field: string, available = true) => {
    if (phrase === undefined) return undefined;
    if (available && remainingHighlights > 0 && phrase.trim() && Array.from(phrase).length <= 16
      && text.indexOf(phrase) >= 0 && text.indexOf(phrase) === text.lastIndexOf(phrase)) {
      remainingHighlights--;
      return phrase;
    }
    omittedHighlights.push(field);
    return undefined;
  };
  const reasonHighlight = highlight(input.reason, input.reasonHighlight, "reasonHighlight");
  const candidates = input.candidates.map((candidate, candidateIndex) => ({ ...candidate, paths: candidate.paths.map(({ counterEvidence, highlights, ...path }, pathIndex) => {
    const evidence = counterEvidence == null ? path.evidence : `${path.evidence}；${counterEvidence}`;
    let available = true;
    const accepted = Object.fromEntries((["evidence", "impact"] as const).flatMap(field => {
      const phrase = highlight(field === "evidence" ? evidence : path.impact, highlights?.[field], `candidates[${candidateIndex}].paths[${pathIndex}].highlights.${field}`, available);
      if (phrase !== undefined) available = false;
      return phrase === undefined ? [] : [[field, phrase]];
    }));
    return { ...path, evidence, ...(Object.keys(accepted).length ? { highlights: accepted } : {}) };
  }) }));
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
  return { omittedHighlights, diagram: {
    title: input.title,
    candidates: pair.models.map(model => ({ ...candidates.find(candidate => candidate.model === model.model)!, name: model.modelName, outcome: model.result })),
    verdict: pair.resultLabel,
    reason: input.reason,
    ...(reasonHighlight === undefined ? {} : { reasonHighlight }),
    ...(input.caveat === undefined ? {} : { caveat: input.caveat }),
  } };
}
