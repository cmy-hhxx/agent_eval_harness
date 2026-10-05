import { ValidationError, type AgentRequest, type SubmissionReceipt, type ValidationIssue } from "@eval/contracts";
import type { AttributionResult } from "@eval/agents/attribution";
import { images, parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";

type Evidence = AttributionResult["findings"][number]["evidence"][number];
const mismatch = (path: string, message: string, expected?: unknown, actual?: unknown): ValidationIssue => ({
  category: "evidence", code: "accepted_evidence_origin_mismatch", path, message, expected, actual,
});

/** Read-only program origins: accepted business judgments and persisted receipts are never replaced. */
export function acceptedAttributionView(receipt: SubmissionReceipt, sourceRequest: AgentRequest): AttributionResult {
  const original = receipt.evaluation as AttributionResult;
  const result = structuredClone(original), errors: ValidationIssue[] = [];
  const evidence = (items: Evidence[], path: string) => {
    for (const [index, item] of items.entries()) {
      const location = `${path}/${index}`, candidate = item.source ?? "answer";
      const source = Object.hasOwn(sourceRequest.sources, candidate) ? sourceRequest.sources[candidate] : undefined;
      if (!source || (item.source === undefined && item.source_input_id !== undefined) ||
          (item.source !== undefined && item.source_input_id !== source.id)) {
        errors.push(mismatch(location, "正式证据的本方或复核来源须与原归因任务实际绑定相同，不能从对方相同文字补证。", undefined, item));
        continue;
      }
      try {
        const coordinate = parseEvidenceCoordinates(item.evidence_id), raw = source.value as { messages: unknown[] };
        if (coordinate?.kind === "image" && images(raw.messages[coordinate.message_index]).length === 0) {
          errors.push(mismatch(location, "已接受图片证据须对应原来源中的实际图片，查看记录不能替代原图片。"));
          continue;
        }
        const resolved = resolveEvidence(raw, { evidence_id: item.evidence_id,
          ...(coordinate?.kind === "image" && item.quote.startsWith("[图像观察]")
            ? { observation: item.quote.slice("[图像观察]".length) } : {}),
        }, candidate, receipt.audit, location, source.id);
        if (resolved.message_index !== item.message_index || resolved.quote !== item.quote) {
          errors.push(mismatch(location, "登记坐标解析的原文与已接受证据槽不同，不能更改原判词或原引文。", item, resolved));
          continue;
        }
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        errors.push(...error.issues!);
      }
    }
  };
  evidence(result.correctness_evidence, "/correctness_evidence");
  result.criterion_assessments.forEach((item, index) => evidence(item.evidence, `/criterion_assessments/${index}/evidence`));
  result.findings.forEach((item, index) => evidence(item.evidence, `/findings/${index}/evidence`));
  result.table_resolutions?.forEach((item, index) => evidence(item.evidence, `/table_resolutions/${index}/evidence`));
  if (errors.length) throw new ValidationError(errors);
  return result;
}
