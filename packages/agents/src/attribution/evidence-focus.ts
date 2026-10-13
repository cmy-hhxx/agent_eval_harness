import { parseEvidenceCoordinates, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceCovers, images, messageContentSources } from "@eval/tools";
import type { Evidence } from "./types.js";

const maxQuoteChars = 800;
const maxGroupChars = 2400;

/** Admission rules for new selections, never a truncation or a reinterpretation of accepted results. */
export function focusedEvidenceIssues(evidence: (Evidence | undefined)[], path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let total = 0;
  evidence.forEach((item, index) => {
    if (!item) return;
    total += item.quote.length;
    if (item.quote.length <= maxQuoteChars) return;
    const point = parseEvidenceCoordinates(item.evidence_id);
    issues.push({ category: "evidence", code: "evidence_not_focused", path: `${path}/${index}`,
      actual: { chars: item.quote.length }, expected: { max_quote_chars: maxQuoteChars,
        candidate: item.source ?? "answer", message_index: item.message_index,
        ...(point && point.kind !== "image" ? { path: point.path } : {}) },
      message: "单条证据过长。先用 search_trace 定位判断涉及的原词，再用 read_trace 的 path、offset、max_chars 读取最小充分片段，保留对象、数值、单位及必要条件；不要直接截取开头或把整页切片全部提交。完整规范由程序单独保留为上下文。" });
  });
  if (total > maxGroupChars) issues.push({ category: "evidence", code: "evidence_group_not_focused", path,
    actual: { chars: total }, expected: { max_total_chars: maxGroupChars },
    message: "这组证据总范围过大。只保留直接支持本项判断的片段；多个独立问题分别记录，不能用多段短引用拼回全文。遗漏判断须完整审阅相关材料，并在说明中写清检查范围，引用相关章节或结尾作为定位。" });
  return issues;
}

export function finalFindingEvidenceIssues(request: AgentRequest, evidence: (Evidence | undefined)[], path: string): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const index = (request.input.answer as { final_message_index: number }).final_message_index;
  const message = raw.messages[index];
  if (!message || message.role !== "assistant" && !(message.role === undefined && message.type === "final_answer"))
    return [{ category: "evidence", code: "finding_final_source_invalid", path,
      message: "最终交付证据须来自本方真实 assistant/final_answer。" }];
  if (evidence.some(item => item === undefined)) return [];
  const sources = messageContentSources(message);
  const actual = evidence.some(item => {
    if (!item || item.source !== undefined || item.source_input_id !== undefined || item.message_index !== index) return false;
    const point = parseEvidenceCoordinates(item.evidence_id);
    if (point?.kind === "image") return images(message).length > 0;
    return sources.some(source => {
      const whole = cite(request.sources.answer.id, index, source, 0, source.text.length).evidence_id;
      return evidenceCovers(raw, request.sources.answer.id, whole, item.evidence_id) ||
        evidenceCovers(raw, request.sources.answer.id, item.evidence_id, whole);
    });
  });
  return actual ? [] : [{ category: "evidence", code: "finding_final_evidence_required", path,
    message: "最终回答的发现须明确选择本方最终正文的聚焦片段或已查看图片；完整回答不再自动追加，工具、规范及消息元数据不能代替实际交付。",
    expected: { candidate: "answer", message_index: index } }];
}
