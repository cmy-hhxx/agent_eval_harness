import { evidenceSources } from "./evidence.js";
import type { ToolAudit, ValidationIssue } from "@eval/contracts";
export function validateTraceEvidence(
  raw: { messages: Record<string, unknown>[] },
  evidence: {
    item: { message_index: number; quote: string };
    location: string;
  }[],
  label: string,
  audit: ToolAudit,
  finalIndex?: number,
): ValidationIssue[] {
  const repairErrors: ValidationIssue[] = [];
  const issue = (
    code: string,
    path: string,
    message: string,
    candidate?: string,
    expected?: unknown,
    actual?: unknown,
  ) =>
    repairErrors.push({
      category: "evidence",
      code,
      path,
      message,
      candidate,
      expected,
      actual,
    });
  for (const { item, location } of evidence) {
    if (finalIndex !== undefined && item.message_index !== finalIndex)
      issue(
        "evidence_final_required",
        location,
        "独立判对错只能引用最终回答",
        label,
        finalIndex,
        item.message_index,
      );
    const message = raw.messages[item.message_index];
    if (!message) {
      issue(
        "message_index_invalid",
        location,
        `证据 message_index 越界：${location}，候选 ${label} 的索引 ${item.message_index} 不在 0–${raw.messages.length - 1}；最终回答索引为 ${finalIndex}`,
        label,
        [0, raw.messages.length - 1],
        item.message_index,
      );
      continue;
    }
    if (item.quote.startsWith("[图像观察]")) {
      if (!audit.viewedImages.includes(`${label}:${item.message_index}`))
        issue("image_not_viewed", location, "不能引用未查看的图片", label);
    } else if (!evidenceSources(message).some(({ text }) => text.includes(item.quote)))
      issue(
        "evidence_quote_mismatch",
        location,
        `quote 不是对应消息的逐字原文：${location}，候选 ${label} 的原始 message_index=${item.message_index}；请用 read_trace/search_trace 获取该消息的 evidence_id 后重新提交`,
        label,
        undefined,
        item.quote,
      );
  }
  return repairErrors;
}
