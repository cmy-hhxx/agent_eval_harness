import { parseEvidenceCoordinates, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceCovers, images, messageContentSources } from "@eval/tools";
import type { Evidence } from "./types.js";

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
    message: "最终回答的发现须显式选择本方最终正文或已查看图片；工具、规范及消息元数据不能代替实际交付证据。",
    expected: { candidate: "answer", message_index: index } }];
}
