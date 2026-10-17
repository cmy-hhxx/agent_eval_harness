import type { EvidenceReference, JsonSchema, ValidationIssue } from "./primitives.js";
import { evidenceImageAvailable, evidenceSources, overlapsImagePlaceholder, parseEvidenceCoordinates } from "./evidence.js";
import { ValidationError } from "./validation.js";

/** One task's append-only coordinate directory; it never stores original material or observations. */
export type EvidenceBank = string[];
export interface EvidenceSelection { evidence_index: number; observation?: unknown }
function fail(path: string, code: string, actual: unknown, message: string): never {
  throw new ValidationError([{ category: "evidence", code, path, actual, message,
    expected: { repair_action: "从本任务材料或读取工具返回的 reference 中选择已提供的正整数 evidence_index；需要新材料时先读取，不自行计算编号。" } }]);
}
export function validateEvidenceBank(value: unknown, prefix: readonly string[] = [], path = "/evidenceBank"): asserts value is EvidenceBank {
  if (!Array.isArray(value)) fail(path, "evidence_bank_invalid", value, "证据目录必须为坐标数组。");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const id = value[index];
    const coordinate = typeof id === "string" ? parseEvidenceCoordinates(id) : undefined;
    if (!coordinate || (coordinate.kind !== "image" && coordinate.end < coordinate.start) || seen.has(id))
      fail(`${path}/${index}`, "evidence_bank_invalid", id, "证据目录包含无效或重复坐标。");
    seen.add(id);
  }
  if (prefix.length > value.length || prefix.some((id, index) => value[index] !== id))
    fail(path, "evidence_bank_prefix_changed", value, "证据目录必须保留当前任务原有编号及坐标，只能末尾追加。");
}
/** Registration is synchronous so parallel tool completions cannot allocate one index twice. */
export function selectEvidence(bank: EvidenceBank, reference: EvidenceReference): EvidenceSelection {
  const coordinate = typeof reference.evidence_id === "string" ? parseEvidenceCoordinates(reference.evidence_id) : undefined;
  if (!coordinate || (coordinate.kind !== "image" && coordinate.end < coordinate.start))
    fail("/reference", "evidence_coordinate_invalid", reference, "程序提供的证据坐标无效。");
  let position = bank.indexOf(reference.evidence_id);
  if (position < 0) { position = bank.length; bank.push(reference.evidence_id); }
  return { evidence_index: position + 1, ...(reference.observation !== undefined ? { observation: reference.observation } : {}) };
}
export function resolveEvidenceSelection(bank: readonly string[], value: unknown, path: string): EvidenceReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "evidence_selection_invalid", value, "引用必须为 evidence_index 选号对象。");
  const selection = value as Record<string, unknown>, index = selection.evidence_index;
  if (Object.keys(selection).some(key => key !== "evidence_index" && key !== "observation") ||
    !Number.isSafeInteger(index) || (index as number) < 1 || (index as number) > bank.length)
    throw new ValidationError([{ category: "evidence", code: "evidence_selection_invalid", path, actual: value,
      expected: { available_index_range: bank.length ? [1, bank.length] : [],
        repair_action: "选择本任务已提供的 reference.evidence_index；没有合适证据时先读取材料，不自行计算编号。" },
      message: "证据编号不是本任务已提供的正整数选号。" }]);
  const evidence_id = bank[(index as number) - 1]!;
  return { evidence_id, ...(selection.observation !== undefined ? { observation: selection.observation } : {}) };
}
function mapReferences(value: unknown, convert: (value: Record<string, unknown>, path: string) => unknown, selected: string, path: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => mapReferences(item, convert, selected, `${path}/${index}`));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Object.hasOwn(object, selected) && Object.keys(object).every(key => key === selected || key === "observation")) return convert(object, path || "/");
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key,
    mapReferences(item, convert, selected, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)]));
}
/** Call only on program-generated envelopes; original source values must be excluded by their owner. */
export function projectEvidenceReferences<T>(value: T, bank: EvidenceBank): T {
  return mapReferences(value, reference => selectEvidence(bank, reference as unknown as EvidenceReference), "evidence_id", "") as T;
}
/** Submission envelopes contain no raw source data. Numeric-check indexes are separate fields, not reference objects. */
export function resolveEvidenceSelectionDraft<T>(value: T, bank: readonly string[]): { value: T; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const resolved = mapReferences(value, (reference, path) => {
    try { return resolveEvidenceSelection(bank, reference, path); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; issues.push(...error.issues!); return reference; }
  }, "evidence_index", "") as T;
  return { value: resolved, issues };
}
export function resolveEvidenceSelections<T>(value: T, bank: readonly string[]): T {
  const resolved = resolveEvidenceSelectionDraft(value, bank);
  if (resolved.issues.length) throw new ValidationError(resolved.issues);
  return resolved.value;
}
/** Preserve the canonical schema for stored checkpoints and derive only the model-facing reference fields. */
export function evidenceSelectionSchema(schema: JsonSchema): JsonSchema {
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== "object") return value;
    const entry = value as Record<string, unknown>, properties = entry.properties as Record<string, unknown> | undefined;
    if (properties && Object.hasOwn(properties, "evidence_id") && Array.isArray(entry.required) && entry.required.includes("evidence_id")) {
      const { evidence_id: _id, ...rest } = properties;
      return { ...entry, required: entry.required.map(key => key === "evidence_id" ? "evidence_index" : key),
        properties: { evidence_index: { type: "integer", minimum: 1 }, ...rest } };
    }
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, project(item)]));
  };
  return project(schema) as JsonSchema;
}

/** The Host checks all new entries against this task's registered immutable sources. */
export function validateEvidenceBankSources(bank: readonly string[], sources: ReadonlyMap<string, unknown>, start = 0): void {
  for (let index = start; index < bank.length; index++) {
    const id = bank[index]!, coordinate = parseEvidenceCoordinates(id);
    if (!coordinate || !sources.has(coordinate.input_id))
      fail(`/evidenceBank/${index}`, "evidence_bank_source_invalid", id, "证据目录只能登记本任务的原始输入来源。");
    const raw = sources.get(coordinate.input_id) as { messages?: unknown[] } | undefined;
    if (!Array.isArray(raw?.messages) || coordinate.message_index >= raw.messages.length)
      fail(`/evidenceBank/${index}`, "evidence_bank_source_invalid", id, "证据目录中的消息不存在。");
    const message = raw.messages[coordinate.message_index];
    if (coordinate.kind === "image") {
      if (!evidenceImageAvailable(message)) fail(`/evidenceBank/${index}`, "evidence_bank_source_invalid", id, "证据目录的图片坐标没有真实图片。");
      continue;
    }
    const leaf = evidenceSources(message).find(leaf => leaf.kind === coordinate.kind && leaf.path === coordinate.path);
    if (!leaf || coordinate.end <= coordinate.start || coordinate.end > leaf.text.length ||
      overlapsImagePlaceholder(leaf.text, coordinate.start, coordinate.end))
      fail(`/evidenceBank/${index}`, "evidence_bank_range_invalid", id, "证据目录的文本坐标不在真实可引用原文范围内。");
  }
}
