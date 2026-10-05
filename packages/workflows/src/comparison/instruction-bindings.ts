import type { TaskAnalysis } from "@eval/contracts";
import { cite, evidenceSources, hasSourceTextBlock, normativeSources, sourceContentBlocks } from "@eval/tools";

/** Bind the accepted original catalogue to complete original paragraphs at real leaf paths. */
export function criterionInstructionSources(
  raw: { messages: unknown[] }, finalIndex: number, task: TaskAnalysis, candidateId: string,
) {
  const sources = normativeSources(raw, candidateId, finalIndex).map(source => ({ message_index: source.message_index,
    blocks: sourceContentBlocks(source.content, source.path) }));
  return Object.fromEntries([...task.requirements, ...task.scoring_points, ...task.red_flags].flatMap(criterion => {
    if (criterion.applies_to.length && !criterion.applies_to.includes(candidateId)) return [];
    const origins = sources.flatMap(source => source.blocks.filter(block => hasSourceTextBlock(criterion.text, block.quote))
      .flatMap(block => block.origins.map(original => {
        const leaf = evidenceSources(raw.messages[source.message_index]).find(leaf => leaf.kind === "text" && leaf.path === original.path)!;
        return { ...cite(candidateId, source.message_index, leaf, original.start, original.end), path: original.path };
      })));
    const unique = origins.filter((origin, index) => origins.findIndex(other => other.evidence_id === origin.evidence_id) === index);
    return unique.length ? [[criterion.id, unique]] : [];
  }));
}
