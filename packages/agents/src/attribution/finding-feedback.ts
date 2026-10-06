import type { AgentRequest, JsonObject, ValidationIssue } from "@eval/contracts";
import { attributionSubmissionSchema } from "./submission-schema.js";
/** Repair context describes the current shallow tool field, never an internal judgment container. */
export function findingIssueContext(request: AgentRequest, _value: unknown, issue: ValidationIssue): JsonObject | undefined {
  if (issue.category !== "structure") return undefined;
  const path = issue.path;
  const schema = attributionSubmissionSchema(request) as any;
  let current = schema;
  for (const part of path.split('/').filter(Boolean)) current = /^\d+$/u.test(part) ? current?.items : current?.properties?.[part];
  if (current===undefined) return undefined;
  return { target: {path},submission_shape:current };
}
