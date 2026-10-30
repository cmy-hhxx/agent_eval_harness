import type { ResolvedEvidence } from "@eval/contracts";
import { displayEvidence, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

type Evidence = ResolvedEvidence & { source?: string; source_input_id?: string };
interface EvidenceEntry { evidence: Evidence[]; context_evidence?: Evidence[] }
interface AttributionEvidenceView { Problem: EvidenceEntry[] }

/** Preview a long accepted quote only when its exact source location is unambiguous. */
function evidencePresentation(evidence: Evidence, candidate: string, raw: RawInput, inputId: string,
  sources: Record<string, RawInput>, sourceIds: Record<string, string>) {
  if (evidence.source_input_id) {
    const peer = Object.keys(sourceIds).find(key => sourceIds[key] === evidence.source_input_id);
    if (!peer || !sources[peer]) return evidence;
    candidate = peer; raw = sources[peer]; inputId = evidence.source_input_id;
    evidence = { ...evidence, source: peer };
  }
  const coordinates = parseEvidenceCoordinates(evidence.evidence_id);
  if (!coordinates || coordinates.input_id !== inputId || coordinates.message_index !== evidence.message_index)
    throw new Error("归因证据的完整坐标与原输入不一致。");
  if (coordinates.kind === "image") return displayEvidence(evidence);
  const source = evidenceSources(raw.messages[coordinates.message_index]).find(source =>
    source.kind === coordinates.kind && source.path === coordinates.path);
  if (!source || coordinates.end > source.text.length || source.text.slice(coordinates.start, coordinates.end) !== evidence.quote)
    throw new Error("归因证据的完整坐标与原文不一致。");
  const { quote, ...reference } = evidence;
  return displayEvidence({ ...reference, ...(quote.length <= 200 ? { quote } : {
    quote_preview: quote.slice(0, 200), has_more: true }),
    read_request: { candidate, message_index: coordinates.message_index, ...(coordinates.kind === "text" ? { path: coordinates.path } : {}),
      offset: coordinates.start, max_chars: Math.min(16000, coordinates.end - coordinates.start) }, end_offset: coordinates.end });
}

/** Formal attribution and source values remain intact; only the model view is projected. */
export function attributionPresentation<T extends AttributionEvidenceView>(result: T, candidate: string, raw: RawInput, inputId: string,
  sources: Record<string, RawInput> = {}, sourceIds: Record<string, string> = {}) {
  const evidence = (entries: Evidence[]) => entries.map(entry => evidencePresentation(entry, candidate, raw, inputId, sources, sourceIds));
  const entries = <U extends EvidenceEntry>(items: U[]) => items.map(item => ({ ...item, evidence: evidence(item.evidence),
    ...(item.context_evidence ? { context_evidence: evidence(item.context_evidence) } : {}) }));
  return { ...result, Problem: entries<T["Problem"][number]>(result.Problem) };
}
