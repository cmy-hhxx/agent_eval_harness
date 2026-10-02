import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { rewriteProfile } from "./index.js";
import cases from "./fixtures/quality.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
for (const sample of cases) test(`rewrite quality regression: ${sample.name}`, () => {
  const request = { input: { kind: "comparison", items: [sample.item] }, sources: {} };
  rewriteProfile.validate!(request, { rewrites: [{ id: sample.item.id, text: sample.approved }] }, audit);
  if (sample.error_code)
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: sample.item.id, text: sample.rejected }] }, audit),
      (error: unknown) => error instanceof ValidationError && !!error.issues?.some((issue) => issue.code === sample.error_code));
  // Semantic counterexamples are a review rubric, not claimed as mechanically rejected.
});
