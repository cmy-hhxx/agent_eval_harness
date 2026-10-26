import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";
import schema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import { comparisonSlotChoices } from "./slots.js";

/** Show the current typed container; the rejected draft and source decisions remain untouched. */
export function comparisonIssueContext(request: AgentRequest, _value: unknown, issue: ValidationIssue): JsonObject | undefined {
  if (issue.category !== "structure") return undefined;
  if (issue.path === "/comparisons") {
    const slots = comparisonSlotChoices(request);
    return { target: { path: "/comparisons" }, submission_shape: { type: "array",
      minItems: slots.filter(slot => !slot.optional).length, maxItems: slots.length, items: { type: "object" } },
      required_slot_count: slots.filter(slot => !slot.optional).length,
      slots: slots.map(({ slot_index, aspect, optional, kind }) => ({ slot_index, aspect, optional, kind })) };
  }
  const match = /^\/comparisons\/(0|[1-9]\d*)(?:\/|$)/u.exec(issue.path);
  if (match) {
    const index = Number(match[1]), slot = comparisonSlotChoices(request)[index];
    if (!slot) return undefined;
    const row = slot.kind === "resource" ? schema.$defs.resource : schema.$defs.commentary;
    return { target: { slot_index: index, index_base: 0, path: `/comparisons/${index}`, aspect: slot.aspect, optional: slot.optional },
      submission_shape: { ...structuredClone(row), properties: { ...structuredClone(row.properties),
        slot_index: { const: index }, kind: { const: slot.kind },
        ...(slot.kind === "resource" ? {} : { better_candidate: { enum: [...slot.advantage_candidates, null] } }) } } };
  }
  if (issue.path === "/") return { target: { path: "/" }, submission_shape: structuredClone(schema) };
  if (issue.path === "/assessments")
    return { target: { path: issue.path }, submission_shape: structuredClone(schema.properties.assessments) };
  return undefined;
}
