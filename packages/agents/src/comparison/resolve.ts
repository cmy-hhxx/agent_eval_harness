import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import type { Finding, PairwiseResult } from "./types.js";
import schema from "./profiles/default/output.schema.json" with { type: "json" };
type EvidenceRef = { evidence_id: string; observation?: string };
type DraftFinding = Omit<Finding, "evidence"> & {
  finding_id: string;
  evidence: EvidenceRef[];
};
interface DraftPair extends Omit<PairwiseResult, "evaluations" | "decision_basis"> {
  evaluations: Record<string, { summary: string; findings: DraftFinding[] }>;
  decision_basis: {
    tradeoff: string;
    decisive_findings: { candidate: string; finding_id: string }[];
    counterevidence: { candidate: string; finding_id: string }[];
  };
}

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
  const value = structuredClone(draft) as DraftPair;
  const ids = new Map<string, number>();
  const evaluations = Object.fromEntries(
    Object.entries(value.evaluations).map(([candidate, review]) => [
      candidate,
      {
        summary: review.summary,
        findings: review.findings.map(({ finding_id, evidence: refs, ...finding }, i) => {
          const key = `${candidate}:${finding_id}`;
          if (ids.has(key))
            errors.push({
              category: "structure",
              code: "finding_id_duplicate",
              path: `/evaluations/${candidate}/findings/${i}/finding_id`,
              candidate,
              actual: finding_id,
              message: "finding_id 在候选内必须唯一",
            });
          ids.set(key, i);
          return {
            ...finding,
            evidence: evidence(refs, candidate, `/evaluations/${candidate}/findings/${i}/evidence`),
          };
        }),
      },
    ]),
  );
  const references = (kind: "decisive_findings" | "counterevidence") =>
    value.decision_basis[kind].flatMap((ref, i) => {
      const index = ids.get(`${ref.candidate}:${ref.finding_id}`);
      if (index === undefined) {
        errors.push({
          category: "decision",
          code: "finding_id_missing",
          path: `/decision_basis/${kind}/${i}`,
          candidate: ref.candidate,
          actual: ref.finding_id,
          expected: [...ids.keys()],
          message: "判决引用了不存在的发现",
        });
        return [];
      }
      return [{ candidate: ref.candidate, finding_index: index }];
    });
  const decision_basis = {
    tradeoff: value.decision_basis.tradeoff,
    decisive_findings: references("decisive_findings"),
    counterevidence: references("counterevidence"),
  };
  if (errors.length) throw new ValidationError(errors);
  return { ...value, evaluations, decision_basis };
}
