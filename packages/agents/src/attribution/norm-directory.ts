import { ValidationError, type AgentRequest, type TaskAnalysis } from "@eval/contracts";
import { cite, evidenceCovers, evidenceSources, sourceContentBlocks } from "@eval/tools";
import { instructionEvidenceContext } from "./instructions.js";
import type { Evidence } from "./types.js";

export interface AttributionNorm {
  norm_index: number;
  roles: ("user" | "system" | "developer" | "tool")[];
  requirement_index: number | null;
  evidence: Evidence[];
}

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
