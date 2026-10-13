import { canonical, ValidationError, type AgentRequest, type TaskAnalysis, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { cite, evidenceCovers, evidenceSources, parseEvidenceCoordinates, sourceContentBlocks, traceReadCoverage } from "@eval/tools";
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

export function findingNormSelectionIssues(request: AgentRequest, draft: unknown, audit?: ToolAudit): ValidationIssue[] {
  const directory = attributionNormDirectory(request), issues: ValidationIssue[] = [];
  const context = instructionEvidenceContext(request), answer = object(request.input.answer)!;
  const fullyShown = (item: Evidence, requirementIndex: number | null) => {
    const point = parseEvidenceCoordinates(item.evidence_id);
    if (!point || point.kind !== "text") return false;
    const criterion = requirementIndex === null ? undefined : (request.input.task_analysis as unknown as TaskAnalysis).requirements[requirementIndex];
    if (criterion?.acceptance_rule.includes(item.quote)) return true; // The complete original is already present in the source-bound acceptance rule.
    if (Array.isArray(answer.instruction_sources) && answer.instruction_sources.some(entry => {
      const shown = object(entry);
      return context.sources.some(source => source.message_index === point.message_index && shown?.message_index === source.message_index &&
        shown.path === source.path && shown.role === source.role && canonical(shown.content) === canonical(source.content) &&
        canonical(shown.evidence) === canonical(source.evidence) && source.evidence.some(origin =>
          evidenceCovers(context.raw, request.sources.answer.id, origin.evidence_id, item.evidence_id)));
    })) return true;
    return Array.isArray(answer.initial_material) && answer.initial_material.some(entry => {
      const shown = object(entry);
      if (shown?.message_index !== point.message_index) return false;
      const original = evidenceSources(context.raw.messages[point.message_index]).find(source => source.kind === "text" && source.path === point.path);
      const visible = evidenceSources(shown.value).find(source => source.kind === "text" && source.path === point.path);
      return !!original && !!visible && original.text === visible.text && original.text.slice(point.start, point.end) === item.quote;
    });
  };
  for (const { finding, path } of submissionFindingEntries(draft)) {
    if (finding.dimension !== "instruction_following" && !Object.hasOwn(finding,"norm_index")) continue;
    const selected = finding.norm_index;
    if (selected === null) {
      if (object(finding.assessment)?.evidence_status !== "uncertain") issues.push({ category: "evidence",
        code: "finding_norm_unknown", path: `${path}/norm_index`,
        message: `未知规范只能在 ${path}/norm_index 填 null，并保留 assessment.evidence_status=uncertain；不能宣称已确认遵守或违反。` });
      continue;
    }
    if (!Number.isSafeInteger(selected) || Number(selected) < 0 || !directory[Number(selected)]) {
      issues.push({ category: "evidence", code: "finding_norm_index_invalid", path: `${path}/norm_index`,
        message: `规范编号填写在 ${path}/norm_index，与 dimension 同级，不放进 assessment；只选择本方 norm_directory 的原 norm_index，未知规范用 null 并保留 uncertain。`,
        actual: selected, expected: directory.map(item => item.norm_index) });
      continue;
    }
    if (audit) directory[Number(selected)]!.evidence.forEach(item => {
      if (item.quote.length <= 200 || fullyShown(item, directory[Number(selected)]!.requirement_index)) return;
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      if (point.kind !== "text") return;
      const coverage = traceReadCoverage(audit, { candidate: "answer", message_index: point.message_index,
        kind: "text", path: point.path, start: point.start, end: point.end });
      if (!coverage.covered) issues.push({ category: "evidence", code: "finding_norm_not_read", path: `${path}/norm_index`,
        message: "选中的长规范须读取全部原条件和例外；请按 read_request 读取到 end_offset，目录预览不代替完整阅读。",
        actual: coverage.missing, expected: { norm_index: selected, read_request: { tool: "read_trace", arguments: {
          candidate: "answer", message_index: point.message_index, path: point.path, offset: point.start } }, end_offset: point.end } });
    });
  }
  return issues;
}
