import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type ToolAudit } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonSlots, type ComparisonResult } from "./index.js";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };

test("missing importance feedback shows the decision-only row without moving or accepting the draft", () => {
  const request = structuredClone(example.request), registry = new AgentRegistry([comparisonAgent]);
  const draft = requestComparisonSubmission(request, structuredClone(example.result) as ComparisonResult);
  const row = draft.comparisons[0]!;
  delete (row as unknown as Record<string,unknown>).importance;
  const before = structuredClone(draft);
  assert.throws(() => registry.resolve({ agent: "comparison", profile: "default", request }, draft, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.path === "/comparisons/0/importance")!;
    const expected = issue.expected as Record<string, any>;
    assert.equal(expected.missingProperty, "importance");
    assert.equal(expected.target.slot_index, 0);
    assert.equal(expected.target.path, "/comparisons/0");
    assert.deepEqual(expected.submission_shape.required, ["importance"]);
    assert.deepEqual(Object.keys(expected.submission_shape.properties).sort(),["better_candidate","importance"]);
    return true;
  });
  assert.deepEqual(draft, before);
});

test("wrong comparison length feedback identifies the complete ordered slot plan", () => {
  const request = structuredClone(example.request), registry = new AgentRegistry([comparisonAgent]);
  const draft = requestComparisonSubmission(request, structuredClone(example.result) as ComparisonResult);
  draft.comparisons.push(structuredClone(draft.comparisons[0]!));
  assert.throws(() => registry.resolve({ agent: "comparison", profile: "default", request }, draft, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.path === "/comparisons" && issue.code === "schema_maxItems")!;
    const expected = issue.expected as Record<string, any>;
    assert.equal(expected.limit, comparisonSlots(request).length);
    assert.equal(expected.submission_shape.type, "array");
    assert.equal(expected.submission_shape.maxItems, comparisonSlots(request).length);
    assert.equal(expected.slot_count, comparisonSlots(request).length);
    assert.deepEqual(expected.slot_order.map((slot: { slot_index: number }) => slot.slot_index), comparisonSlots(request).map((_, index) => index));
    return true;
  });
});

test("non-object submissions receive the root container instead of a candidate container", () => {
  const registry = new AgentRegistry([comparisonAgent]), request = structuredClone(example.request);
  assert.throws(() => registry.resolve({ agent: "comparison", profile: "default", request }, null, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.path === "/" && issue.code === "schema_type")!;
    const expected = issue.expected as Record<string, any>;
    assert.equal(expected.target.path, "/");
    assert.deepEqual(expected.submission_shape.required, ["a_summary", "b_summary", "comparisons", "relative_preference", "a_tradeoff", "b_tradeoff"]);
    return true;
  });
});
