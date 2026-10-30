import { evidenceId, type ResolvedEvidence } from "@eval/contracts";

/** Explicit fixture coordinates; no source search or inferred ownership. */
export function canonicalEvidence(inputId: string, messageIndex: number, quote: string, path = "/content", start = 0, kind: "text" | "json" = "text"): ResolvedEvidence {
  return { evidence_id: evidenceId(inputId, messageIndex, kind, path, start, start + quote.length), message_index: messageIndex, quote };
}
