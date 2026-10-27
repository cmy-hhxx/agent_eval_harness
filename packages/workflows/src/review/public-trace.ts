import { evidenceSources, instructionSources, parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { ValidationError, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import type { RawInput } from "../inputs/types.js";

/** Task-local view: preserve message positions and factual leaf paths while excluding private instructions. */
export function attributionTrace(raw: RawInput, inputId: string, finalIndex: number): RawInput {
  const skills = instructionSources(raw, inputId, finalIndex).filter(source => source.role === "tool");
  const hiddenSkills = new Set(skills.map(source => source.message_index));
  const skillContents = new Set(skills.flatMap(source => typeof source.content === "string" ? [source.content] : []));
  const projected = new WeakMap<object, unknown>();
  const visit = (value: unknown): unknown => {
    if (typeof value === "string" && skillContents.has(value)) return "[内部技能规范由独立指令会话检查]";
    if (!value || typeof value !== "object") return value;
    if (projected.has(value)) return projected.get(value);
    if (Array.isArray(value)) {
      const result = value.map(visit); projected.set(value, result); return result;
    }
    const row = value as Record<string, unknown>;
    if (row.role === "system" || row.role === "developer") return { type: "private_instruction_omitted" };
    const result = Object.fromEntries(Object.entries(row)
      .map(([key, child]) => {
        if (["system_prompt", "developer_prompt", "systemPrompt", "developerPrompt"].includes(key))
          return [key, "[内部技能规范由独立指令会话检查]"];
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
    projected.set(value, result);
    return result;
  };
  return { messages: raw.messages.map((message, index) => hiddenSkills.has(index)
    ? { type: message.type, name: message.name, output: "[内部技能规范由独立指令会话检查]" }
    : visit(message) as RawInput["messages"][number]) };
}

/** Privacy projection cannot turn a changed JSON parent into an original-source quote. */
export function validateOriginalAttributionEvidence(value: unknown, originals: Record<string, RawInput>, audit: ToolAudit, submission?: unknown): void {
  const issues = new Map<string, ValidationIssue>();
  const addressed = (entry: unknown, index: number, path = ""): string[] => {
    if (Array.isArray(entry)) return entry.flatMap((child, i) => addressed(child, index, `${path}/${i}`));
    if (!entry || typeof entry !== "object") return [];
    return Object.entries(entry).flatMap(([key, child]) => {
      const location = `${path}/${key}`;
      if (key.endsWith("evidence_indices") && Array.isArray(child))
        return child.flatMap((number, i) => number === index ? [`${location}/${i}`] : []);
      if (key === "evidence_index" && child === index) return [location];
      if (key === "index" && /\/evidence\/\d+$/u.test(path) && child === index) return [location];
      return addressed(child, index, location);
    });
  };
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
      if (!matches) {
        const index = (audit.evidenceBank ?? []).indexOf(row.evidence_id) + 1;
        const paths = index ? addressed(submission, index) : [];
        const view = original && attributionTrace(original, point.input_id, original.messages.length - 1);
        const originalLeaves = original ? evidenceSources(original.messages[point.message_index]) : [];
        const safe = view ? evidenceSources(view.messages[point.message_index]).filter(source => source.kind === "text" &&
          source.text.length && originalLeaves.some(leaf => leaf.kind === "text" && leaf.path === source.path && leaf.text === source.text)) : [];
        const available = (audit.evidenceBank ?? []).flatMap((id, i) => {
          const selected = parseEvidenceCoordinates(id);
          return selected?.kind === "text" && selected.input_id === point.input_id && selected.message_index === point.message_index &&
            safe.some(source => source.path === selected.path && selected.end > selected.start && selected.end <= source.text.length) ? [i + 1] : [];
        });
        for (const location of paths.length ? paths : [path]) issues.set(location, {
          category: "evidence", code: "evidence_original_scope", path: location,
          message: "该编号来自经过私密规范裁剪的材料，与原始数据源原文不一致。改选同一消息未改写的事实叶子，不要重复提交原编号。",
          ...(index ? { actual: index } : {}), expected: {
            evidence_indices: available,
            read_requests: safe.slice().sort((a, b) => Number(/\/(?:content|output|result)(?:\/|$)/u.test(b.path)) -
              Number(/\/(?:content|output|result)(?:\/|$)/u.test(a.path)) || b.text.length - a.text.length).slice(0, 8).map(source => ({ candidate: String(row.source ?? "answer"),
              message_index: point.message_index, path: source.path, offset: 0, max_chars: Math.min(16000, source.text.length) })),
            repair_action: "替换本字段的证据编号；已有叶子编号不足时按 read_requests 读取，保持私密规范隔离和原文一致性校验。",
          },
        });
      }
      return;
    }
    for (const [key, child] of Object.entries(row)) visit(child, `${path}/${key}`);
  };
  visit(value, "");
  if (issues.size) throw new ValidationError([...issues.values()]);
}
