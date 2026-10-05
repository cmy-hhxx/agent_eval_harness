import { parseEvidenceCoordinates, resolveEvidence } from "./evidence.js";
import { ValidationError, type ResolvedEvidence, type ToolAudit, type ValidationIssue } from "@eval/contracts";

/** Formal evidence retains its exact original coordinate; display text cannot select a different origin. */
export function validateTraceEvidence(
  raw: { messages: Record<string, unknown>[] },
  evidence: { item: ResolvedEvidence; location: string }[],
  label: string,
  audit: ToolAudit,
  finalIndex: number | undefined,
  inputId: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { item, location } of evidence) {
    if (finalIndex !== undefined && item.message_index !== finalIndex) issues.push({
      category: "evidence", code: "evidence_final_required", path: location, candidate: label,
      message: "独立判对错只能引用最终回答", expected: finalIndex, actual: item.message_index,
    });
    const coordinates = typeof item.evidence_id === "string" ? parseEvidenceCoordinates(item.evidence_id) : undefined;
    const prefix = "[图像观察]";
    try {
      const actual = resolveEvidence(raw, { evidence_id: item.evidence_id,
        ...(coordinates?.kind === "image" && item.quote.startsWith(prefix) ? { observation: item.quote.slice(prefix.length) } : {}),
      }, label, audit, location, inputId);
      if (actual.message_index !== item.message_index || actual.quote !== item.quote) issues.push({
        category: "evidence", code: "evidence_quote_mismatch", path: location, candidate: label,
        message: "正式证据的 message_index 和 quote 必须与完整 evidence_id 指向的真实原文逐字相符，不能通过其他路径的相同文字替代。",
        expected: actual, actual: item,
      });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
    }
  }
  return issues;
}
