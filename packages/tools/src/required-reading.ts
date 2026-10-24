import type { ToolAudit, TraceRead } from "@eval/contracts";
import { mergeRequiredReadRanges, requiredReadCallLimit } from "@eval/contracts";
import { evidenceSources } from "./evidence.js";
import { traceReadCoverage } from "./trace-audit.js";

const MAX_PAGE_CHARS = 16000;
type ReadAudit = Pick<ToolAudit, "traceReads">;
interface RequiredRange {
  target: TraceRead;
  inputId: string;
  text: string;
}
interface ReadArguments {
  candidate: string;
  message_index: number;
  path: string;
  offset: number;
  max_chars: number;
}

function readArguments(value: unknown): ReadArguments | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !["candidate", "message_index", "path", "offset", "max_chars"].includes(key)) ||
    typeof args.candidate !== "string" || !args.candidate || typeof args.path !== "string" ||
    !Number.isSafeInteger(args.message_index) || (args.message_index as number) < 0 ||
    (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0)) ||
    (args.max_chars !== undefined && (!Number.isSafeInteger(args.max_chars) || (args.max_chars as number) < 1 || (args.max_chars as number) > MAX_PAGE_CHARS))) return;
  return {
    candidate: args.candidate,
    message_index: args.message_index as number,
    path: args.path,
    offset: (args.offset as number | undefined) ?? 0,
    max_chars: (args.max_chars as number | undefined) ?? MAX_PAGE_CHARS,
  };
}

/** A finite allowance for new pages of trusted source ranges; exploration keeps its own budget. */
export class RequiredReadBudget {
  readonly limit: number;
  private count = 0;
  private readonly ranges: RequiredRange[];
  private readonly chargedReads: TraceRead[] = [];

  constructor(inputs: ReadonlyMap<string, unknown>, inputIds: ReadonlyMap<string, string>, requiredReads: readonly TraceRead[] | undefined, maxOutputChars: number, budgetMetadataChars: number) {
    const ranges: RequiredRange[] = [];
    for (const read of requiredReads ?? []) {
      if (!read || !["text", "json"].includes(read.kind) || typeof read.candidate !== "string" || !read.candidate ||
        typeof read.path !== "string" || read.kind === "json" && read.path !== "" || !Number.isSafeInteger(read.message_index) || read.message_index < 0 ||
        !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end < read.start)
        throw new RangeError("Invalid required trace range");
      const input = inputs.get(read.candidate) as { messages?: unknown[] } | undefined;
      if (!input || !Array.isArray(input.messages) || read.message_index >= input.messages.length)
        throw new RangeError("Required trace source is unavailable");
      const source = evidenceSources(input.messages[read.message_index]).find((item) => item.kind === read.kind && item.path === read.path);
      if (!source || read.end > source.text.length) throw new RangeError("Required trace range is outside its source");
      const inputId = inputIds.get(read.candidate);
      if (!inputId) throw new RangeError("Required trace input identity is unavailable");
      ranges.push({ target: { ...read }, inputId, text: source.text });
    }
    this.ranges = mergeRequiredReadRanges(ranges);
    this.limit = requiredReadCallLimit(this.ranges, maxOutputChars, budgetMetadataChars);
  }

  get used(): number { return this.count; }
  get remaining(): number { return Math.max(0, this.limit - this.count); }
  covered(audit: ReadAudit): boolean {
    return this.ranges.every(({ target }) => traceReadCoverage(audit, target).covered);
  }

  private nextRange(args: ReadArguments, audit: ReadAudit): RequiredRange | undefined {
    const coverage = { traceReads: [...audit.traceReads, ...this.chargedReads] };
    return this.ranges.find(({ target }) => target.candidate === args.candidate &&
      target.message_index === args.message_index && target.path === args.path &&
      traceReadCoverage(coverage, target).missing[0]?.start === args.offset &&
      args.max_chars >= Math.min(MAX_PAGE_CHARS, target.end - args.offset));
  }

  isRequired(value: unknown, audit: ReadAudit): boolean {
    const args = readArguments(value);
    return this.remaining > 0 && args !== undefined && this.nextRange(args, audit) !== undefined;
  }

  /** Charge only a successful, newly returned range using the audit from before execution. */
  charge(value: unknown, returnedRead: TraceRead, beforeAudit: ReadAudit): boolean {
    const args = readArguments(value);
    if (this.remaining === 0 || !args) return false;
    const range = this.nextRange(args, beforeAudit);
    if (!range || !returnedRead || returnedRead.kind !== range.target.kind || returnedRead.candidate !== args.candidate ||
      returnedRead.message_index !== args.message_index || returnedRead.path !== args.path ||
      returnedRead.start !== args.offset || !Number.isSafeInteger(returnedRead.end) || returnedRead.end <= returnedRead.start ||
      returnedRead.end > range.text.length || returnedRead.end - returnedRead.start > MAX_PAGE_CHARS) return false;
    this.count++;
    this.chargedReads.push({ ...returnedRead });
    return true;
  }
}
