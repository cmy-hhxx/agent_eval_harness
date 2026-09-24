import type { ValidationIssue } from "../../contracts/src/index.js";
import { ValidationError } from "../../contracts/src/io.js";

const imagePlaceholder = "[图像数据，请使用 view_image]";
export function renderMessage(value: unknown): string {
  return JSON.stringify(value, (key, child: unknown) => typeof child === "string" &&
    (child.startsWith("data:image/") || (key === "data" && child.length > 20000)) ? imagePlaceholder : child, 2);
}
export function textLeaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return value.startsWith("data:image/") ? [] : [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "data" && typeof child === "string" && child.length > 20000 ? [] :
    textLeaves(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
}
export function evidenceSources(message: unknown): { kind: "text" | "json"; path: string; text: string }[] {
  return [...textLeaves(message).map(([path, text]) => ({ kind: "text" as const, path, text })),
    { kind: "json", path: "", text: renderMessage(message) }];
}
export function evidenceId(inputId: string, messageIndex: number, kind: "text" | "json" | "image", path = "", start = 0, end = 0): string {
  return "ev_" + Buffer.from(JSON.stringify([inputId, messageIndex, kind, path, start, end])).toString("base64url");
}
export function cite(inputId: string, messageIndex: number, source: ReturnType<typeof evidenceSources>[number], start: number, end: number) {
  return { evidence_id: evidenceId(inputId, messageIndex, source.kind, source.path, start, end),
    message_index: messageIndex, quote: source.text.slice(start, end) };
}
export function resolveEvidence(raw: { messages: unknown[] }, inputId: string, value: { evidence_id: string; observation?: string }, candidate: string, viewed: string[], location: string) {
  const fail = (code: string, message: string): never => {
    const issue: ValidationIssue = { category: "evidence", code, path: location, candidate, expected: "本候选当前输入中的有效证据 ID", actual: value, message };
    throw new ValidationError([issue]);
  };
  let parts: unknown;
  try { parts = JSON.parse(Buffer.from(value.evidence_id.slice(3), "base64url").toString()); }
  catch { return fail("evidence_id_invalid", "证据 ID 无法解析"); }
  if (!value.evidence_id.startsWith("ev_") || !Array.isArray(parts) || parts.length !== 6) return fail("evidence_id_invalid", "证据 ID 格式错误");
  const [id, index, kind, path, start, end] = parts;
  if (id !== inputId) return fail("evidence_input_mismatch", "证据不属于本候选的当前输入");
  if (!Number.isInteger(index) || index < 0 || !raw.messages[index]) return fail("message_index_invalid", "证据消息索引越界");
  if (kind === "image") {
    if (!viewed.includes(`${candidate}:${index}`)) return fail("image_not_viewed", "不能引用未查看的图片");
    if (!value.observation?.trim()) return fail("image_observation_missing", "图片证据需要填写观察内容");
    return { message_index: index, quote: "[图像观察]" + value.observation };
  }
  const source = evidenceSources(raw.messages[index]).find((s) => s.kind === kind && s.path === path);
  if (!source || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length)
    return fail("evidence_range_invalid", "证据原文位置无效");
  const quote = source.text.slice(start, end);
  if (quote.includes(imagePlaceholder)) return fail("evidence_placeholder", "展示占位符不能作为原文证据");
  return { message_index: index, quote };
}
