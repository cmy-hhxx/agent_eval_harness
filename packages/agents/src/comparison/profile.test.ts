import test from "node:test";
import assert from "node:assert/strict";
import { comparisonAgent, comparisonProfile } from "./index.js";
import example from "./profiles/default/example.json" with { type: "json" };
import { evidenceId } from "@eval/tools";

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("Comparison runs with only its own JSON input, schema and evidence", () => {
  assert.deepEqual(Object.keys(comparisonAgent.profiles), ["default"]);
  comparisonProfile.validate!(example.request, example.result, audit);
  const { decision_basis, evaluations, ...rest } = structuredClone(example.result);
  const draft = {
    ...rest,
    evaluations: Object.fromEntries(
      Object.entries(evaluations).map(([label, review]) => [
        label,
        {
          ...review,
          findings: review.findings.map((finding) => ({
            ...finding,
            finding_id: "finding",
            evidence: [
              {
                evidence_id: evidenceId(`input-${label}`, 1, "text", "/content", 0, 5),
              },
            ],
          })),
        },
      ]),
    ),
    decision_basis: {
      ...decision_basis,
      decisive_findings: ["A", "B"].map((candidate) => ({
        candidate,
        finding_id: "finding",
      })),
    },
  };
  assert.deepEqual(comparisonProfile.resolve!(example.request, draft, audit), example.result);
  const invalid = structuredClone(example.result);
  invalid.evaluations.A.findings[0].evidence[0].quote = "invented";
  assert.throws(() => comparisonProfile.validate!(example.request, invalid, audit), /逐字原文/);
  const objective = structuredClone(example.request);
  objective.input.ground_truth.available = true;
  assert.throws(() => comparisonProfile.validate!(objective, example.result, audit), /独立正确性/);
});
