import { cite, displayEvidence, messageContentSources, images, visualCaptureMarkers } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

/** Exact final-answer excerpts and visual entrypoints, supplemented by the full process directory. */
export function initialAttributionMaterial(finalIndex: number, raw: RawInput, inputId: string, maxFinalChars = 1600) {
  const final_evidence = messageContentSources(raw.messages[finalIndex]).flatMap(source => {
    const result = [];
    for (let start = 0; start < Math.min(maxFinalChars, source.text.length); start += 400)
      result.push(displayEvidence(cite(inputId, finalIndex, source, start, Math.min(start + 400, source.text.length))));
    return result;
  });
  const continuations = messageContentSources(raw.messages[finalIndex]).filter(source => source.text.length > maxFinalChars).map(source => ({
    end_offset: source.text.length, read_request: { candidate: "answer", message_index: finalIndex, path: source.path,
      offset: maxFinalChars, max_chars: Math.min(16000, source.text.length - maxFinalChars) } }));
  const count = images(raw.messages[finalIndex]).length, gaps = visualCaptureMarkers(raw.messages[finalIndex]);
  return { final_message_index: finalIndex, final_evidence, final_context: { partial: continuations.length > 0, continuations },
    ...(count ? { final_images: { image_count: count, view_request: { candidate: "answer", message_index: finalIndex } } } : {}),
    ...(gaps.length ? { capture_gaps: gaps.map(gap => ({ ...gap, message_index: finalIndex })) } : {}) };
}
