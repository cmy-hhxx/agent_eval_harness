import type { ToolAudit, TraceRead } from "@eval/contracts";

/** Verify exact source coordinates without treating a search of unseen text as a read. */
export function traceReadCoverage(audit: Pick<ToolAudit, "traceReads">, target: TraceRead): {
  covered: boolean;
  missing: { start: number; end: number }[];
} {
  if (!Number.isSafeInteger(target.start) || !Number.isSafeInteger(target.end) ||
    target.start < 0 || target.end < target.start)
    throw new RangeError("Invalid trace coverage range");
  const ranges = audit.traceReads.filter((read) =>
    read.candidate === target.candidate && read.message_index === target.message_index &&
    read.kind === target.kind && read.path === target.path &&
    Number.isSafeInteger(read.start) && Number.isSafeInteger(read.end) &&
    read.start >= 0 && read.end > read.start,
  ).sort((a, b) => a.start - b.start);
  const missing: { start: number; end: number }[] = [];
  let cursor = target.start;
  for (const range of ranges) {
    if (cursor === target.end || range.start >= target.end) break;
    if (range.end <= cursor) continue;
    if (range.start > cursor) missing.push({ start: cursor, end: range.start });
    cursor = Math.min(target.end, range.end);
  }
  if (cursor < target.end) missing.push({ start: cursor, end: target.end });
  return { covered: !missing.length, missing };
}
