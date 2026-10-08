import { ValidationError, type AgentRequest, type ValidationIssue } from "@eval/contracts";
import { ownEvidence } from "./source-evidence.js";
import type { Evidence, ProblemProposal, ProblemSubmission } from "./types.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const toolTypes = new Set(["function_call", "function_call_output", "tool_call", "tool_result"]);
function componentFor(request: AgentRequest, evidence: Evidence | undefined): string | undefined {
  if (!evidence || !ownEvidence(evidence)) return;
  const catalog = (request.input.answer as { catalog: { message_index: number; name?: string; type: string; role?: string }[] }).catalog;
  const message = catalog.find(item => item.message_index === evidence.message_index);
  return message?.name && (toolTypes.has(message.type) || message.role === "tool") ? message.name : undefined;
}

/** The array retains original submitted slots, including failed references; never renumber after filtering. */
export function responsibilityIssues(request: AgentRequest, problem: unknown, selected: readonly (Evidence | undefined)[], path: string): ValidationIssue[] {
  const indices = object(problem)?.tool_evidence_indices;
  if (!Array.isArray(indices)) return [];
  const choices = selected.flatMap((evidence, finding_evidence_index) => {
    const component = componentFor(request, evidence);
    return component ? [{ finding_evidence_index, tool_name: component }] : [];
  });
  return indices.flatMap((index, position): ValidationIssue[] => {
    if (!Number.isSafeInteger(index) || index < 0) return []; // Structural errors belong to the submission schema.
    if (index < selected.length && selected[index] === undefined) return []; // Keep the reference's original error.
    if (index < selected.length && componentFor(request, selected[index])) return [];
    return [{ category: "evidence", code: "problem_tool_evidence_invalid", path: `${path}/tool_evidence_indices/${position}`,
      message: "工具责任只能选择本 finding 原 evidence 数组中本方真实工具调用或返回的位置；不能选择最终回答、指令、peer 工具或其他未引用工具。工具参与不证明工具失误；已确认标准不符而没有工具错误证据时，归模型的取数与结果校验逻辑。",
      actual: index, expected: { tool_evidence_choices: choices,
        repair_action: "核对本条原证据及具体责任后选择 finding_evidence_index；需要其他证据先读取并加入本条 evidence，不从全部调用工具中猜名称。" } }];
  });
}

export function resolveProblemSubmission(request: AgentRequest, problem: ProblemSubmission, selected: readonly (Evidence | undefined)[], path: string): ProblemProposal {
  const issues = responsibilityIssues(request, problem, selected, path);
  if (issues.length) throw new ValidationError(issues);
  const components = problem.tool_evidence_indices.flatMap(index => {
    const component = componentFor(request, selected[index]);
    return component ? [component] : [];
  });
  return { component: [...new Set([...(problem.model_responsible ? ["模型自身推理"] : []), ...components])],
    label: problem.label, definition: problem.definition };
}
