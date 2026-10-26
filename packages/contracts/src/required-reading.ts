import type { TraceRead, ValidationIssue } from "./primitives.js";
import { evidenceId } from "./evidence.js";

/** Only validator-issued ranges can extend the protected source-reading budget. */
export function validationRequiredReads(issues: readonly ValidationIssue[]): TraceRead[] {
  return issues.filter(issue => issue.code === "investigation_read_required").flatMap(issue => {
    const expected = issue.expected as { read_requests?: unknown[] } | undefined;
    return (expected?.read_requests ?? [issue.expected]).map(value => {
      const read = value as TraceRead;
      if (!read || typeof read.candidate !== "string" || !read.candidate ||
        !Number.isSafeInteger(read.message_index) || read.message_index < 0 || !["text", "json"].includes(read.kind) ||
        typeof read.path !== "string" || read.kind === "json" && read.path !== "" ||
        !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start)
        throw new RangeError("Invalid validator-required trace range");
      return { ...read };
    });
  });
}

const MAX_PAGE_CHARS = 16000;
const SURROGATE_BOUNDARY_CHARS = 10;
interface RequiredRange {
  target: TraceRead;
  inputId: string;
  text: string;
}

/** Retain earlier page allowances; only previously unregistered source characters add pages. */
export function extendRequiredReadRanges(current: readonly RequiredRange[], added: readonly RequiredRange[]): RequiredRange[] {
  const known = mergeRequiredReadRanges(current), fresh: RequiredRange[] = [];
  for (const range of mergeRequiredReadRanges(added)) {
    let cursor = range.target.start;
    for (const prior of known.filter(prior => prior.inputId === range.inputId &&
      prior.target.candidate === range.target.candidate && prior.target.message_index === range.target.message_index &&
      prior.target.kind === range.target.kind && prior.target.path === range.target.path)) {
      if (prior.text !== range.text) throw new RangeError("Required trace ranges disagree on their source text");
      if (prior.target.end <= cursor || prior.target.start >= range.target.end) continue;
      if (prior.target.start > cursor) fresh.push({ ...range, target: { ...range.target, start: cursor, end: prior.target.start } });
      cursor = Math.max(cursor, prior.target.end);
    }
    if (cursor < range.target.end) fresh.push({ ...range, target: { ...range.target, start: cursor } });
  }
  return [...current, ...fresh];
}

/** Validate and union trusted ranges without changing the supplied records. */
export function mergeRequiredReadRanges(ranges: readonly RequiredRange[]): RequiredRange[] {
  if (!Array.isArray(ranges)) throw new RangeError("Invalid required trace ranges");
  const grouped = new Map<string, RequiredRange[]>();
  for (const range of ranges) {
    const target = range?.target;
    if (!target || !["text", "json"].includes(target.kind) || typeof target.candidate !== "string" || !target.candidate ||
      typeof target.path !== "string" || target.kind === "json" && target.path !== "" || !Number.isSafeInteger(target.message_index) || target.message_index < 0 ||
      !Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) || target.start < 0 || target.end < target.start ||
      typeof range.text !== "string" || target.end > range.text.length)
      throw new RangeError("Invalid required trace range");
    evidenceId(range.inputId, target.message_index, target.kind, target.path, target.start, target.end);
    if (target.start === target.end) continue;
    const key = JSON.stringify([target.candidate, target.message_index, target.kind, target.path]);
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
    source: { kind: target.kind, path: target.path },
    selection_path: target.path,
    evidence: [{
      reference: { evidence_id: evidenceId(inputId, target.message_index, target.kind, target.path, longestOffset, longestOffset) },
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
