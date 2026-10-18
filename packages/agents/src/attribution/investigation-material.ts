import type { JsonObject } from "@eval/contracts";

type Row = Record<string, any>;

/** One visible answer and an independently addressable rule directory. No inferred claims or verdicts. */
export function investigationMaterial(input: JsonObject): JsonObject {
  const answer = input.answer as Row, focus = input.task_focus as Row | undefined;
  if (!focus || !Array.isArray(answer.review_sections) || !answer.review_sections.length) return input;
  const citations = answer.citation_inventory as Row;
  const review: Row[] = [], displayed = new Set<string>(), linked = new Set<number>();
  for (const { citation_indices, ...section } of answer.review_sections as Row[]) {
    review.push({ kind: "answer", ...section });
    for (const index of citation_indices as number[]) {
      linked.add(index);
      const citation = citations.references[index - 1] as Row;
      for (const source of citation.sources as Row[]) {
        const evidenceKey = JSON.stringify(source.reference);
        const link = { section_index: section.section_index, citation: citation.reference, format: citation.format, status: citation.status };
        if (displayed.has(evidenceKey)) review.push({ kind: "source_link", ...link, reference: source.reference });
        else {
          const { quote_preview, ...rest } = source;
          review.push({ kind: "source", ...link, ...rest, ...(quote_preview ? { quote: quote_preview } : {}) });
          displayed.add(evidenceKey);
        }
      }
      if (!citation.sources.length) review.push({ kind: "source_link", section_index: section.section_index,
        citation: citation.reference, format: citation.format, status: citation.status });
    }
  }
  const ruleSources: Row[] = [], ruleSections: Row[] = [], indices = new Map<string, number>();
  const findingBasis = (input.finding_basis as Row[]).map(({ evidence, ...basis }) => ({ ...basis,
    source_indices: (evidence as Row[]).map(source => {
      const evidenceKey = JSON.stringify(source.reference);
      const existing = indices.get(evidenceKey);
      if (existing !== undefined) return existing;
      const sourceIndex = ruleSources.length + 1;
      indices.set(evidenceKey, sourceIndex);
      const { outline, ...origin } = source;
      ruleSources.push({ source_index: sourceIndex, ...origin });
      const start = source.start_offset ?? source.read_request?.offset ?? 0;
      const headings: Row[] = outline?.length ? outline : [{ offset: start,
        title: String(source.quote ?? source.quote_preview ?? basis.text).split('\n')[0]!.slice(0, 120) }];
      const level = (title: string) => /^(#{1,6}) /u.exec(title)?.[1]!.length ?? 7;
      headings.forEach((heading, index) => {
        const end = headings.slice(index + 1).find(next => level(next.title) <= level(heading.title))?.offset ?? source.end_offset;
        ruleSections.push({ rule_index: ruleSections.length + 1, source_index: sourceIndex,
          title: heading.title, start: heading.offset, end });
      });
      return sourceIndex;
    }),
  }));
  const { final_answer: _final, review_sections: _sections, citation_inventory: _citations, ...answerRest } = answer;
  const { final_answer: _focusFinal, ...focusAnswer } = focus.answers.answer;
  return { ...input, answer: { ...answerRest, citation_inventory: { ...citations,
    references: citations.references.filter((_row: Row, index: number) => !linked.has(index + 1)) } },
    finding_basis: findingBasis, rule_sources: ruleSources,
    task_focus: { ...focus, answers: { ...focus.answers, answer: { ...focusAnswer, review } }, rule_sections: ruleSections } };
}
