import test from "node:test";
import assert from "node:assert/strict";
import type { TraceRead } from "@eval/contracts";
import { traceReadCoverage } from "./trace-audit.js";

const target: TraceRead = { candidate: "answer", message_index: 3, kind: "text", path: "/content/0/text", start: 0, end: 100 };
const read = (start: number, end: number): TraceRead => ({ ...target, start, end });

test("coverage joins unordered overlapping and adjacent reads, retaining precise unread gaps", () => {
  const traceReads = [read(70, 90), read(20, 40), read(0, 20), read(30, 60), read(90, 120)];
  assert.deepEqual(traceReadCoverage({ traceReads }, target), {
    covered: false, missing: [{ start: 60, end: 70 }],
  });
  assert.deepEqual(traceReadCoverage({ traceReads: [...traceReads, read(60, 70)] }, target), {
    covered: true, missing: [],
  });
  assert.deepEqual(traceReadCoverage({ traceReads }, { ...target, start: 10, end: 50 }), {
    covered: true, missing: [],
  });
  assert.deepEqual(traceReads, [read(70, 90), read(20, 40), read(0, 20), read(30, 60), read(90, 120)],
    "coverage checks must not mutate the stored read order");
});

test("coverage cannot be borrowed from another candidate, message, path, or serialized JSON source", () => {
  const traceReads = [
    { ...read(0, 100), candidate: "B" },
    { ...read(0, 100), message_index: 4 },
    { ...read(0, 100), path: "/content/1/text" },
    { ...read(0, 100), kind: "json" as const },
  ];
  assert.deepEqual(traceReadCoverage({ traceReads }, target), {
    covered: false, missing: [{ start: 0, end: 100 }],
  });
});

test("coverage is vacuous for an empty target but rejects invalid target coordinates", () => {
  assert.deepEqual(traceReadCoverage({ traceReads: [] }, { ...target, end: 0 }), {
    covered: true, missing: [],
  });
  for (const range of [{ start: -1, end: 100 }, { start: 50, end: 49 }, { start: 0.5, end: 100 },
    { start: 0, end: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => traceReadCoverage({ traceReads: [] }, { ...target, ...range }), RangeError);
});
