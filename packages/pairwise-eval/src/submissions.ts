import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonSchema, PlannedTask, ToolAudit, ValidationIssue } from "../../contracts/src/index.js";
import { schemaIssues, ValidationError } from "../../contracts/src/io.js";
import { resolveEvidence } from "../../tools/src/evidence.js";
import { stageSchema } from "./index.js";
import type { Finding, PairwiseResult, RawInput, TaskData } from "./types.js";

export function submissionSchema(stage: string): JsonSchema {
  const schema = stageSchema(stage);
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as JsonSchema, props = node.properties as JsonSchema | undefined;
    if (props?.quote && props.message_index) {
      node.properties = { evidence_id: { type: "string", minLength: 1 }, observation: { type: "string", minLength: 1 } };
      node.required = ["evidence_id"];
    } else if (props?.finding_index) {
      delete props.finding_index;
      props.finding_id = { type: "string", minLength: 1, maxLength: 64 };
      node.required = ["candidate", "finding_id"];
    } else if (props?.assessment && props.evidence) {
      props.finding_id = { type: "string", minLength: 1, maxLength: 64 };
      (node.required as string[]).push("finding_id");
    }
    Object.values(node).forEach(visit);
  }
  visit(schema);
  return schema;
}
type EvidenceRef = { evidence_id: string; observation?: string };
type DraftFinding = Omit<Finding, "evidence"> & { finding_id: string; evidence: EvidenceRef[] };
interface DraftPair extends Omit<PairwiseResult, "evaluations" | "decision_basis"> {
  evaluations: Record<string, { summary: string; findings: DraftFinding[] }>;
  decision_basis: { tradeoff: string; decisive_findings: { candidate: string; finding_id: string }[]; counterevidence: { candidate: string; finding_id: string }[] };
}
const validators = new Map<string, ReturnType<Ajv2020["compile"]>>();
export function resolveSubmission(task: PlannedTask, inputs: Record<string, unknown>, draft: unknown, audit: ToolAudit): unknown {
  const data = task.data as TaskData;
  if (!validators.has(data.stage)) validators.set(data.stage, new Ajv2020({ allErrors: true, strict: false }).compile(submissionSchema(data.stage)));
  const validate = validators.get(data.stage)!;
  if (!validate(draft)) throw new ValidationError(schemaIssues(validate.errors, draft));
  const errors: ValidationIssue[] = [];
  const evidence = (refs: EvidenceRef[], candidate: string, location: string) => refs.flatMap((value, i) => {
    try { return [resolveEvidence(inputs[task.inputIds[candidate]] as RawInput, task.inputIds[candidate], value, candidate, audit.viewedImages, `${location}/${i}`)]; }
    catch (error) { if (error instanceof ValidationError) errors.push(...error.issues!); else throw error; return []; }
  });
  if (data.stage === "correctness") {
    const value = structuredClone(draft) as { is_correct: boolean | null; correctness_reason: string; evidence: EvidenceRef[] };
    const resolved = { ...value, evidence: evidence(value.evidence, "A", "/evidence") };
    if (errors.length) throw new ValidationError(errors);
    return resolved;
  }
  const value = structuredClone(draft) as DraftPair;
  const ids = new Map<string, number>();
  const evaluations = Object.fromEntries(Object.entries(value.evaluations).map(([candidate, review]) => [candidate, {
    summary: review.summary,
    findings: review.findings.map(({ finding_id, evidence: refs, ...finding }, i) => {
      const key = `${candidate}:${finding_id}`;
      if (ids.has(key)) errors.push({ category: "structure", code: "finding_id_duplicate", path: `/evaluations/${candidate}/findings/${i}/finding_id`, candidate, actual: finding_id, message: "finding_id 在候选内必须唯一" });
      ids.set(key, i);
      return { ...finding, evidence: evidence(refs, candidate, `/evaluations/${candidate}/findings/${i}/evidence`) };
    }),
  }]));
  const references = (kind: "decisive_findings" | "counterevidence") => value.decision_basis[kind].flatMap((ref, i) => {
    const index = ids.get(`${ref.candidate}:${ref.finding_id}`);
    if (index === undefined) { errors.push({ category: "decision", code: "finding_id_missing", path: `/decision_basis/${kind}/${i}`, candidate: ref.candidate, actual: ref.finding_id, expected: [...ids.keys()], message: "判决引用了不存在的发现" }); return []; }
    return [{ candidate: ref.candidate, finding_index: index }];
  });
  const decision_basis = { tradeoff: value.decision_basis.tradeoff, decisive_findings: references("decisive_findings"), counterevidence: references("counterevidence") };
  if (errors.length) throw new ValidationError(errors);
  return { ...value, evaluations, decision_basis };
}
