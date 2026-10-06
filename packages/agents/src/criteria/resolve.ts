import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis, type TaskCriterion, type ValidationIssue } from "@eval/contracts";
import { criteriaText } from "@eval/prompts";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/criteria/submission.schema.json" with { type: "json" };
import { criteriaSources, eligibleCriterionSource, type CriterionSource } from "./sources.js";
import { criteriaGroups, criterionIdentity } from "./identity.js";
import { criterionValueIssues } from "./source-values.js";

export interface CriteriaSubmission {
  requirements: { source_indices: number[]; text: string }[];
  scoring_points: { source_indices: number[]; text: string }[];
  red_flags: { source_indices: number[]; text: string }[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile<unknown>(requestSchema);
const validateSubmission = ajv.compile<unknown>(submissionSchema);

function scope(input: CriteriaInput, sources: CriterionSource[]): string[] {
  return input.candidates.map((candidate) => candidate.candidate_id).filter((candidate) =>
    sources.every((source) => !source.applies_to.length || source.applies_to.includes(candidate)));
}

function rule(sources: CriterionSource[]): string {
  return [...new Set(sources.map(source => source.text)), criteriaText("source_rule"), ...(sources.some((source) => source.kind === "reference")
    ? [criteriaText("reference_rule")] : [])].join("\n\n");
}

export function resolveCriteria(request: AgentRequest, draft: unknown): TaskAnalysis {
  if (!validateRequest(request.input)) throw new ValidationError(schemaIssues(validateRequest.errors, request.input));
  if (!validateSubmission(draft)) throw new ValidationError(schemaIssues(validateSubmission.errors, draft));
  const input = request.input as unknown as CriteriaInput;
  const value = draft as CriteriaSubmission;
  const catalogue = criteriaSources(input).filter(eligibleCriterionSource);
  const lookup = new Map(catalogue.map((source) => [source.source_index, source]));
  const errors: ValidationIssue[] = [];
  const count = criteriaGroups.reduce((total, group) => total + value[group].length, 0);
  if (count > 24) errors.push({
    category: "decision", code: "criteria_budget_exceeded", path: "/",
    message: "requirements、scoring_points 和 red_flags 的原始选择合计最多 24 条", actual: count, expected: 24,
  });
  const required = new Set<number>();
  const entries: { group: typeof criteriaGroups[number]; sourceIndices: number[]; criterion: TaskCriterion }[] = [];
  const output: TaskAnalysis = { task_type: criteriaText("task_type"), goal: input.question, requirements: [], scoring_points: [], red_flags: [] };
  for (const group of criteriaGroups) value[group].forEach((criterion, index) => {
    const sources = criterion.source_indices.flatMap((id) => {
      const source = lookup.get(id);
      if (!source) errors.push({ category: "decision", code: "criterion_source_unknown", path: `/${group}/${index}/source_indices`,
        message: "source_indices 只能选择 source_catalog 中已有的数字编号，不得自行编写或拼接新标准", actual: id, expected: [...lookup.keys()] });
      return source ? [source] : [];
    });
    if (sources.length !== criterion.source_indices.length) return;
    errors.push(...criterionValueIssues(criterion.text, sources, `/${group}/${index}/text`));
    sources.sort((a,b) => a.source_index-b.source_index);
    const applies = scope(input, sources);
    if (!applies.length) errors.push({ category: "decision", code: "criterion_source_scope_empty", path: `/${group}/${index}/source_indices`,
      message: "合并来源必须有共同适用候选；相反或不同候选的专有约束分别列出", actual: criterion.source_indices });
    if (group === "requirements" && applies.length === input.candidates.length)
      for (const source of sources) required.add(source.source_index);
    const resolved = { id: "", text: criterion.text.trim(),
      applies_to: applies.length === input.candidates.length ? [] : applies, acceptance_rule: rule(sources) };
    entries.push({ group, sourceIndices: criterion.source_indices, criterion: resolved });
  });
  for (const source of catalogue.filter((source) => source.kind === "question" || source.kind === "reference"))
    if (!required.has(source.source_index)) errors.push({
      category: "decision", code: "criterion_required_source_missing", path: "/requirements",
      message: `${source.kind} 来源 ${source.source_index} 必须至少出现在一条适用于全部候选的 requirements 中；多条私有要求的作用域并集不算公共覆盖。请在 requirements 为该来源单独新增一条公共要求，source_indices 只填该来源编号，即可覆盖全部候选；也可与真正共同适用的来源合并，但整条仍须覆盖全部候选，不得降为加分项或红线。`,
      actual: source.source_index, expected: { source_indices: [source.source_index] } });
  if (errors.length) throw new ValidationError(errors);
  const generated = new Set<string>();
  for (const entry of entries) {
    const identity = criterionIdentity(entry.criterion);
    const duplicate = generated.has(identity);
    generated.add(identity);
    if (!duplicate) {
      const prefix = { requirements: "r", red_flags: "f", scoring_points: "s" }[entry.group];
      output[entry.group].push({ ...entry.criterion, id: `${prefix}${output[entry.group].length + 1}` });
    }
  }
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
  const suffix = criteriaText("source_rule");
  const boundary = criterion.acceptance_rule.lastIndexOf("\n\n" + suffix);
  return boundary < 0 ? undefined : visit(criterion.acceptance_rule.slice(0, boundary), []);
}
