import { messageContentSources, sourceTextBlocks, traceComponentIdentities, traceExchanges } from "@eval/tools";
import type { ComponentReviewScope, Message } from "./types.js";

/** Answer subsections are independent review units; normative-source blocks are not. */
function finalSections(text: string) {
  const starts = [0];
  let offset = 0, fence: string | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = line.match(/^[\t ]{0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    } else if (!fence && offset && /^[\t ]{0,3}#{1,6}[\t ]+\S/u.test(line)) starts.push(offset);
    offset += line.length;
  }
  return starts.flatMap((start, index) => sourceTextBlocks(text.slice(start, starts[index + 1] ?? text.length))
    .map(block => ({ ...block, start: block.start + start, end: block.end + start })));
}

/** Bound work by actual calls; a shared semantic tool name is not an execution boundary. */
export function traceComponentScopes(messages: Message[], finalIndex: number, inputId: string): ComponentReviewScope[] {
  const exchanges = traceExchanges(messages), scopes: ComponentReviewScope[] = [];
  for (const actor of traceComponentIdentities({ messages }, inputId, finalIndex)) {
    if (actor.role === "final_answer") continue;
    const seen = new Set<number>();
    for (const index of actor.message_indices) {
      if (seen.has(index)) continue;
      const exchange = actor.kind === "tool" ? exchanges.find(item => item.request_index === index || item.return_indices.includes(index)) : undefined;
      const indices = exchange ? [exchange.request_index, ...exchange.return_indices] : [index];
      indices.forEach(index => seen.add(index));
      scopes.push({ component: actor.component, message_indices: indices });
    }
  }
  // Keep headings, tables and their conditions together. Short adjacent sections share one task.
  let ranges: NonNullable<ComponentReviewScope["final_ranges"]> = [], chars = 0;
  const flush = () => {
    if (ranges.length) scopes.push({ component: "终稿生成轮", message_indices: [finalIndex], final_ranges: ranges });
    ranges = []; chars = 0;
  };
  for (const source of messageContentSources(messages[finalIndex])) {
    for (const block of finalSections(source.text)) {
      if (chars && chars + block.quote.length > 1600) flush();
      ranges.push({ path: source.path, start: block.start, end: block.end });
      chars += block.quote.length;
    }
  }
  flush();
  if (!scopes.some(scope => scope.component === "终稿生成轮"))
    scopes.push({ component: "终稿生成轮", message_indices: [finalIndex] });
  return scopes;
}
