import { comparisonProfile } from "@eval/agents/comparison";
import { object, type JsonSchema } from "@eval/contracts";
import template from "./export.schema.json" with { type: "json" };
import annotation from "./annotation.schema.json" with { type: "json" };
// Only export-specific identity, display and trace annotations belong to Workflow.
const comparison = object(structuredClone(comparisonProfile.resolvedSchema!).properties);
const review = object(object(object(comparison.evaluations).properties).A);
const reviewProperties = object(review.properties);
const finding = object(object(reviewProperties.findings).items);
object(finding.properties).stage_trace = annotation;
export const outputSchema: JsonSchema = {
  ...template,
  $defs: {
    ...template.$defs,
    evaluation: {
      ...template.$defs.evaluation,
      properties: {
        ...template.$defs.evaluation.properties,
        ...reviewProperties,
      },
    },
    task_analysis: comparison.task_analysis,
    decision_basis: comparison.decision_basis,
  },
};
