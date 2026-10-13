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
      highlights?: { evidence?: string | null; impact?: string | null } | null;
    }[];
  }[];
  reason: string;
  reasonHighlight?: string | null;
  caveat?: string;
}

interface FormalPair {
  result: string;
  resultLabel: string;
  models: { model: string; modelName: string; result: "win" | "loss" | "both_good" | "both_bad" }[];
}

/** Ignore presentation differences while retaining offsets into the untouched source. */
function highlightText(text: string) {
  let value = "", offset = 0;
  const spans: { start: number; end: number }[] = [];
  for (const char of text) {
    const start = offset;
    offset += char.length;
    const normalized = /\s/u.test(char) ? " " : /[！-～]/u.test(char) ? String.fromCharCode(char.charCodeAt(0) - 0xfee0) : char;
    if (normalized === " " && value.endsWith(" ")) { spans[spans.length - 1]!.end = offset; continue; }
    value += normalized;
    for (let index = 0; index < normalized.length; index++) spans.push({ start, end: offset });
  }
  return { value, spans };
}

function highlightSpan(text: string, supplied: string): string | undefined {
  let phrase = supplied.trim();
  if (!phrase) return undefined;
  const exact = text.indexOf(phrase);
  if (exact >= 0) return exact === text.lastIndexOf(phrase) ? phrase : undefined;
  for (const marker of ["**", "__", "`", "=="]) {
    if (phrase.startsWith(marker) && phrase.endsWith(marker) && phrase.length > marker.length * 2) {
      phrase = phrase.slice(marker.length, -marker.length).trim();
      break;
    }
  }
  const source = highlightText(text), target = highlightText(phrase).value;
  const start = source.value.indexOf(target);
  if (!target || start < 0 || start !== source.value.lastIndexOf(target)) return undefined;
  return text.slice(source.spans[start]!.start, source.spans[start + target.length - 1]!.end);
}

/** The accepted pair owns template order, identities and verdict. */
export function comparisonDiagram(input: ComparisonDiagramInput, receipt: JsonObject) {
  if (new Set(input.candidates.map(candidate => candidate.model)).size !== 2)
    throw new Error("比较图需要两个不同的模型");
  const omittedHighlights: string[] = [];
  let remainingHighlights = 2;
  const highlight = (text: string, phrase: string | null | undefined, field: string, available = true) => {
    if (phrase == null) return undefined;
    const span = available && remainingHighlights > 0 ? highlightSpan(text, phrase) : undefined;
    if (span !== undefined && Array.from(span).length <= 16) {
      remainingHighlights--;
      return span;
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
