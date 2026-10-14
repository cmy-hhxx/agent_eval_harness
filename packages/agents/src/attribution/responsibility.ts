import { ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { answerTurnContexts, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource } from "@eval/tools";
import { ownEvidence } from "./source-evidence.js";
import type { Evidence, ProblemProposal } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolTypes = new Set(["function_call", "function_call_output", "tool_call", "tool_result"]);
const presentation = "回答呈现与采集", environment = "执行环境与权限配置";
const processRoles = [presentation, environment];
function processPaths(message: unknown, component: string): string[] {
  const value = object(message);
  if (!value) return [];
  const type = String(value.type);
  if (["function_call_output", "tool_result"].includes(type) || value.role === "tool")
    return ["/output", "/content"].filter(path => value[path.slice(1)] != null);
  if (component === presentation && type === "llm_turn" && Array.isArray(value.output)) return ["/output"];
  if (component === environment && ["function_call", "tool_call"].includes(type))
    return ["/input", "/arguments"].filter(path => value[path.slice(1)] != null);
  return [];
}
function processEvidence(request: AgentRequest, evidence: Evidence | undefined, component: string): boolean {
  if (!evidence || !ownEvidence(evidence)) return false;
  const coordinate = parseEvidenceCoordinates(evidence.evidence_id);
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  if (!coordinate || coordinate.input_id !== request.sources.answer.id || coordinate.message_index !== evidence.message_index ||
    coordinate.message_index >= finalIndex || coordinate.kind === "image") return false;
  const raw = request.sources.answer.value as { messages: unknown[] }, message = raw.messages[evidence.message_index];
  if (object(message)?.type === "llm_turn" && !answerTurnContexts(raw, finalIndex).some(context => context.message_index === evidence.message_index)) return false;
  return processPaths(message, component).some(path => {
    if (coordinate.kind === "text" && (coordinate.path === path || coordinate.path.startsWith(`${path}/`))) return true;
    const range = selectEvidenceSource(evidenceSources(message), path);
    return !!range && coordinate.kind === range.source.kind && coordinate.path === range.source.path &&
      ((coordinate.start >= range.start && coordinate.end <= range.end) ||
       (coordinate.start <= range.start && coordinate.end >= range.end));
  });
}
function finalEvidence(request: AgentRequest, evidence: Evidence | undefined): boolean {
  if (!evidence || !ownEvidence(evidence)) return false;
  const coordinate = parseEvidenceCoordinates(evidence.evidence_id);
  const finalIndex = (request.input.answer as { final_message_index: number }).final_message_index;
  return !!coordinate && coordinate.input_id === request.sources.answer.id && coordinate.message_index === finalIndex &&
    evidence.message_index === finalIndex;
}
export function responsibilityChoices(request: AgentRequest): string[] {
  const answer = request.input.answer as { catalog: { name?: string; type: string; role?: string }[]; final_message_index: number };
  const contexts = answerTurnContexts(request.sources.answer.value as { messages: unknown[] }, answer.final_message_index);
  const messages = (request.sources.answer.value as { messages: unknown[] }).messages;
  return [...new Set(["模型自身推理", ...(contexts.length ? ["上下文组装与传递"] : []),
    ...answer.catalog.flatMap(message => message.name && (toolTypes.has(message.type) || message.role === "tool") ? [message.name] : []),
    ...processRoles.filter(component => messages.slice(0, answer.final_message_index).some((message, index) =>
      (object(message)?.type !== "llm_turn" || contexts.some(context => context.message_index === index)) &&
      processPaths(message, component).some(path => !!selectEvidenceSource(evidenceSources(message), path))))])];
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
    if (processRoles.includes(component)) {
      if (selected.some(evidence => processEvidence(request, evidence, component)) && selected.some(evidence => finalEvidence(request, evidence))) return [];
      return [{ category: "evidence", code: "problem_component_evidence_missing", path: `${path}/component/${position}`,
        message: "呈现采集或执行环境责任须分别引用本方实际过程及相关最终交付；规范、参考材料和纯最终回答不能代替过程证据。证据范围不自动证明该环节存在故障。",
        actual: component }];
    }
    if (component === "模型自身推理" || selected.some(evidence => responsibilityComponent(request, evidence) === component)) return [];
    return [{ category: "evidence", code: "problem_component_evidence_missing", path: `${path}/component/${position}`,
      message: "所选责任方必须引用本方对应工具或实际模型输入证据；正确来源可以作为反证，但不因此成为责任方。",
      actual: component }];
  });
}

export function resolveProblemSubmission(request: AgentRequest, problem: ProblemProposal, selected: readonly (Evidence | undefined)[], path: string): ProblemProposal {
  const issues = responsibilityIssues(request, problem, selected, path);
  if (issues.length) throw new ValidationError(issues);
  return structuredClone(problem);
}
