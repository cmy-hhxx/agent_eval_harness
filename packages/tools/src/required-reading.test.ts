import test from "node:test";
import assert from "node:assert/strict";
import type { TraceRead } from "@eval/contracts";
import { cite, evidenceSources } from "./evidence.js";
import { RequiredReadBudget } from "./required-reading.js";

const target = (start: number, end: number, path = "/content"): TraceRead => ({
  candidate: "answer", message_index: 0, kind: "text", path, start, end,
});
const inputs = (text = "abcdefgh") => new Map<string, unknown>([["answer", { messages: [{ content: text }] }]]);
const argumentsFor = (offset = 0, path = "/content") => ({ candidate: "answer", message_index: 0, path, offset });

test("trusted overlapping, duplicate and adjacent ranges share one coverage allowance", () => {
  const budget = new RequiredReadBudget(inputs(), [target(0, 4), target(2, 6), target(0, 4), target(6, 8)], 4096);
  const before = { traceReads: [] as TraceRead[] };
  assert.equal(budget.limit, 2);
  assert.equal(budget.isRequired(argumentsFor(), before), true);
  assert.equal(budget.isRequired(argumentsFor(2), before), false);
  assert.equal(budget.charge(argumentsFor(), target(0, 4), before), true);
  assert.equal(budget.used, 1);
  assert.equal(budget.isRequired(argumentsFor(), before), false, "already charged pages cannot be free again through a stale audit");
  assert.equal(budget.isRequired(argumentsFor(4), before), true);
  assert.equal(budget.charge(argumentsFor(4), target(4, 8), before), true);
  assert.equal(budget.remaining, 0);
});

test("each independent range advances from its first uncovered position", () => {
  const budget = new RequiredReadBudget(inputs(), [target(0, 3), target(5, 8)], 4096);
  const audit = { traceReads: [target(0, 1), target(2, 3)] };
  assert.equal(budget.isRequired(argumentsFor(1), audit), true);
  assert.equal(budget.isRequired(argumentsFor(2), audit), false);
  assert.equal(budget.isRequired(argumentsFor(5), audit), true);
  assert.equal(budget.isRequired(argumentsFor(6), audit), false);
  assert.equal(budget.isRequired(argumentsFor(3), audit), false);
  assert.equal(budget.isRequired(argumentsFor(), { traceReads: [target(0, 8)] }), false);
});

test("only valid explicit text requests with automatic full pages qualify", () => {
  const budget = new RequiredReadBudget(inputs(), [target(0, 8)], 4096);
  const audit = { traceReads: [] };
  assert.equal(budget.isRequired({ ...argumentsFor(), max_chars: 16000 }, audit), true);
  for (const args of [
    { ...argumentsFor(), max_chars: 1 }, { ...argumentsFor(), max_chars: 12000 },
    { ...argumentsFor(), candidate: "other" }, { ...argumentsFor(), message_index: 1 },
    { ...argumentsFor(), path: "/other" }, { ...argumentsFor(), path: undefined },
    { ...argumentsFor(), offset: -1 }, { ...argumentsFor(), offset: 0.5 },
    { ...argumentsFor(), extra: true }, null,
  ]) assert.equal(budget.isRequired(args, audit), false);
  const stringSource = new Map<string, unknown>([["answer", { messages: ["abc"] }]]);
  const emptyPath = new RequiredReadBudget(stringSource, [target(0, 3, "")], 4096);
  assert.equal(emptyPath.isRequired(argumentsFor(0, ""), audit), true);
});

test("failed, empty, mismatched and repeated returned ranges do not consume required quota", () => {
  const budget = new RequiredReadBudget(inputs(), [target(0, 8)], 4096);
  const audit = { traceReads: [] };
  for (const returned of [target(0, 0), target(1, 3), target(0, 9), { ...target(0, 3), kind: "json" as const },
    { ...target(0, 3), candidate: "other" }])
    assert.equal(budget.charge(argumentsFor(), returned, audit), false);
  assert.equal(budget.used, 0);
  assert.equal(budget.charge(argumentsFor(), target(0, 8), audit), true);
  assert.equal(budget.charge(argumentsFor(), target(0, 8), audit), false);
  assert.equal(budget.used, 1);
  assert.equal(budget.isRequired(argumentsFor(), audit), false);
});

test("required quota remains finite even if a caller reports tiny new ranges", () => {
  const budget = new RequiredReadBudget(inputs(), [target(0, 8)], 4096);
  const audit = { traceReads: [] };
  assert.equal(budget.charge(argumentsFor(), target(0, 1), audit), true);
  assert.equal(budget.charge(argumentsFor(1), target(1, 2), audit), true);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.isRequired(argumentsFor(2), audit), false);
  assert.equal(budget.charge(argumentsFor(2), target(2, 3), audit), false);
});

test("serialized quotes, control characters and surrogate boundaries fit the planned allowance", () => {
  const text = ('值"\\\n🙂\u0001\ud800').repeat(7000);
  const material = inputs(text), required = target(0, text.length);
  const source = evidenceSources({ content: text }).find((item) => item.kind === "text")!;
  const maxOutputChars = 1024;
  const budget = new RequiredReadBudget(material, [required], maxOutputChars);
  const audit = { traceReads: [] as TraceRead[] };
  let offset = 0;
  while (offset < text.length) {
    const args = argumentsFor(offset);
    assert.equal(budget.isRequired(args, audit), true, "the allowance must cover real serialized pages");
    const page = (end: number) => JSON.stringify({
      source: { kind: "text", path: "/content" }, evidence: [cite(0, source, offset, end)],
      offset, next_offset: end, total_chars: text.length, has_more: end < text.length,
    });
    let low = offset + 1, high = Math.min(offset + 16000, text.length), end = offset;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (page(middle).length <= maxOutputChars - 200) { end = middle; low = middle + 1; }
      else high = middle - 1;
    }
    assert(end > offset);
    assert.equal(budget.charge(args, target(offset, end), audit), true);
    audit.traceReads.push(target(offset, end));
    offset = end;
  }
  assert(budget.used > 14, "large trusted materials must not inherit the autonomous exploration cap");
  assert(budget.used <= budget.limit);
  assert.equal(budget.isRequired(argumentsFor(), audit), false);
});

test("invalid trusted coordinates fail immediately and empty ranges need no allowance", () => {
  assert.equal(new RequiredReadBudget(inputs(), undefined, 4096).limit, 0);
  assert.equal(new RequiredReadBudget(inputs(), [target(3, 3)], 4096).limit, 0);
  for (const invalid of [target(-1, 3), target(4, 3), target(0, 9), target(0.5, 3),
    { ...target(0, 3), kind: "json" as const }, { ...target(0, 3), candidate: "other" },
    { ...target(0, 3), message_index: 1 }, target(0, 3, "/missing")])
    assert.throws(() => new RequiredReadBudget(inputs(), [invalid], 4096), RangeError);
  assert.throws(() => new RequiredReadBudget(inputs(), [target(0, 8)], 128), /输出预算/);
});
