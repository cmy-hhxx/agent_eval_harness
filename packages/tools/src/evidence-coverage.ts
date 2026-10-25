import { overlapsImagePlaceholder, parseEvidenceCoordinates } from "@eval/contracts";
import { evidenceSources, selectEvidenceSource, type EvidenceSelectionCache } from "./evidence.js";

/** Mechanical containment of real physical coordinates; display quotes never identify a source. */
export function evidenceCovers(raw: { messages: unknown[] }, inputId: string, coveringId: string, coveredId: string,
  precomputedSources?: ReturnType<typeof evidenceSources>, selectionCache?: EvidenceSelectionCache): boolean {
  const coordinates = [coveringId, coveredId].map(id => parseEvidenceCoordinates(id));
  const [covering, covered] = coordinates;
  if (!covering || !covered || covering.kind === "image" || covered.kind === "image" ||
    covering.input_id !== inputId || covered.input_id !== inputId || covering.message_index !== covered.message_index) return false;
  const message = raw.messages[covering.message_index];
  if (message === undefined) return false;
  const sources = precomputedSources ?? evidenceSources(message);
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
  const leaf = selectEvidenceSource(sources.filter(source => source.kind === "json"), covered.path, selectionCache);
  return !!leaf && covering.path === leaf.source.path && covering.start <= leaf.start && covering.end >= leaf.end;
}

/** Nonempty intersection of real physical ranges, including an escaped JSON representation of a text leaf. */
export function evidenceOverlaps(raw: { messages: unknown[] }, inputId: string, firstId: string, secondId: string): boolean {
  const first = parseEvidenceCoordinates(firstId), second = parseEvidenceCoordinates(secondId);
  if (!first || !second || first.kind === "image" || second.kind === "image" ||
      first.input_id !== inputId || second.input_id !== inputId || first.message_index !== second.message_index) return false;
  const message = raw.messages[first.message_index];
  if (message === undefined) return false;
  const sources = evidenceSources(message);
  for (const point of [first, second]) {
    const source = sources.find(source => source.kind === point.kind && source.path === point.path);
    if (!source || point.start >= point.end || point.end > source.text.length ||
        overlapsImagePlaceholder(source.text, point.start, point.end)) return false;
  }
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    Math.max(a.start, b.start) < Math.min(a.end, b.end);
  if (first.kind === second.kind) return first.path === second.path && overlaps(first, second);
  const text = first.kind === "text" ? first : second, json = first.kind === "json" ? first : second;
  const source = sources.find(source => source.kind === "text" && source.path === text.path)!;
  const leaf = selectEvidenceSource(sources.filter(source => source.kind === "json"), text.path);
  if (!leaf || leaf.source.path !== json.path) return false;
  const encoded = JSON.stringify(source.text), valueStart = leaf.end - encoded.length;
  // Walk the encoded literal so escapes and surrogate pairs retain exact UTF-16 coordinates.
  const offsets = [valueStart + 1];
  for (let i = 1; i < encoded.length - 1;) {
    i += encoded[i] === "\\" ? encoded[i + 1] === "u" ? 6 : 2 : 1;
    offsets.push(valueStart + i);
  }
  return overlaps(json, { start: offsets[text.start]!, end: offsets[text.end]! });
}
