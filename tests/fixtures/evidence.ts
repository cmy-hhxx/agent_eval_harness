import { evidenceId, projectEvidenceReferences, type AgentBinding, type ResolvedEvidence } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";

/** Only generated test envelopes enter this projection; production uses the Workflow's owned fields. */
export function prepareFixtureEvidence(registry: AgentRegistry, binding: AgentBinding) {
  return registry.prepare({ ...binding, projectModelInput: projectEvidenceReferences });
}

/** Explicit fixture coordinates; no source search or inferred ownership. */
export function canonicalEvidence(inputId: string, messageIndex: number, quote: string, path = "/content", start = 0, kind: "text" | "json" = "text"): ResolvedEvidence {
  return { evidence_id: evidenceId(inputId, messageIndex, kind, path, start, start + quote.length), message_index: messageIndex, quote };
}
