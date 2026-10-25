import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";
import { attributionSubmissionSchema } from "./submission-schema.js";
/** Repair context describes the current shallow tool field, never an internal judgment container. */
export function findingIssueContext(request: AgentRequest, _value: unknown, issue: ValidationIssue): JsonObject | undefined {
  if (issue.category !== "structure" && !["investigation_incomplete", "investigation_stage_evidence"].includes(issue.code)) return undefined;
  const path = issue.path;
  const schema = attributionSubmissionSchema(request) as any;
  if(issue.code==="schema_additionalProperties"){
    const parts=path.split('/').filter(Boolean),field=parts.pop();
    let parent=schema;
    for(const part of parts)parent=/^\d+$/u.test(part)?parent?.items:parent?.properties?.[part];
    if(parent?.properties)return {target:{path},object_path:'/'+parts.join('/'),remove_field:field,
      allowed_fields:Object.keys(parent.properties),required_fields:parent.required??[],additionalProperties:false};
  }
  let current = schema;
  for (const part of path.split('/').filter(Boolean)) current = /^\d+$/u.test(part) ? current?.items : current?.properties?.[part];
  if (current===undefined) return undefined;
  return { target: {path},submission_shape:current,
    ...(["investigation_incomplete","investigation_stage_evidence"].includes(issue.code)
      ? { investigation_fact_shape:schema.properties.investigation_facts.items } : {}) };
}
