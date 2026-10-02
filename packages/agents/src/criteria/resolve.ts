import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, schemaIssues, ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis, type TaskCriterion, type ValidationIssue } from "@eval/contracts";
import { criteriaText } from "@eval/prompts";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/criteria/submission.schema.json" with { type: "json" };
import { criteriaSources, type CriterionSource } from "./sources.js";

export interface CriteriaSubmission {
  requirements: { id: string; source_ids: string[] }[];
  scoring_points: { id: string; source_ids: string[] }[];
  red_flags: { id: string; source_ids: string[] }[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile<unknown>(requestSchema);
const validateSubmission = ajv.compile<unknown>(submissionSchema);
const groups = ["requirements", "scoring_points", "red_flags"] as const;

function scope(input: CriteriaInput, sources: CriterionSource[]): string[] {
  return input.candidates.map((candidate) => candidate.candidate_id).filter((candidate) =>
    sources.every((source) => !source.applies_to.length || source.applies_to.includes(candidate)));
}

function rule(sources: CriterionSource[]): string {
  return [criteriaText("source_rule"), ...(sources.some((source) => source.kind === "reference")
    ? [criteriaText("reference_rule")] : [])].join("\n\n");
}

export function resolveCriteria(request: AgentRequest, draft: unknown): TaskAnalysis {
  if (!validateRequest(request.input)) throw new ValidationError(schemaIssues(validateRequest.errors, request.input));
  if (!validateSubmission(draft)) throw new ValidationError(schemaIssues(validateSubmission.errors, draft));
  const input = request.input as unknown as CriteriaInput;
  const value = draft as CriteriaSubmission;
  const catalogue = criteriaSources(input);
  const lookup = new Map(catalogue.map((source) => [source.id, source]));
  const errors: ValidationIssue[] = [];
  const required = new Map<string, Set<string>>();
  const criteria = new Map<string, { id: string; path: string }>();
  const output: TaskAnalysis = { task_type: criteriaText("task_type"), goal: input.question, requirements: [], scoring_points: [], red_flags: [] };
  for (const group of groups) value[group].forEach((criterion, index) => {
    const sources = criterion.source_ids.flatMap((id) => {
      const source = lookup.get(id);
      if (!source) errors.push({ category: "decision", code: "criterion_source_unknown", path: `/${group}/${index}/source_ids`,
        message: "source_ids 只能引用 source_catalog 中已有的完整原文，不得自行编写或拼接新标准", actual: id, expected: [...lookup.keys()] });
      return source ? [source] : [];
    });
    if (sources.length !== criterion.source_ids.length) return;
    const applies = scope(input, sources);
    if (!applies.length) errors.push({ category: "decision", code: "criterion_source_scope_empty", path: `/${group}/${index}/source_ids`,
      message: "合并来源必须有共同适用候选；相反或不同候选的专有约束分别列出", actual: criterion.source_ids });
    if (group === "requirements") for (const source of sources) {
      const covered = required.get(source.id) ?? new Set<string>();
      for (const candidate of applies) covered.add(candidate);
      required.set(source.id, covered);
    }
    const resolved = { id: criterion.id, text: [...new Set(sources.map((source) => source.text))].join("\n\n"),
      applies_to: applies.length === input.candidates.length ? [] : applies, acceptance_rule: rule(sources) };
    const key = canonical({ text: resolved.text, applies_to: resolved.applies_to, acceptance_rule: resolved.acceptance_rule });
    const duplicate = criteria.get(key);
    if (duplicate) errors.push({ category: "decision", code: "criterion_duplicate", path: `/${group}/${index}`,
      message: "相同原文、作用域和验收规则只能保留一条判据；合并重复的来源选择，不因分组或ID不同重复评审", actual: criterion.id, expected: duplicate });
    else criteria.set(key, { id: criterion.id, path: `/${group}/${index}` });
    output[group].push(resolved);
  });
  for (const source of catalogue.filter((source) => source.kind === "question" || source.kind === "reference"))
    for (const candidate of input.candidates) if (!required.get(source.id)?.has(candidate.candidate_id)) errors.push({
      category: "decision", code: "criterion_required_source_missing", path: "/requirements", candidate: candidate.candidate_id,
      message: `${source.id} 未覆盖此候选；已出现在仅适用于部分候选的条款中也不算覆盖。请在 requirements 为该来源单独新增一条公共要求，source_ids 只填该来源 ID，即可覆盖全部候选；不要与候选专属来源合并，也不要降为加分项/红线。`,
      actual: source.id, expected: { source_ids: [source.id] } });
  if (errors.length) throw new ValidationError(errors);
  return output;
}

/** Validate the resolved form too, so a direct caller cannot bypass source-derived rules. */
export function matchCriterionSources(input: CriteriaInput, criterion: TaskCriterion, catalogue: CriterionSource[]): CriterionSource[] | undefined {
  const target = criterion.applies_to.length ? criterion.applies_to : input.candidates.map((candidate) => candidate.candidate_id);
  const complete = (selected: CriterionSource[]): CriterionSource[] | undefined => {
    const texts = new Set(selected.map((source) => source.text));
    // Identical question/context paragraphs render once, but retain both their coverage and scope.
    const mandatory = catalogue.filter((source) => (source.kind === "question" || source.kind === "reference")
      && !selected.includes(source) && texts.has(source.text)
      && (source.kind !== "reference" || criterion.acceptance_rule === rule([...selected, source])));
    const initial = [...selected, ...mandatory];
    const finish = (sources: CriterionSource[]): CriterionSource[] | undefined => {
      const applies = scope(input, sources);
      if (!target.every((candidate) => applies.includes(candidate))) return undefined;
      const expected = applies.length === input.candidates.length ? [] : applies;
      if (expected.length === criterion.applies_to.length && expected.every((candidate) => criterion.applies_to.includes(candidate))
        && rule(sources) === criterion.acceptance_rule) return sources;
      for (const source of catalogue) if (!sources.includes(source) && texts.has(source.text)) {
        const matched = finish([...sources, source]);
        if (matched) return matched;
      }
      return undefined;
    };
    return finish(initial);
  };
  const visit = (remaining: string, selected: CriterionSource[]): CriterionSource[] | undefined => {
    if (!remaining) return complete(selected);
    if (selected.length >= 24) return undefined;
    for (const source of catalogue) {
      if (selected.some((item) => item.text === source.text) || !source.text || !remaining.startsWith(source.text)) continue;
      const suffix = remaining.slice(source.text.length);
      if (suffix && !suffix.startsWith("\n\n")) continue;
      const matched = visit(suffix ? suffix.slice(2) : "", [...selected, source]);
      if (matched) return matched;
    }
    return undefined;
  };
  return visit(criterion.text, []);
}
