import { canonical, ValidationError, type AgentRequest, type TaskAnalysis, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceCovers, evidenceSources, sourceContentBlocks } from "@eval/tools";
import { instructionEvidenceContext } from "./instructions.js";
import type { Evidence } from "./types.js";

export interface AttributionNorm {
  norm_index: number;
  roles: ("user" | "system" | "developer")[];
  requirement_index: number | null;
  evidence: Evidence[];
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Original physical blocks and trusted criterion bindings; never infer normative meaning from prose. */
export function attributionNormDirectory(request: AgentRequest): AttributionNorm[] {
  const context = instructionEvidenceContext(request);
  if (context.bindingIssues.length) throw new ValidationError(context.bindingIssues);
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  const directory: Omit<AttributionNorm, "norm_index">[] = [];
  task.requirements.forEach((criterion, requirement_index) => {
    const evidence = context.forCriterion(criterion);
    if (!evidence.length) return;
    const roles = context.sources.filter(source => evidence.some(item => source.evidence.some(origin =>
      evidenceCovers(context.raw, request.sources.answer.id, origin.evidence_id, item.evidence_id)))).map(source => source.role);
    directory.push({ roles: [...new Set(roles)], requirement_index, evidence });
  });
  const bound = directory.flatMap(item => item.evidence);
  for (const source of context.sources) {
    const locations = evidenceSources(context.raw.messages[source.message_index]);
    const blocks = sourceContentBlocks(source.content, source.path);
    const originals = blocks.filter(block => !blocks.some(other => other !== block &&
      other.origins.length > block.origins.length && block.origins.every(origin => other.origins.some(candidate =>
        candidate.path === origin.path && candidate.start <= origin.start && candidate.end >= origin.end))));
    const heading = originals.findIndex(block => /^[\t ]{0,3}#{1,6}[\t ]+\S/u.test(block.quote));
    const preamble = heading < 0 ? originals.length : heading;
    const groups = source.role !== "user" && preamble > 1 ? [originals.slice(0, preamble), ...originals.slice(preamble).map(block => [block])]
      : originals.map(block => [block]);
    for (const group of groups) {
      const evidence = group.flatMap(block => block.origins.map(origin => {
        const location = locations.find(item => item.kind === "text" && item.path === origin.path);
        if (!location || location.text.slice(origin.start, origin.end) !== origin.quote)
          throw new Error("规范目录必须保留完整真实文本来源。");
        return cite(request.sources.answer.id, source.message_index, location, origin.start, origin.end);
      })).filter((item, index, all) => all.findIndex(other => other.evidence_id === item.evidence_id) === index);
      if (!evidence.length || evidence.every(item => bound.some(origin =>
        evidenceCovers(context.raw, request.sources.answer.id, origin.evidence_id, item.evidence_id)))) continue;
      directory.push({ roles: [source.role], requirement_index: null, evidence });
    }
  }
  return directory.map((item, norm_index) => ({ norm_index, ...item }));
}

export function normDirectoryIssues(request: AgentRequest): ValidationIssue[] {
  const directory = attributionNormDirectory(request);
  return canonical(object(request.input.answer)?.norm_directory) === canonical(directory) ? [] : [{
    category: "evidence", code: "norm_directory_invalid", path: "/answer/norm_directory",
    message: "规范目录必须由本方真实原材料与可信 criterion 绑定完整生成，不能缺省、改写或重排。", expected: directory,
  }];
}

export function submissionFindingEntries(draft: unknown) {
  const value = object(draft);
  return Array.isArray(value?.findings) ? value.findings.flatMap((entry, index) => {
    const finding = object(entry); return finding ? [{ finding, path: `/findings/${index}` }] : [];
  }) : [];
}

export function findingNormSelectionIssues(request: AgentRequest, draft: unknown): ValidationIssue[] {
  const directory = attributionNormDirectory(request), issues: ValidationIssue[] = [];
  for (const { finding, path } of submissionFindingEntries(draft)) {
    if (finding.dimension !== "instruction_following" && !Object.hasOwn(finding,"norm_index")) continue;
    const selected = finding.norm_index;
    if (selected === null) continue;
    if (!Number.isSafeInteger(selected) || Number(selected) < 0 || !directory[Number(selected)]) {
      issues.push({ category: "evidence", code: "finding_norm_index_invalid", path: `${path}/norm_index`,
        message: `规范编号填写在 ${path}/norm_index，与 dimension 同级，不放进 assessment；只选择本方 norm_directory 的原 norm_index，没有合适的目录关联时填 null。`,
        actual: selected, expected: directory.map(item => item.norm_index) });
      continue;
    }

  }
  return issues;
}
