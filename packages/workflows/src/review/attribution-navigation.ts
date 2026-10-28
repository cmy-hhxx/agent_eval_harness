import { cite, evidenceSources, selectEvidenceSource, displayEvidence, images, overlapsImagePlaceholder, visualCaptureMarkers } from "@eval/tools";
import type { RawInput, ComponentReviewScope } from "../inputs/types.js";

/** Explicit allowlist: new canonical fields cannot silently inflate the model context. */
export function initialAttributionMaterial(finalIndex: number, raw: RawInput, inputId: string, scope: ComponentReviewScope) {
  const candidate = "answer";
  const finalReview = !scope || scope.message_indices.includes(finalIndex);
  const imageCount = finalReview ? images(raw.messages[finalIndex]).length : 0;
  const gaps = finalReview ? visualCaptureMarkers(raw.messages[finalIndex]) : [];
  const finalEvidence = scope?.final_ranges ? scope.final_ranges.flatMap(range => {
    const source = evidenceSources(raw.messages[finalIndex]).find(source => source.kind === "text" && source.path === range.path);
    if (!source || range.start < 0 || range.end > source.text.length || range.end <= range.start)
      throw new Error("归因原子任务的终稿范围与原文不一致");
    const entries = [];
    // A chart resource may contain tens of thousands of encoded data/style bytes.
    // Keep its ownership intact, but defer the tail instead of flooding the first prompt.
    for (let start = range.start; start < Math.min(range.end, range.start + 1600); start += 400)
      entries.push(cite(inputId, finalIndex, source, start, Math.min(range.end, start + 400)));
    return entries;
  }) : finalReview ? evidenceSources(raw.messages[finalIndex]).filter(source => source.kind === "text" && source.path.startsWith("/content"))
    .flatMap(source => { const entries = []; for (let start = 0; start < Math.min(1600, source.text.length); start += 400)
      entries.push(cite(inputId, finalIndex, source, start, Math.min(source.text.length, start + 400))); return entries; }) : [];
  return {
    ...(finalReview ? { final_message_index: finalIndex } : {}),
    // Original final text occurs once and only these displayed ranges count as read.
    final_evidence: finalEvidence.map(displayEvidence),
    ...(scope?.final_ranges ? { final_context: {
      partial: scope.final_ranges.some(range => range.end - range.start > 1600),
      continuations: scope.final_ranges.filter(range => range.end - range.start > 1600).map(range => ({
        end_offset: range.end, read_request: { candidate, message_index: finalIndex, path: range.path,
          offset: range.start + 1600, max_chars: Math.min(16000, range.end - range.start - 1600) },
      })),
    } } : {}),
    ...(imageCount ? { final_images: { image_count: imageCount, view_request: { candidate, message_index: finalIndex } } } : {}),
    ...(gaps.length ? { capture_gaps: gaps.map(({ path, status, resource_ref }) => ({ message_index: finalIndex, path, status, resource_ref })) } : {}),
  };
}

/** Preload a bounded part of the selected component, with exact original coordinates. */
export function initialComponentScene(raw: RawInput, original: RawInput, inputId: string,
  component: string, scope: ComponentReviewScope) {
  const entries = [];
  const unread: { end_offset: number; read_request: { candidate: string; message_index: number; path: string; offset: number; max_chars: number } }[] = [];
  const seen = new Set<string>();
  let remaining = 12000;
  // Show every selected step's actual arguments and result before expanding input history.
  // Register only exact bytes that survive the public projection at the same coordinates.
  for (const keys of [["input", "arguments", "output", "result", "content"], ["input_messages"]])
  for (const messageIndex of scope?.message_indices ?? []) {
    const message = raw.messages[messageIndex];
    if (!message) throw new Error("归因原子任务的消息坐标不存在");
    const locations = evidenceSources(message), originals = evidenceSources(original.messages[messageIndex]);
    for (const key of keys) {
      if (!Object.hasOwn(message, key)) continue;
      const value = message[key];
      const whole = selectEvidenceSource(locations, `/${key}`);
      const textBlocks = typeof value === "string" || Array.isArray(value) && value.every(part =>
        part && typeof part === "object" && ["text", "input_text", "output_text"].includes(String(part.type)) && typeof part.text === "string");
      const leaves = key === "input_messages" || textBlocks || whole?.source.quotable === false || whole && overlapsImagePlaceholder(whole.source.text, whole.start, whole.end) ? locations.filter(source => source.kind === "text" && source.quotable !== false &&
        (source.path === `/${key}` || source.path.startsWith(`/${key}/`) && /\/(?:text|content|arguments|reasoning_content)$/u.test(source.path)))
        : [];
      const selected = leaves.length || key === "input_messages" ? leaves.map(source => ({ source, start: 0, end: source.text.length }))
        : [whole].filter(item => item !== undefined);
      for (const item of selected) {
        if (item.source.quotable === false) continue;
        const originalSource = originals.find(source => source.kind === item.source.kind && source.path === item.source.path);
        const shownEnd = Math.min(item.end, item.start + (key === "input_messages" ? remaining : 6000), item.start + remaining);
        if (shownEnd < item.end) unread.push({ end_offset: item.end, read_request: { candidate: "answer",
          message_index: messageIndex, path: item.source.path, offset: shownEnd, max_chars: Math.min(16000, item.end - shownEnd) } });
        for (let start = item.start; start < shownEnd; start += 400) {
          const end = Math.min(shownEnd, start + 400), evidence = cite(inputId, messageIndex, item.source, start, end);
          if (!evidence.quote || overlapsImagePlaceholder(item.source.text, start, end) ||
            evidence.quote !== originalSource?.text.slice(start, end) || seen.has(evidence.evidence_id)) continue;
          seen.add(evidence.evidence_id); remaining -= end - start;
          const hasMore = end === shownEnd && end < item.end;
          entries.push({ part: key, ...displayEvidence(evidence), end_offset: item.end, has_more: hasMore,
            ...(hasMore ? { next_request: { candidate: "answer", message_index: messageIndex,
              path: item.source.path, offset: end, max_chars: Math.min(16000, item.end - end) } } : {}) });
        }
      }
    }
  }
  return { component, partial: unread.length > 0 || entries.some(entry => entry.has_more), entries, unread,
    images: (scope?.message_indices ?? []).flatMap(message_index => {
      const count = images(raw.messages[message_index]).length;
      return count ? [{ message_index, image_count: count, view_request: { candidate: "answer", message_index } }] : [];
    }), context_sources: scope.message_indices.flatMap(message_index => evidenceSources(raw.messages[message_index])
      .filter(source => source.kind === "text" && source.quotable !== false && source.text.length > 0 &&
        (source.path === "/input_messages" || source.path.startsWith("/input_messages/") && /\/(?:content|text)$/u.test(source.path)))
      .map(source => {
        const continuation = unread.find(item => item.read_request.message_index === message_index && item.read_request.path === source.path);
        return { message_index, path: source.path, chars: source.text.length,
          ...(continuation ? { read_request: continuation.read_request } : {}) };
      })) };
}
