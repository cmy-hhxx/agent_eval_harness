import test from "node:test";
import assert from "node:assert/strict";
import { comparisonAgent, comparisonProfile } from "./index.js";
import example from "./profiles/default/example.json" with { type: "json" };

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("Comparison ranks a group and references attribution findings", () => {
  assert.deepEqual(Object.keys(comparisonAgent.profiles), ["default"]);
  comparisonProfile.validate!(example.request, example.result, audit);

  const duplicate = structuredClone(example.result);
  duplicate.ranking = [["A", "A"]];
  assert.throws(() => comparisonProfile.validate!(example.request, duplicate, audit), /重复|恰好/);

  const incomplete = structuredClone(example.result);
  incomplete.assessments = { A: { meets_core: true, summary: "x" } } as unknown as typeof incomplete.assessments;
  assert.throws(() => comparisonProfile.validate!(example.request, incomplete, audit), /每个候选/);

  const missingFinding = structuredClone(example.result);
  missingFinding.decision_basis.decisive_findings = [{ candidate: "A", finding_index: 9 }];
  assert.throws(
    () => comparisonProfile.validate!(example.request, missingFinding, audit),
    /归因结果中的既有 finding/,
  );

  const contradiction = structuredClone(example.request);
  contradiction.input.attributions.A.is_correct = false;
  assert.throws(
    () => comparisonProfile.validate!(contradiction, example.result, audit),
    /不能同时判定满足核心要求/,
  );
});
