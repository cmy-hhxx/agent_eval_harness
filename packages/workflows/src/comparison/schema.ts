import { comparisonProfile } from "@eval/agents/comparison";
import { attributionProfile } from "@eval/agents/attribution";
import { object, type JsonSchema } from "@eval/contracts";
import template from "../../../../schemas/workflow/export.schema.json" with { type: "json" };
import annotation from "../../../../schemas/workflow/annotation.schema.json" with { type: "json" };
import clusteringResult from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import clusteringTemplate from "../../../../schemas/workflow/clustering.schema.json" with { type: "json" };
// Only export-specific identity, display and trace annotations belong to Workflow.
export const rewrittenSchema = object(object(comparisonProfile.resultSchema!).properties).rewritten as JsonSchema;
export const clusteringSchema: JsonSchema = {
  ...clusteringTemplate,
  properties: {
    ...(clusteringTemplate.properties as Record<string, unknown>),
    result: clusteringResult,
  },
};
const comparison = object(structuredClone(comparisonProfile.resultSchema!).properties);
const attribution = object(structuredClone(attributionProfile.resultSchema!).properties);
const findings = object(attribution.findings);
object(object(findings.items).properties).stage_trace = annotation;
export const outputSchema: JsonSchema = {
  ...template,
  properties: {
    ...template.properties,
    rewritten: rewrittenSchema,
  },
  $defs: {
    ...template.$defs,
    evaluation: {
      ...template.$defs.evaluation,
      properties: {
        ...template.$defs.evaluation.properties,
        summary: attribution.summary,
        findings,
      },
    },
    task_analysis: comparison.task_analysis,
    decision_basis: comparison.decision_basis,
  },
};
