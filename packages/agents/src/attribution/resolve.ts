import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type TaskAnalysis,
  type ValidationIssue,
} from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import schema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };

type EvidenceRef = { evidence_id: string; observation?: string };
type DraftFinding = {
  finding_id: string;
  evidence: EvidenceRef[];
  [key: string]: unknown;
};
type DraftCriterionAssessment = { criterion_id: string; evidence: EvidenceRef[]; [key: string]: unknown };

const validate = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
export function resolveSubmission(request: AgentRequest, draft: unknown, audit: ToolAudit): unknown {
  if (!validate(draft)) throw new ValidationError(schemaIssues(validate.errors, draft));
  const errors: ValidationIssue[] = [];
  const source = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const resolveRefs = (refs: EvidenceRef[], location: string) =>
    refs.flatMap((value, i) => {
      try {
        return [resolveEvidence(source, value, "answer", audit.viewedImages, `${location}/${i}`)];
      } catch (error) {
        if (error instanceof ValidationError) errors.push(...error.issues!);
        else throw error;
        return [];
      }
    });
  const value = structuredClone(draft) as {
    correctness_evidence: EvidenceRef[];
    findings: DraftFinding[];
    criterion_assessments: DraftCriterionAssessment[];
  };
  const findings = value.findings.map((finding, index) => ({
    ...finding,
    evidence: resolveRefs(finding.evidence, `/findings/${index}/evidence`),
  }));
  const resolved = {
    ...value,
    has_standard_answer: (request.input.ground_truth as { available: boolean }).available,
    task_analysis: structuredClone(request.input.task_analysis as unknown as TaskAnalysis),
    findings,
    criterion_assessments: value.criterion_assessments.map((assessment, index) => ({
      ...assessment,
      evidence: resolveRefs(assessment.evidence, `/criterion_assessments/${index}/evidence`),
    })),
    correctness_evidence: resolveRefs(value.correctness_evidence, "/correctness_evidence"),
  };
  if (errors.length) throw new ValidationError(errors);
  return resolved;
}
