import { overlapsImagePlaceholder, parseEvidenceCoordinates } from "@eval/contracts";
import { evidenceSources, selectEvidenceSource } from "./evidence.js";

/** Mechanical containment of real physical coordinates; display quotes never identify a source. */
export function evidenceCovers(raw: { messages: unknown[] }, inputId: string, coveringId: string, coveredId: string): boolean {
  const coordinates = [coveringId, coveredId].map(id => parseEvidenceCoordinates(id));
  const [covering, covered] = coordinates;
  if (!covering || !covered || covering.kind === "image" || covered.kind === "image" ||
    covering.input_id !== inputId || covered.input_id !== inputId || covering.message_index !== covered.message_index) return false;
  const message = raw.messages[covering.message_index];
  if (message === undefined) return false;
  const sources = evidenceSources(message);
  for (const coordinate of [covering, covered]) {
    const source = sources.find(source => source.kind === coordinate.kind && source.path === coordinate.path);
    if (!source || coordinate.start >= coordinate.end || coordinate.end > source.text.length ||
      overlapsImagePlaceholder(source.text, coordinate.start, coordinate.end)) return false;
  }
  if (covering.kind === covered.kind) return covering.path === covered.path &&
    covering.start <= covered.start && covering.end >= covered.end;
  if (covering.kind !== "json" || covered.kind !== "text") return false;
  // Locate only the actual rendered source. A complete serialized leaf proves its text origin;
  // partial JSON strings, matching values at other paths and decoded display quotes do not.
  const leaf = selectEvidenceSource(sources.filter(source => source.kind === "json"), covered.path);
  return !!leaf && covering.path === leaf.source.path && covering.start <= leaf.start && covering.end >= leaf.end;
}
