import { evidenceId, projectEvidenceReferences, type AgentBinding, type ResolvedEvidence, type ToolAudit } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";

/** The fixture program registers its generated coordinates before emulating a model selection. */
export function resolveFixtureEvidence(registry: AgentRegistry, binding: AgentBinding, draft: unknown, audit: ToolAudit): unknown {
  const reads: ToolAudit = { ...audit, evidenceBank: [...(audit.evidenceBank ?? [])] };
  const selected = projectEvidenceReferences(draft, reads.evidenceBank!);
  return registry.resolve(binding, selected, reads);
}

/** Only generated test envelopes enter this projection; production uses the Workflow's owned fields. */
export function prepareFixtureEvidence(registry: AgentRegistry, binding: AgentBinding) {
  return registry.prepare({ ...binding, projectModelInput: projectEvidenceReferences });
}

/** Explicit fixture coordinates; no source search or inferred ownership. */
export function canonicalEvidence(inputId: string, messageIndex: number, quote: string, path = "/content", start = 0, kind: "text" | "json" = "text"): ResolvedEvidence {
  return { evidence_id: evidenceId(inputId, messageIndex, kind, path, start, start + quote.length), message_index: messageIndex, quote };
}
