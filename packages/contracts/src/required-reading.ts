import type { TraceRead } from "./index.js";
import { evidenceId } from "./evidence.js";

const MAX_PAGE_CHARS = 16000;
const SURROGATE_BOUNDARY_CHARS = 10;
interface RequiredRange {
  target: TraceRead;
  inputId: string;
  text: string;
}

/** Validate and union trusted ranges without changing the supplied records. */
export function mergeRequiredReadRanges(ranges: readonly RequiredRange[]): RequiredRange[] {
  if (!Array.isArray(ranges)) throw new RangeError("Invalid required trace ranges");
  const grouped = new Map<string, RequiredRange[]>();
  for (const range of ranges) {
    const target = range?.target;
    if (!target || target.kind !== "text" || typeof target.candidate !== "string" || !target.candidate ||
      typeof target.path !== "string" || !Number.isSafeInteger(target.message_index) || target.message_index < 0 ||
      !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end < target.start ||
      typeof range.text !== "string" || target.end > range.text.length)
      throw new RangeError("Invalid required trace range");
    evidenceId(range.inputId, target.message_index, "text", target.path, target.start, target.end);
    if (target.start === target.end) continue;
    const key = JSON.stringify([target.candidate, target.message_index, target.path]);
    const sourceRanges = grouped.get(key) ?? [];
    if (sourceRanges[0] && (sourceRanges[0].text !== range.text || sourceRanges[0].inputId !== range.inputId))
      throw new RangeError("Required trace ranges disagree on their source text");
    sourceRanges.push({ target: { ...target }, inputId: range.inputId, text: range.text });
    grouped.set(key, sourceRanges);
  }
  return [...grouped.values()].flatMap((sourceRanges) => {
    const merged: RequiredRange[] = [];
    for (const range of sourceRanges.sort((a, b) => a.target.start - b.target.start)) {
      const last = merged.at(-1);
      if (last && range.target.start <= last.target.end) last.target.end = Math.max(last.target.end, range.target.end);
      else merged.push(range);
    }
    return merged;
  });
}

/** JSON string cost, with a separate allowance for pairs split at page boundaries. */
function escapedCharacterCost(text: string, offset: number): number {
  const code = text.charCodeAt(offset);
  if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) return 2;
  if (code < 32) return 6;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(offset + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 1 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = text.charCodeAt(offset - 1);
    return previous >= 0xd800 && previous <= 0xdbff ? 1 : 6;
  }
  return 1;
}

/** A shared serialized upper bound; any registered tool name may declare the writer capability. */
export function toolBudgetMetadataChars(toolNames: readonly string[]): number {
  const counter = Number.MAX_SAFE_INTEGER;
  return JSON.stringify({ budget: {
    exploration: { used: counter, remaining: counter },
    required_reads: { used: counter, remaining: counter, covered: false },
    draft_writes: { used: counter, remaining: counter, tools: toolNames },
  } }).length + 1;
}

function pageLimit({ target, inputId, text }: RequiredRange, maxOutputChars: number, budgetMetadataChars: number): number {
  const longestOffset = text.length;
  const metadata = JSON.stringify({
    source: { kind: "text", path: target.path },
    selection_path: target.path,
    evidence: [{
      reference: { evidence_id: evidenceId(inputId, target.message_index, "text", target.path, longestOffset, longestOffset) },
      message_index: target.message_index,
      quote: "",
    }],
    offset: longestOffset,
    next_offset: longestOffset,
    total_chars: text.length,
    has_more: false,
  }).length;
  const available = maxOutputChars - budgetMetadataChars - metadata - SURROGATE_BOUNDARY_CHARS;
  let pages = 0, offset = target.start;
  while (offset < target.end) {
    let end = offset, cost = 0;
    const maximumEnd = Math.min(offset + MAX_PAGE_CHARS, target.end);
    while (end < maximumEnd) {
      const nextCost = escapedCharacterCost(text, end);
      if (cost + nextCost > available) break;
      cost += nextCost;
      end++;
    }
    if (end === offset) throw new RangeError("工具输出预算不足以完整返回一条必读证据及预算信息");
    pages++;
    offset = end;
  }
  // Coverage already supplied through another tool can shift the first page boundary.
  return pages + 1;
}

/** Derive the same finite mandatory-page allowance in Host and Worker from actual source text. */
export function requiredReadCallLimit(ranges: readonly RequiredRange[], maxOutputChars: number, budgetMetadataChars: number): number {
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars <= 0) throw new RangeError("Invalid tool output budget");
  if (!Number.isSafeInteger(budgetMetadataChars) || budgetMetadataChars <= 0) throw new RangeError("Invalid tool budget metadata allowance");
  return mergeRequiredReadRanges(ranges).reduce((total, range) => total + pageLimit(range, maxOutputChars, budgetMetadataChars), 0);
}
