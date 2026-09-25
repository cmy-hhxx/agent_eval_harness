import test from "node:test";
import assert from "node:assert/strict";
import { critiqueAgent, correctnessProfile } from "./index.js";
import example from "./profiles/correctness/example.json" with { type: "json" };
import { evidenceId } from "@eval/tools";

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("Critique correctness runs independently and only accepts final answer evidence", () => {
  assert.deepEqual(Object.keys(critiqueAgent.profiles), ["correctness"]);
  correctnessProfile.validate!(example.request, example.result, audit);
  const draft = {
    ...example.result,
    evidence: [{ evidence_id: evidenceId("input-A", 1, "text", "/content", 0, 5) }],
  };
  assert.deepEqual(correctnessProfile.resolve!(example.request, draft, audit), example.result);
  const invalid = {
    ...example.result,
    evidence: [{ message_index: 0, quote: "计算2+2" }],
  };
  assert.throws(() => correctnessProfile.validate!(example.request, invalid, audit), /只能引用最终回答/);
  assert.throws(
    () => correctnessProfile.resolve!(example.request, { ...draft, verdict: "both_good" }, audit),
    /结构无效/,
  );
});
