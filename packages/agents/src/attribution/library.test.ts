import test from "node:test";
import assert from "node:assert/strict";
import { applyAttribution, emptyLibrary, projectLibrary } from "./library.js";
import type { AttributionFinding } from "./types.js";

type Draft = AttributionFinding;
const finding = (label: string, component: string, node_id: string | null = null): Draft => ({
  finding_id: label,
  type: "problem",
  dimension: "correctness",
  stage: "final_answer",
  importance: "high",
  text: label,
  reason: "r",
  evidence: [{ message_index: 3, quote: "q" }],
  assessment: {
    requirement_index: 0,
    observation: "o",
    evidence_status: "established",
    impact: "i",
  },
  problem: { node_id, component, label, definition: "d" },
});
const receipt = (findings: Draft[], input_id: string) => ({
  run_id: "run",
  task_id: "t",
  submission_id: "s",
  version: "a_fast",
  batch_id: "b",
  case_id: "c",
  input_id,
  source: { file: "f.jsonl", line: 7 },
  findings,
  at: "2026-01-01T00:00:00.000Z",
});

test("attribution tree groups by component, recalls nodes and keeps sample lineage", () => {
  let library = emptyLibrary("a_fast");
  library = applyAttribution(library, receipt([finding("色值工具返回错误", "色值工具")], "in-1"));
  const component = Object.values(library.nodes).find((node) => node.kind === "component")!;
  const problem = Object.values(library.nodes).find((node) => node.kind === "problem")!;
  assert.equal(problem.parent, component.id);
  assert.equal(library.occurrences.length, 1);
  assert.equal(library.occurrences[0].input_id, "in-1");
  assert.equal(library.occurrences[0].source.line, 7);
  assert.equal(library.occurrences[0].message_index, 3);

  library = applyAttribution(library, receipt([finding("色值工具返回错误", "色值工具", problem.id)], "in-2"));
  assert.equal(library.occurrences.length, 2);
  assert.equal(Object.values(library.nodes).filter((node) => node.kind === "problem").length, 1);
  assert.equal(library.occurrences[1].classification, "recalled");

  library = applyAttribution(library, receipt([finding("色值工具返回错误", "色值工具", problem.id)], "in-2"));
  assert.equal(library.occurrences.length, 2, "idempotent by node + input + finding");

  const projection = projectLibrary(library);
  assert.equal(projection.components.length, 1);
  assert.equal(projection.components[0].problems[0].occurrences, 2);

  const strength: Draft = { ...finding("无", "模型自身推理"), type: "strength", problem: null };
  library = applyAttribution(library, receipt([strength], "in-3"));
  assert.equal(library.occurrences.length, 2, "strengths are not attached to the tree");
});
