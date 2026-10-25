import { ValidationError, type AgentRequest, type EvidenceReference, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { parseEvidenceCoordinates, resolveEvidence, images } from "@eval/tools";
import type { Evidence } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const ownEvidence = (item: Evidence) => item.source === undefined && item.source_input_id === undefined;
const materialMap = (request: AgentRequest) => object(request.input.reference_materials) ?? {};
const fail = (path: string, message: string, actual?: unknown): ValidationIssue => ({
  category: "evidence", code: "evidence_source_invalid", path, message, actual,
});

function sourceFor(request: AgentRequest, source: unknown, path: string) {
  if (source === undefined) return { key: "answer", entry: request.sources.answer! };
  const material = typeof source === "string" && source !== "answer" && Object.hasOwn(materialMap(request), source)
    ? object(materialMap(request)[source]) : undefined;
  const entry = typeof source === "string" && Object.hasOwn(request.sources, source) ? request.sources[source] : undefined;
  if (!material || !entry || material.source_input_id !== entry.id || material.grader_only !== true || !uuid.test(entry.id) || !request.input.review_context)
    throw new ValidationError([fail(path, "正式 foreign 证据只能指向本复核 reference_materials 中登记的 peer 来源", source)]);
  return { key: source as string, entry };
}
/** Select a source solely from the complete program-generated ID, never a model-provided source label. */
function sourceForReference(request: AgentRequest, ref: EvidenceReference, path: string) {
  if (Object.hasOwn(ref, "source")) throw new ValidationError([fail(path,
    "引用只填写所选材料的 evidence_index，不能另填 source 或手写来源 ID", ref)]);
  const inputId = parseEvidenceCoordinates(ref.evidence_id)?.input_id ??
    /^ev_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})_/u.exec(ref.evidence_id)?.[1];
  if (!inputId) return { key: "answer", entry: request.sources.answer! }; // The strict resolver rejects malformed/old IDs.
  const matches = Object.entries(request.sources).filter(([, entry]) => entry.id === inputId);
  if (matches.length !== 1) throw new ValidationError([fail(path,
    "证据 ID 的 input UUID 必须唯一指向本任务已登记的原材料", ref)]);
  const [key, entry] = matches[0]!;
  return key === "answer" ? { key, entry } : sourceFor(request, key, path);
}
export function resolveAttributionEvidence(request: AgentRequest, ref: EvidenceReference, audit: ToolAudit, path: string): Evidence {
  const selected = sourceForReference(request, ref, path);
  const point=parseEvidenceCoordinates(ref.evidence_id);
  if(point?.kind==='image'){
    const raw=selected.entry.value as {messages:unknown[]};
    if(!raw.messages[point.message_index]||!images(raw.messages[point.message_index]).length||typeof ref.observation!=='string')
      throw new ValidationError([fail(path,'图片编号必须可解析到实际图片，并提供观察文本。')]);
    const evidence={evidence_id:ref.evidence_id,message_index:point.message_index,quote:'[图像观察]'+ref.observation};
    return selected.key==='answer'?evidence:{...evidence,source:selected.key,source_input_id:selected.entry.id};
  }
  const evidence = resolveEvidence(selected.entry.value as { messages: unknown[] }, ref, selected.key, audit, path, selected.entry.id);
  return selected.key === "answer" ? evidence : { ...evidence, source: selected.key, source_input_id: selected.entry.id };
}
