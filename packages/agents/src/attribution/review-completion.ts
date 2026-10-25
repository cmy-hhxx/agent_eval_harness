import { parseEvidenceCoordinates, type AgentRequest, type ToolAudit, type TraceRead, type ValidationIssue } from "@eval/contracts";
import { finalFindingEvidenceIssues } from "./evidence-focus.js";
import type { Evidence } from "./types.js";
import { attributionReadCovered } from "./investigation.js";

/** A rubric judgment reviews delivered content, even when its truth remains unknown. */
export function reviewCompletionEvidenceIssues(request: AgentRequest,
  assessment: { status?: unknown; evidence_status?: unknown; uncertainty?: unknown }, evidence: (Evidence | undefined)[], path: string, audit: ToolAudit): ValidationIssue[] {
  if (assessment.status === "not_applicable") return [];
  const anchorIssues = finalFindingEvidenceIssues(request, evidence, `${path}/evidence`);
  const issues = anchorIssues.map(issue => ({ ...issue, code: "criterion_delivery_evidence_required",
    message: "每项适用评审必须引用本方实际最终交付正文或已查看图片，说明已检查的交付；用户问题、历史上下文及工具来源不能代替交付锚点。" }));
  const uncertainty = assessment.uncertainty;
  const claim = uncertainty && typeof uncertainty === "object" && !Array.isArray(uncertainty)
    ? (uncertainty as { claim?: unknown }).claim : undefined;
  if (typeof claim === "string" && claim.trim() && !evidence.some(item => item &&
    !finalFindingEvidenceIssues(request, [item], `${path}/evidence`).length && item.quote.includes(claim)))
    issues.push({ category: "evidence", code: "criterion_uncertainty_claim_unbound", path: `${path}/uncertainty/claim`,
      message: "待核 claim 必须逐字引用本项已选择的本方实际交付证据中的完整主张，保留原语言和限定；任意待核标签不能证明已审查交付。" });
  if (assessment.status === "unknown" || assessment.evidence_status === "uncertain") {
    const missing: TraceRead[] = [];
    for (const item of evidence) {
      if (!item) continue;
      const point = parseEvidenceCoordinates(item.evidence_id), candidate = item.source ?? "answer";
      const raw = request.sources[candidate]?.value as { messages: unknown[] } | undefined;
      if (!point || point.kind === "image" || !raw) continue;
      const read: TraceRead = { candidate, message_index: point.message_index, kind: point.kind, path: point.path, start: point.start, end: point.end };
      if (!attributionReadCovered(audit, read, raw)) missing.push(read);
    }
    if (missing.length) issues.push({ category: "evidence", code: "investigation_read_required", path: `${path}/evidence`,
      message: "不确定评审所引用的原文尚未实际读取；按受保护必读补齐所选范围，再判断缺少证据及其影响。", expected: { read_requests: missing } });
  }
  return issues;
}
