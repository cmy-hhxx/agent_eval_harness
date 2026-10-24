import { instructionSources, parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { ValidationError, type ToolAudit } from "@eval/contracts";
import type { RawInput } from "./types.js";

/** Task-local view: preserve message positions and factual leaf paths while excluding private instructions. */
export function attributionTrace(raw: RawInput, inputId: string, finalIndex: number): RawInput {
  const hiddenSkills = new Set(instructionSources(raw, inputId, finalIndex).filter(source => source.role === "tool").map(source => source.message_index));
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    if (row.role === "system" || row.role === "developer") return { type: "private_instruction_omitted" };
    return Object.fromEntries(Object.entries(row).filter(([key]) => !["system_prompt", "developer_prompt", "systemPrompt", "developerPrompt"].includes(key))
      .map(([key, child]) => {
        // A serialized snapshot has no independent leaf coordinates. Keep it outside
        // the main view when decoding reveals private instructions.
        if (key === "input_messages" && typeof child === "string") {
          try {
            const decoded = JSON.parse(child);
            if (JSON.stringify(visit(decoded)) !== JSON.stringify(decoded))
              return [key, "[含内部规范的序列化输入未进入主归因]"];
          } catch { /* Non-JSON factual input remains an ordinary source. */ }
        }
        return [key, visit(child)];
      }));
  };
  return { messages: raw.messages.map((message, index) => hiddenSkills.has(index)
    ? { type: message.type, name: message.name, output: "[内部技能规范由独立指令会话检查]" }
    : visit(message) as RawInput["messages"][number]) };
}

/** Privacy projection cannot turn a changed JSON parent into an original-source quote. */
export function validateOriginalAttributionEvidence(value: unknown, originals: Record<string, RawInput>, audit: ToolAudit): void {
  const visit = (entry: unknown, path: string) => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) { entry.forEach((child, index) => visit(child, `${path}/${index}`)); return; }
    const row = entry as Record<string, unknown>;
    if (typeof row.evidence_id === "string" && typeof row.quote === "string") {
      const point = parseEvidenceCoordinates(row.evidence_id);
      if (!point || point.kind === "image") return;
      const original = originals[point.input_id];
      let matches = false;
      try { matches = !!original && resolveEvidence(original, { evidence_id: row.evidence_id }, String(row.source ?? "answer"), audit, path, point.input_id).quote === row.quote; }
      catch { /* Original private text must never enter model-facing repair details. */ }
      if (!matches)
        throw new ValidationError([{ category: "evidence", code: "evidence_original_scope", path,
          message: "证据须与原始数据源完全一致；含内部规范的父级 JSON 已被裁去私密内容，请改选未改写的具体事实叶子。" }]);
      return;
    }
    for (const [key, child] of Object.entries(row)) visit(child, `${path}/${key}`);
  };
  visit(value, "");
}
