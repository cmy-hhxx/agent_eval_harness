import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";

import schema from "./profiles/correctness/output.schema.json" with { type: "json" };
type EvidenceRef = { evidence_id: string; observation?: string };

const validate = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile<unknown>(schema);
export function resolveSubmission(request: AgentRequest, draft: unknown, audit: ToolAudit): unknown {
  if (!validate(draft)) throw new ValidationError(schemaIssues(validate.errors, draft));
  const errors: ValidationIssue[] = [];
  const evidence = (refs: EvidenceRef[], candidate: string, location: string) =>
    refs.flatMap((value, i) => {
      try {
        return [
          resolveEvidence(
            request.sources[candidate].value as {
              messages: Record<string, unknown>[];
            },
            request.sources[candidate].id,
            value,
            candidate,
            audit.viewedImages,
            `${location}/${i}`,
          ),
        ];
      } catch (error) {
        if (error instanceof ValidationError) errors.push(...error.issues!);
        else throw error;
        return [];
      }
    });

  const value = structuredClone(draft) as {
    is_correct: boolean | null;
    correctness_reason: string;
    evidence: EvidenceRef[];
  };
  const resolved = {
    ...value,
    evidence: evidence(value.evidence, "A", "/evidence"),
  };
  if (errors.length) throw new ValidationError(errors);
  return resolved;
}
