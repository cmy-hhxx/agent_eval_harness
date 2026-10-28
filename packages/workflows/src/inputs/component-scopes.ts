import { messageContentSources, traceComponentIdentities } from "@eval/tools";
import type { ComponentReviewScope, Message } from "./types.js";

/** Preserve component ownership across the trace's goal; messages are evidence, not sessions. */
export function traceComponentScopes(messages: Message[], finalIndex: number, inputId: string): ComponentReviewScope[] {
  const scopes = traceComponentIdentities({ messages }, inputId, finalIndex)
    .filter(actor => actor.role !== "final_answer")
    .map(actor => ({ component: actor.component, message_indices: actor.message_indices }));
  return [...scopes, { component: "终稿生成轮", message_indices: [finalIndex],
    final_ranges: messageContentSources(messages[finalIndex])
      .map(source => ({ path: source.path, start: 0, end: source.text.length })).filter(range => range.end > 0) }];
}
