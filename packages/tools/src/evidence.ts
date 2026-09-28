import type { ValidationIssue } from "@eval/contracts";
import { ValidationError } from "@eval/contracts";

export const imagePlaceholder = "[图像数据，请使用 view_image]";
export function renderMessage(value: unknown): string {
  return JSON.stringify(
    value,
    (key, child: unknown) =>
      typeof child === "string" &&
      (child.startsWith("data:image/") || (key === "data" && child.length > 20000))
        ? imagePlaceholder
        : child,
    2,
  );
}
export function textLeaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return value.startsWith("data:image/") ? [] : [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "data" && typeof child === "string" && child.length > 20000
      ? []
      : textLeaves(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}
export function evidenceSources(message: unknown): { kind: "text" | "json"; path: string; text: string }[] {
  return [
    ...textLeaves(message).map(([path, text]) => ({
      kind: "text" as const,
      path,
      text,
    })),
    { kind: "json", path: "", text: renderMessage(message) },
  ];
}
/**
 * A plain-text evidence coordinate. It encodes the message, source kind, character
 * range and source path directly so the model can copy a tool-issued ID without an
 * opaque encoding step; only the mapping from kind+path back to source text is
 * resolved at submission time.
 */
export function evidenceId(
  messageIndex: number,
  kind: "text" | "json" | "image",
  path = "",
  start = 0,
  end = 0,
): string {
  return kind === "image" ? `ev_${messageIndex}_image` : `ev_${messageIndex}_${kind}_${start}_${end}_${path}`;
}
export function cite(
  messageIndex: number,
  source: ReturnType<typeof evidenceSources>[number],
  start: number,
  end: number,
) {
  return {
    evidence_id: evidenceId(messageIndex, source.kind, source.path, start, end),
    message_index: messageIndex,
    quote: source.text.slice(start, end),
  };
}
export function resolveEvidence(
  raw: { messages: unknown[] },
  value: { evidence_id: string; observation?: string },
  candidate: string,
  viewed: string[],
  location: string,
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
  const image = /^ev_(\d+)_image$/.exec(value.evidence_id);
  if (image) {
    const index = Number(image[1]);
    if (!raw.messages[index])
      return fail("message_index_invalid", "证据消息索引越界", `本候选共 ${raw.messages.length} 条消息`);
    if (!viewed.includes(`${candidate}:${index}`)) return fail("image_not_viewed", "不能引用未查看的图片");
    if (!value.observation?.trim()) return fail("image_observation_missing", "图片证据需要填写观察内容");
    return { message_index: index, quote: "[图像观察]" + value.observation };
  }
  const match = /^ev_(\d+)_(text|json)_(\d+)_(\d+)_([\s\S]*)$/.exec(value.evidence_id);
  if (!match)
    return fail(
      "evidence_id_invalid",
      "证据 ID 无法解析",
      "请直接复制材料或工具返回的完整 evidence_id，不要根据消息序号、路径或长度拼接",
    );
  const index = Number(match[1]);
  const kind = match[2] as "text" | "json";
  const start = Number(match[3]);
  const end = Number(match[4]);
  const path = match[5];
  if (!raw.messages[index])
    return fail("message_index_invalid", "证据消息索引越界", `本候选共 ${raw.messages.length} 条消息`);
  const sources = evidenceSources(raw.messages[index]);
  const source = sources.find((s) => s.kind === kind && s.path === path);
  if (!source || end <= start || end > source.text.length) {
    // Reject the submitted range; offer bounded source excerpts for an explicit new selection.
    const starts = source?.text.length
      ? [...new Set([start < source.text.length ? start : 0, Math.max(0, source.text.length - 400)])]
      : [];
    const suggested = source ? starts.map((offset) =>
      cite(index, source, offset, Math.min(offset + 400, source.text.length)),
    ).filter((item) => item.quote && !item.quote.includes(imagePlaceholder)) : [];
    return fail("evidence_range_invalid", "证据原文位置无效", coordinateHint(sources, kind, path, index), {
      suggested_evidence: suggested,
      read_request: {
        tool: "read_trace",
        arguments: { candidate, message_index: index, ...(source ? { path: source.path } : {}) },
      },
    });
  }
  const quote = source.text.slice(start, end);
  if (quote.includes(imagePlaceholder))
    return fail("evidence_placeholder", "展示占位符不能作为原文证据", "请改用该消息的其他文本路径");
  return { message_index: index, quote };
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
  hints.push("先核对 expected.suggested_evidence 的原文是否支持判断，符合时直接复制对应 evidence_id；片段不足则按 expected.read_request 读取，或用 search_trace 检索原文，不要手改坐标");
  return hints.join("；");
}
