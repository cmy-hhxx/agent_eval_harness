import { ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { answerTurnContexts, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource } from "@eval/tools";
import { ownEvidence } from "./source-evidence.js";
import type { Evidence, ProblemProposal } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolTypes = new Set(["function_call", "function_call_output", "tool_call", "tool_result"]);
export function responsibilityChoices(request: AgentRequest): string[] {
  const answer = request.input.answer as { catalog: { name?: string; type: string; role?: string }[]; final_message_index: number };
  const contexts = answerTurnContexts(request.sources.answer.value as { messages: unknown[] }, answer.final_message_index);
  return [...new Set(["模型自身推理", ...(contexts.length ? ["上下文组装与传递"] : []),
    ...answer.catalog.flatMap(message => message.name && (toolTypes.has(message.type) || message.role === "tool") ? [message.name] : [])])];
}
export function responsibilityComponent(request: AgentRequest, evidence: Evidence | undefined): string | undefined {
  if (!evidence || !ownEvidence(evidence)) return;
  const catalog = (request.input.answer as { catalog: { message_index: number; name?: string; type: string; role?: string }[] }).catalog;
  const message = catalog.find(item => item.message_index === evidence.message_index);
  if (message?.name && (toolTypes.has(message.type) || message.role === "tool")) return message.name;
  const coordinate = parseEvidenceCoordinates(evidence.evidence_id);
  if (!coordinate || coordinate.input_id !== request.sources.answer.id || coordinate.kind === "image") return;
  const raw = request.sources.answer.value as { messages: unknown[] };
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  for (const context of answerTurnContexts(raw, finalIndex)) {
    if (context.message_index !== coordinate.message_index) continue;
    if (coordinate.kind === "text" && coordinate.path.startsWith(`${context.path}/`)) return "上下文组装与传递";
    const range = selectEvidenceSource(evidenceSources(raw.messages[context.message_index]), context.path);
    if (range && coordinate.kind === range.source.kind && coordinate.path === range.source.path &&
      coordinate.start >= range.start && coordinate.end <= range.end) return "上下文组装与传递";
  }
}

/** Evidence establishes provenance; the agent explicitly chooses which component was at fault. */
export function responsibilityIssues(request: AgentRequest, problem: unknown, selected: readonly (Evidence | undefined)[], path: string): ValidationIssue[] {
  const components = object(problem)?.component;
  if (!Array.isArray(components)) return [];
  return components.flatMap((component, position): ValidationIssue[] => {
    if (component === "模型自身推理" || selected.some(evidence => responsibilityComponent(request, evidence) === component)) return [];
    return [{ category: "evidence", code: "problem_component_evidence_missing", path: `${path}/component/${position}`,
      message: "所选责任方须有本条引用的本方工具或实际模型输入证据；正确来源可以作为反证，但不因此成为责任方。",
      actual: component }];
  });
}

export function resolveProblemSubmission(request: AgentRequest, problem: ProblemProposal, selected: readonly (Evidence | undefined)[], path: string): ProblemProposal {
  const issues = responsibilityIssues(request, problem, selected, path);
  if (issues.length) throw new ValidationError(issues);
  return structuredClone(problem);
}
