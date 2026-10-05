import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";
import schema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import { comparisonSlotChoices } from "./slots.js";

/** Show the current typed container; the rejected draft and source decisions remain untouched. */
export function comparisonIssueContext(request: AgentRequest, _value: unknown, issue: ValidationIssue): JsonObject | undefined {
  if (issue.category !== "structure") return undefined;
  if (issue.path === "/comparisons") {
    const slots = comparisonSlotChoices(request);
    return { target: { path: "/comparisons" }, submission_shape: { type: "array", minItems: slots.length, maxItems: slots.length,
      items: { type: ["object", "null"] } },
      slot_count: slots.length, slot_order: slots.map(({ slot_index, aspect, optional }) => ({ slot_index, aspect, optional })) };
  }
  const match = /^\/comparisons\/(0|[1-9]\d*)(?:\/|$)/u.exec(issue.path);
  if (match) {
    const index = Number(match[1]), slot = comparisonSlotChoices(request)[index];
    if (!slot) return undefined;
    const row = schema.properties.comparisons.items;
    return { target: { slot_index: index, index_base: 0, path: `/comparisons/${index}`, aspect: slot.aspect, optional: slot.optional },
      submission_shape: { ...structuredClone(row), type: slot.optional ? ["object", "null"] : "object",
        properties: { ...structuredClone(row.properties), better_candidate: { enum: [...slot.advantage_candidates, null] } } } };
  }
  if (issue.path === "/") return { target: { path: "/" }, submission_shape: structuredClone(schema) };
  if (issue.path === "/assessments" || issue.path.startsWith("/assessments/"))
    return { target: { path: "/assessments" }, submission_shape: structuredClone(schema.properties.assessments) };
  return undefined;
}
