import type { ToolAudit, ValidationIssue } from "@eval/contracts";
import { evidenceId, evidenceSources, imagePlaceholder, overlapsImagePlaceholder, parseEvidenceCoordinates, ValidationError } from "@eval/contracts";
export { evidenceId, evidenceSources, messageContentSources, imagePlaceholder, overlapsImagePlaceholder, parseEvidenceCoordinates, type EvidenceCoordinates } from "@eval/contracts";

export function cite(
  inputId: string,
  messageIndex: number,
  source: ReturnType<typeof evidenceSources>[number],
  start: number,
  end: number,
) {
  return {
    evidence_id: evidenceId(inputId, messageIndex, source.kind, source.path, start, end),
    message_index: messageIndex,
    quote: source.text.slice(start, end),
  };
}
/** Keep source display fields separate from the exact object a model copies into its submission. */
export function displayEvidence<T extends { evidence_id: string }>(evidence: T) {
  const { evidence_id, ...display } = evidence;
  return { ...display, reference: { evidence_id } };
}
type EvidenceAudit = Pick<ToolAudit, "viewedImages" | "traceReads">;
/** Reoffer actual reads, including one broad JSON excerpt, when a model loses a supplied coordinate. */
function readSuggestions(raw: { messages: unknown[] }, candidate: string, inputId: string, index: number, audit: EvidenceAudit,
  suggested: { reference: { evidence_id: string } }[]) {
  const sources = evidenceSources(raw.messages[index]);
  const seen = new Set<string>();
  const reads = audit.traceReads.slice().reverse().flatMap((read) => {
    if (read.candidate !== candidate || read.message_index !== index) return [];
    const source = sources.find((item) => item.kind === read.kind && item.path === read.path);
    if (!source || source.quotable === false || !Number.isInteger(read.start) || !Number.isInteger(read.end) || read.start < 0 ||
      read.end <= read.start || read.end > source.text.length || overlapsImagePlaceholder(source.text, read.start, read.end)) return [];
    return [{ ...cite(inputId, index, source, read.start, read.end), kind: read.kind, start: read.start, end: read.end }];
  });
  const wide = reads.filter((read) => read.kind === "json" && read.start > 0)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  const recovered = [ ...(wide ? [wide] : []), ...reads ].filter((read) => {
    if (seen.has(read.evidence_id)) return false;
    seen.add(read.evidence_id);
    return true;
  }).slice(0, 4).map((read) => displayEvidence({ evidence_id: read.evidence_id, message_index: index,
    quote_preview: read.quote.slice(0, 200), has_more: read.quote.length > 200 }));
  const offered = new Set(recovered.map((item) => item.reference.evidence_id));
  return [...recovered, ...suggested.filter((item) => !offered.has(item.reference.evidence_id))];
}
/** Locate a JSON pointer in the exact rendered message; returned offsets stay in that JSON source. */
function jsonPathRange(text: string, path: string): { start: number; end: number } | undefined {
  if (!path) return { start: 0, end: text.length };
  if (!path.startsWith("/") || /~(?![01])/u.test(path)) return undefined;
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const length = (value: unknown, depth: number) => {
    const rendered = JSON.stringify(value, null, 2);
    return rendered.length + (rendered.match(/\n/g)?.length ?? 0) * depth * 2;
  };
  const locate = (value: unknown, start: number, depth: number, remaining: string[]): { start: number; end: number } | undefined => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, remaining[0]!)) return undefined;
    const array = Array.isArray(value);
    let cursor = start + 2 + (depth + 1) * 2;
    for (const [key, child] of Object.entries(value)) {
      const valueStart = cursor + (array ? 0 : JSON.stringify(key).length + 2);
      const end = valueStart + length(child, depth + 1);
      if (key === remaining[0]) return remaining.length === 1
        ? { start: cursor, end }
        : locate(child, valueStart, depth + 1, remaining.slice(1));
      cursor = end + 2 + (depth + 1) * 2;
    }
    return undefined;
  };
  return locate(JSON.parse(text), 0, 0, parts);
}
export function selectEvidenceSource(sources: ReturnType<typeof evidenceSources>, path?: string) {
  const text = path !== undefined ? sources.find((source) => source.kind === "text" && source.path === path) : undefined;
  if (text) return { source: text, start: 0, end: text.text.length };
  const json = sources.find((source) => source.kind === "json")!;
  const range = jsonPathRange(json.text, path ?? "");
  return range ? { source: json, ...range } : undefined;
}
function coordinateRepair(raw: { messages: unknown[] }, candidate: string, inputId: string, index: number, kind: "text" | "json", path: string, audit: EvidenceAudit) {
  const message = raw.messages[index];
  if (!message) return { suggested_evidence: [] };
  const sources = evidenceSources(message);
  const exact = sources.find((source) => source.kind === kind && source.path === path);
  const selected = exact ? { source: exact, start: 0, end: exact.text.length } : selectEvidenceSource(sources, path);
  const source = selected?.source;
  // A structured value is quoted from the rendered message, never invented as a text leaf.
  const suggested = selected && source && source.quotable !== false ? [...new Set([selected.start, Math.max(selected.start, selected.end - 400)])]
    .filter((start) => !overlapsImagePlaceholder(source.text, start, Math.min(start + 400, selected.end)))
    .map((start) => cite(inputId, index, source, start, Math.min(start + 400, selected.end)))
    .filter((item) => item.quote && !item.quote.includes(imagePlaceholder)) : [];
  return {
    suggested_evidence: readSuggestions(raw, candidate, inputId, index, audit, suggested.map(displayEvidence)),
    read_request: {
      tool: "read_trace",
      arguments: { candidate, message_index: index,
        ...(selected ? { path } : {}),
      },
    },
  };
}
export function resolveEvidence(
  raw: { messages: unknown[] },
  value: { evidence_id: string; observation?: unknown },
  candidate: string,
  audit: EvidenceAudit,
  location: string,
  inputId: string,
) {
  const fail = (code: string, message: string, hint?: string, expected: unknown = "本候选当前输入中的有效证据 ID"): never => {
    const issue: ValidationIssue = {
      category: "evidence",
      code,
      path: location,
      candidate,
      expected,
      actual: value,
      message: hint ? `${message}；${hint}` : message,
    };
    throw new ValidationError([issue]);
  };
  if (Object.hasOwn(value, "source"))
    return fail("evidence_source_invalid", "reference 的来源已包含在完整 evidence_id 中，不能另填 source");
  const coordinates = parseEvidenceCoordinates(value.evidence_id);
  if (coordinates && coordinates.input_id !== inputId)
    return fail("evidence_source_invalid", "证据 ID 指向其他输入，不能作为本来源原文", undefined, { input_id: inputId });
  if (coordinates?.kind === "image") {
    const index = coordinates.message_index;
    if (!raw.messages[index])
      return fail("message_index_invalid", "证据消息索引越界", `本候选共 ${raw.messages.length} 条消息`);
    if (!audit.viewedImages.includes(`${candidate}:${index}`)) return fail("image_not_viewed", "不能引用未查看的图片");
    if (typeof value.observation !== "string" || !value.observation.trim())
      return fail("image_observation_missing", "图片证据需要填写观察内容");
    return { evidence_id: value.evidence_id, message_index: index, quote: "[图像观察]" + value.observation };
  }
  if (!coordinates) {
    // Partial coordinates only locate repair material. The submitted ID remains rejected.
    const prefix = `ev_${inputId}_`;
    const local = typeof value.evidence_id === "string" && value.evidence_id.startsWith(prefix) ? value.evidence_id.slice(prefix.length) : "";
    const partial = /^(\d+)_(text|json)_[^_]*_[^_]*_([\s\S]*)$/.exec(local);
    const messagePrefix = /^(\d+)_/.exec(local);
    const repair = partial ? coordinateRepair(raw, candidate, inputId, Number(partial[1]), partial[2] as "text" | "json", partial[3]!, audit)
      : messagePrefix && raw.messages[Number(messagePrefix[1])] ? {
        suggested_evidence: readSuggestions(raw, candidate, inputId, Number(messagePrefix[1]), audit, []),
        read_request: { tool: "read_trace", arguments: { candidate, message_index: Number(messagePrefix[1]) } },
      } : undefined;
    return fail(
      "evidence_id_invalid",
      "证据 ID 无法解析",
      repair ? "请核对 expected.suggested_evidence 的原文并原样复制对应 reference 对象；片段不足时按 expected.read_request 读取，不要根据消息序号、路径或长度拼接"
        : "请通过 read_trace 或 search_trace 获取原文并原样复制对应 reference 对象，不要根据消息序号、路径或长度拼接",
      repair,
    );
  }
  const { message_index: index, kind, start, end, path } = coordinates;
  if (!raw.messages[index])
    return fail("message_index_invalid", "证据消息索引越界", `本候选共 ${raw.messages.length} 条消息`);
  const sources = evidenceSources(raw.messages[index]);
  const source = sources.find((s) => s.kind === kind && s.path === path);
  if (!source || end <= start || end > source.text.length) {
    // Reject the submitted range; offer bounded source excerpts for an explicit new selection.
    const starts = source?.text.length
      ? [...new Set([start < source.text.length ? start : 0, Math.max(0, source.text.length - 400)])]
      : [];
    const suggested = source && source.quotable !== false ? starts.filter((offset) => !overlapsImagePlaceholder(source.text, offset, Math.min(offset + 400, source.text.length))).map((offset) =>
      cite(inputId, index, source, offset, Math.min(offset + 400, source.text.length)),
    ).filter((item) => item.quote && !item.quote.includes(imagePlaceholder)) : [];
    return fail("evidence_range_invalid", "证据原文位置无效", coordinateHint(sources, kind, path, index), {
      ...(source ? {
        suggested_evidence: readSuggestions(raw, candidate, inputId, index, audit, suggested.map(displayEvidence)),
        read_request: {
          tool: "read_trace",
          arguments: { candidate, message_index: index, ...(source.kind === "text" ? { path: source.path } : {}) },
        },
      } : coordinateRepair(raw, candidate, inputId, index, kind, path, audit)),
    });
  }
  const quote = source.text.slice(start, end);
  if (overlapsImagePlaceholder(source.text, start, end))
    return fail("evidence_placeholder", "展示占位符不能作为原文证据", "请改用该消息的其他文本路径");
  return { evidence_id: value.evidence_id, message_index: index, quote };
}
const shownPath = (path: string) => path || "（整条消息 JSON）";
/** Hints help locate the correct source without silently changing a submitted quote. */
function coordinateHint(
  sources: ReturnType<typeof evidenceSources>,
  kind: "text" | "json",
  path: string,
  index: number,
): string {
  const available = sources.filter((source) => source.kind === kind && source.text.length);
  const exact = available.find((source) => source.path === path);
  const hints: string[] = [];
  if (exact) hints.push(`路径 ${shownPath(path)} 的文本长度为 ${exact.text.length}，起止应为 0 ≤ 起 < 止 ≤ ${exact.text.length}`);
  const last = path.split("/").at(-1) || "";
  const related = last
    ? [...new Set(available.filter((source) => source.text === last).map((source) => source.path))]
    : [];
  if (related.length) hints.push(`值为「${last}」的路径是 ${related.map(shownPath).join("、")}`);
  const paths = [...new Set(available.map((source) => source.path))];
  if (paths.length)
    hints.push(
      `消息 ${index} 可引用路径：${paths.slice(0, 8).map(shownPath).join("、")}` +
        (paths.length > 8 ? ` 等 ${paths.length} 条` : ""),
    );
  hints.push("先核对 expected.suggested_evidence 的原文是否支持判断，符合时原样复制对应 reference 对象；片段不足则按 expected.read_request 读取对象、数值或文本字段，或用 search_trace 检索原文，不要手改坐标");
  return hints.join("；");
}
