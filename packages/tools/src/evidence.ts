import type { ValidationIssue } from "@eval/contracts";
import { ValidationError } from "@eval/contracts";

const imagePlaceholder = "[图像数据，请使用 view_image]";
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
 * range and source path directly so the model can copy or rebuild it without an
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
  const fail = (code: string, message: string): never => {
    const issue: ValidationIssue = {
      category: "evidence",
      code,
      path: location,
      candidate,
      expected: "本候选当前输入中的有效证据 ID",
      actual: value,
      message,
    };
    throw new ValidationError([issue]);
  };
  const image = /^ev_(\d+)_image$/.exec(value.evidence_id);
  if (image) {
    const index = Number(image[1]);
    if (!raw.messages[index]) return fail("message_index_invalid", "证据消息索引越界");
    if (!viewed.includes(`${candidate}:${index}`)) return fail("image_not_viewed", "不能引用未查看的图片");
    if (!value.observation?.trim()) return fail("image_observation_missing", "图片证据需要填写观察内容");
    return { message_index: index, quote: "[图像观察]" + value.observation };
  }
  const match = /^ev_(\d+)_(text|json)_(\d+)_(\d+)_([\s\S]*)$/.exec(value.evidence_id);
  if (!match) return fail("evidence_id_invalid", "证据 ID 无法解析");
  const index = Number(match[1]);
  const kind = match[2] as "text" | "json";
  const start = Number(match[3]);
  const end = Number(match[4]);
  const path = match[5];
  if (!raw.messages[index]) return fail("message_index_invalid", "证据消息索引越界");
  const source = evidenceSources(raw.messages[index]).find((s) => s.kind === kind && s.path === path);
  if (!source || end <= start || end > source.text.length)
    return fail("evidence_range_invalid", "证据原文位置无效");
  const quote = source.text.slice(start, end);
  if (quote.includes(imagePlaceholder)) return fail("evidence_placeholder", "展示占位符不能作为原文证据");
  return { message_index: index, quote };
}
