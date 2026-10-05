import test from "node:test";
import assert from "node:assert/strict";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with { type: "json" };
import { findingAppliesToPair } from "./pair-scope.js";
import type { ComparisonInput } from "./types.js";

test("foreign normative coordinates cannot become own common instruction proof or private scope exclusions", () => {
  const request = structuredClone(example.request);
  const input = request.input as unknown as ComparisonInput;
  const finding = input.attributions.A!.findings[0]!;
  const common = input.task_analysis.requirements[0]!.text;
  request.sources.A.value.messages[0] = { type: "message", role: "system", content: common };
  finding.dimension = "instruction_following";
  finding.evidence.unshift({ ...canonicalEvidence(input.candidates.B!.candidate_id, 0, common), source: "B", source_input_id: input.candidates.B!.candidate_id });
  assert.equal(findingAppliesToPair(input, "A", 0, request.sources.A.value), false);
  finding.evidence.unshift(canonicalEvidence(input.candidates.A!.candidate_id, 0, common));
  assert.equal(findingAppliesToPair(input, "A", 0, request.sources.A.value), true);
  finding.dimension = "correctness";
  const privateRule = "只使用蓝色字体";
  request.sources.A.value.messages[0]!.content = privateRule;
  finding.evidence = [canonicalEvidence(input.candidates.A!.candidate_id, 1, "2+2=4"),
    { ...canonicalEvidence(input.candidates.B!.candidate_id, 0, privateRule), source: "B", source_input_id: input.candidates.B!.candidate_id }];
  assert.equal(findingAppliesToPair(input, "A", 0, request.sources.A.value), true);
  finding.evidence.push(canonicalEvidence(input.candidates.A!.candidate_id, 0, privateRule));
  assert.equal(findingAppliesToPair(input, "A", 0, request.sources.A.value), false);
});
