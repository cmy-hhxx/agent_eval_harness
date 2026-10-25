import { ValidationError, type AgentRequest, type EvidenceReference, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { evidenceSources, originalUserTimestamp, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource, validateTraceEvidence, visualCaptureMarkers } from "@eval/tools";
import type { Evidence } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const ownEvidence = (item: Evidence) => item.source === undefined && item.source_input_id === undefined;
const materialMap = (request: AgentRequest) => object(request.input.reference_materials) ?? {};
const fail = (path: string, message: string, actual?: unknown): ValidationIssue => ({
  category: "evidence", code: "evidence_source_invalid", path, message, actual,
});

/** Capture metadata records our visibility, not a defect in the original candidate's delivery. */
export function captureMarkerProblemIssues(request: AgentRequest, value: unknown): ValidationIssue[] {
  const findings = object(value)?.Problem;
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((entry, index) => {
    const finding = object(entry), evidence = finding?.evidence;
    if (finding?.evidence_status !== "已确认" ||
      !Array.isArray(evidence) || !evidence.length) return [];
    const onlyCapture = evidence.every(item => {
      const id = object(item)?.evidence_id;
      const point = typeof id === "string" ? parseEvidenceCoordinates(id) : undefined;
      if (!point || point.kind !== "text") return false;
      const source = Object.values(request.sources).find(source => source.id === point.input_id);
      const messages = object(source?.value)?.messages;
      if (!Array.isArray(messages)) return false;
      return visualCaptureMarkers(messages[point.message_index]).some(marker => marker.kind === point.kind &&
        marker.path === point.path && point.start >= 0 && point.end > point.start && point.end <= marker.text.length);
    });
    return onlyCapture ? [{ category: "evidence", code: "capture_marker_not_candidate_evidence", path: `/Problem/${index}/evidence`,
      message: "所选证据全部是独立的可视材料采集占位符，只能证明本次采集未呈现内容，不能确认候选交付有缺陷。请补充真实正文、已查看图像或执行证据；无法确认时保留待核实 或删除该问题，不推导用户损害。" } as ValidationIssue] : [];
  });
}

/** Peer registration belongs to the trusted review binding; every descriptor must still match its real source. */
export function referenceMaterialIssues(request: AgentRequest): ValidationIssue[] {
  const materials = materialMap(request), issues: ValidationIssue[] = [];
  if (Object.keys(materials).length && !request.input.review_context)
    issues.push(fail("/reference_materials", "跨候选事实材料只能由独立复核任务提供"));
  const ids = new Set<string>();
  for (const key of Object.keys(request.sources)) if (key !== "answer" && !Object.hasOwn(materials, key))
    issues.push(fail("/reference_materials", "跨候选来源必须在本复核的 reference_materials 中明确登记", key));
  for (const [key, entry] of Object.entries(materials)) {
    const material = object(entry), source = Object.hasOwn(request.sources, key) ? request.sources[key] : undefined;
    const raw = object(source?.value), messages = raw?.messages;
    const path = `/reference_materials/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === "answer" || !material || !source || !Array.isArray(messages) || !uuid.test(source.id) ||
      material.source_input_id !== source.id || source.id === request.sources.answer?.id || ids.has(source.id) || material.grader_only !== true) {
      issues.push(fail(path, "裁判事实材料必须指向本任务登记的独立 peer 来源和真实持久 input UUID，不能覆盖 answer 或重复来源", entry));
      continue;
    }
    ids.add(source.id);
    if (typeof material.question !== "string" || material.question.replace(/\s+/gu, "") !==
      String(object(request.input.answer)?.question ?? "").replace(/\s+/gu, ""))
      issues.push(fail(`${path}/question`, "peer 事实材料必须属于同一个原问题", material.question));
    if (material.original_user_timestamp !== originalUserTimestamp({ messages }))
      issues.push(fail(`${path}/original_user_timestamp`, "peer 时间必须保留原末条 user 消息 timestamp，不得用评测时间或自由文本代替", material.original_user_timestamp));
    const own = object(request.sources.answer?.value);
    for (const field of ["batch_id", "case_id"])
      if (typeof own?.[field] === "string" && own[field] !== raw?.[field])
        issues.push(fail(path, "peer 事实来源不属于同一场题目", { field, answer: own[field], peer: raw?.[field] }));
  }
  return issues;
}
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
  const evidence = resolveEvidence(selected.entry.value as { messages: unknown[] }, ref, selected.key, audit, path, selected.entry.id);
  return selected.key === "answer" ? evidence : { ...evidence, source: selected.key, source_input_id: selected.entry.id };
}

/** New Attribution selections may use peer original facts, never the peer's generated final prose as authority. */
export function peerFinalSubmissionIssues(request: AgentRequest, evidence: Evidence, path: string): ValidationIssue[] {
  if (ownEvidence(evidence)) return [];
  const material = object(materialMap(request)[evidence.source!]);
  const source = request.sources[evidence.source!];
  const selected = parseEvidenceCoordinates(evidence.evidence_id);
  if (!material || !source || !selected || selected.kind === "image") return [];
  const raw = source.value as { messages: unknown[] };
  const fromReference = (value: unknown) => {
    const id = object(value)?.evidence_id;
    const origin = typeof id === "string" ? parseEvidenceCoordinates(id) : undefined;
    return origin?.kind === "text" && origin.input_id === source.id ? [origin] : [];
  };
  const generation = object(material.answer_generation);
  const origins = [
    ...(Array.isArray(material.final_evidence) ? material.final_evidence.flatMap(fromReference) : []),
    ...(Array.isArray(material.deferred_final_material) ? material.deferred_final_material.flatMap(value => {
      const entry = object(value);
      if (!entry || !Number.isSafeInteger(entry.message_index) || (entry.message_index as number) < 0 || typeof entry.path !== "string") return [];
      const leaf = evidenceSources(raw.messages[entry.message_index as number]).find(item => item.kind === "text" && item.path === entry.path);
      return leaf ? [{ kind: "text" as const, input_id: source.id, message_index: entry.message_index as number,
        path: leaf.path, start: 0, end: leaf.text.length }] : [];
    }) : []),
    ...(Array.isArray(generation?.blocks) ? generation.blocks.flatMap(value => fromReference(object(value)?.reference)) : []),
  ].filter(origin => origin.message_index === selected.message_index);
  const json = selected.kind === "json" ? evidenceSources(raw.messages[selected.message_index]).filter(item => item.kind === "json") : [];
  const overlaps = origins.some(origin => {
    const range = selected.kind === "text" ? selected.path === origin.path ? origin : undefined
      : selectEvidenceSource(json, origin.path);
    return !!range && selected.start < range.end && range.start < selected.end;
  });
  return overlaps ? [{ category: "evidence", code: "peer_final_not_independent", path, candidate: evidence.source,
    message: "peer 最终答案只证明对方交付，不能作为本方归因的独立事实依据；请读取其原始工具返回或参考材料。双方回答的相对差异由 Comparison 评审。",
    actual: { evidence_id: evidence.evidence_id } }] : [];
}
export function validateAttributionEvidence(request: AgentRequest, entries: { item: Evidence; location: string }[], audit: ToolAudit, finalIndex?: number) {
  const issues: ValidationIssue[] = [];
  for (const { item, location } of entries) {
    try {
      const selected = sourceFor(request, item.source, location);
      if ((item.source === undefined && item.source_input_id !== undefined) ||
        (item.source !== undefined && item.source_input_id !== selected.entry.id)) {
        issues.push(fail(location, "正式 foreign 证据的 source 与 source_input_id 必须对应原 peer input；本方不携带这些字段", item));
        continue;
      }
      if (!ownEvidence(item) && finalIndex !== undefined) issues.push({ category: "evidence", code: "evidence_final_required",
        path: location, candidate: selected.key, message: "独立判对错只能引用本方最终回答，不能引用 peer actual", actual: item });
      issues.push(...validateTraceEvidence(selected.entry.value as { messages: Record<string, unknown>[] }, [{ item, location }],
        selected.key, audit, ownEvidence(item) ? finalIndex : undefined, selected.entry.id));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      issues.push(...error.issues!);
    }
  }
  return issues;
}

/** Foreign facts explain the judgment but do not establish what this candidate actually delivered. */
export function foreignActualIssues(request: AgentRequest, result: import("./types.js").AttributionResult): ValidationIssue[] {
  const raw = request.sources.answer.value as { messages: unknown[] };
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  const actual = (item: Evidence, finalOnly: boolean) => {
    if (!ownEvidence(item)) return false;
    if (item.message_index === finalIndex) return true;
    if (finalOnly || item.message_index >= finalIndex) return false;
    const message = object(raw.messages[item.message_index]);
    if (!message) return false;
    if (message.role === "assistant" || message.role === "tool" ||
      ["function_call", "function_call_output", "tool_call", "tool_result", "reasoning"].includes(String(message.type))) return true;
    return message.type === "llm_turn" && evidenceSources(message.output).some(source => source.text.includes(item.quote));
  };
  const issues: ValidationIssue[] = [];
  const check = (evidence: Evidence[], path: string, finalOnly: boolean) => {
    if (!evidence.some(item => !ownEvidence(item)) || evidence.some(item => actual(item, finalOnly))) return;
    issues.push({ category: "evidence", code: "peer_actual_evidence_required", path,
      message: finalOnly ? `peer 仅提供裁判事实，必须同时引用本方最终消息 ${finalIndex} 的实际交付证据。`
        : "peer 仅提供裁判事实，必须同时引用本方回答或真实执行证据；peer、用户提问和规范不能冒充本方 actual。",
      expected: { candidate: "answer", final_message_index: finalIndex } });
  };
  result.Problem.forEach((problem,index)=>{if(problem.evidence_status==='已确认')check(problem.evidence,`/Problem/${index}/evidence`,false);});
  return issues;
}
