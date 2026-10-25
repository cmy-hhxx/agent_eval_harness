import { comparisonProfile } from "@eval/agents/comparison";
import { attributionProfile } from "@eval/agents/attribution";
import { object, type JsonSchema } from "@eval/contracts";
import template from "../../../../schemas/workflow/export.schema.json" with { type: "json" };
import clusteringResult from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import clusteringTemplate from "../../../../schemas/workflow/clustering.schema.json" with { type: "json" };
import rewritten from "../../../../schemas/workflow/rewritten.schema.json" with { type: "json" };
// Only export-specific identity, display and trace annotations belong to Workflow.
export const rewrittenSchema: JsonSchema = rewritten;
export const clusteringSchema: JsonSchema = {
  ...clusteringTemplate,
  properties: {
    ...(clusteringTemplate.properties as Record<string, unknown>),
    result: { ...clusteringResult, properties: { ...clusteringResult.properties, rewritten: rewrittenSchema } },
  },
};
const comparison = object(structuredClone(comparisonProfile.resultSchema!).properties);
// Display names and accepted rewrites can expand the judge's concise wording.
const decision = object(object(comparison.decision_basis).properties);
const aligned = object(object(object(decision.comparisons).items).properties);
delete object(aligned.aspect).maxLength;
export const outputSchema: JsonSchema = {
  ...template,
  properties: {
    ...template.properties,
    rewritten: rewrittenSchema,
  },
  $defs: {
    ...template.$defs,
    criterion: object(comparisonProfile.resultSchema!.$defs).criterion,
    evaluation: structuredClone(attributionProfile.resultSchema!),
    task_analysis: comparison.task_analysis,
    decision_basis: comparison.decision_basis,
  },
};
