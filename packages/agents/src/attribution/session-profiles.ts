import { Ajv2020 } from "ajv/dist/2020.js";
import { ValidationError, resolveEvidenceSelection, schemaIssues, type AgentProfile, type AgentRequest, type JsonObject, type ToolAudit } from "@eval/contracts";
import { agentPrompt } from "@eval/prompts";
import { parseEvidenceCoordinates } from "@eval/tools";
import componentRequestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };
import componentSubmissionSchema from "../../../../schemas/attribution/component-submission.schema.json" with { type: "json" };
import componentResultSchema from "../../../../schemas/attribution/component-result.schema.json" with { type: "json" };
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceSubmissionSchema from "../../../../schemas/attribution/trace-summary-submission.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionSubmissionSchema from "../../../../schemas/attribution/session-summary-submission.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { resolveAttributionEvidence } from "./source-evidence.js";
import type { ComponentReviewResult, SessionAttributionResult, SessionProblem, TraceAttributionResult } from "./types.js";

const componentTools = [
  "read_execution", "read_responsibility_chain", "read_trace", "search_trace", "view_image", "calculate", "execute_code",
  "read_artifact", "edit_json",
];
const componentPrompt = agentPrompt("attribution", componentTools, { profile: "component", fileSubmission: true });
const tracePrompt = agentPrompt("attribution", [], { profile: "trace", fileSubmission: false });
const sessionPrompt = agentPrompt("attribution", [], { profile: "session", fileSubmission: false });
const componentSchema = new Ajv2020({ allErrors: true, strict: false }).compile(componentSubmissionSchema);
const copy = <T>(value: T): T => structuredClone(value);
const bareProblem = copy(problemSchema) as Record<string, unknown>;
delete bareProblem.$id;
delete bareProblem.$schema;
const componentResult = copy(componentResultSchema) as any;
componentResult.properties.problems.items = copy(bareProblem);
const traceResult = copy(traceResultSchema) as any;
traceResult.properties.problem.items = copy(bareProblem);
const sessionResult = copy(sessionResultSchema) as any;
sessionResult.properties.turns.items = copy(traceResult);
sessionResult.properties.session_problem.items = copy(bareProblem);
const requiredComponentRequest = structuredClone(componentRequestSchema) as { required: string[] };
requiredComponentRequest.required.push("component", "trace_index");

function evidenceKind(message: Record<string, unknown>, path: string): "reasoning" | "tool_call" | "answer" | "question" | "material" {
  if (/tool_calls?|function_call|tool_result|function_call_output/iu.test(path)) return "tool_call";
  if (/reasoning|thinking|analysis|calculations?/iu.test(path)) return "reasoning";
  if (message.type === "final_answer" || message.role === "assistant") return "answer";
  if (message.type === "user_question" || message.role === "user") return "question";
  if (["tool_result", "function_call_output"].includes(String(message.type))) return "tool_call";
  return "material";
}

function evidencePosition(traceIndex: number, messageIndex: number, path: string): string {
  return `trace_index ${traceIndex} / message_index ${messageIndex} / path ${path || "root"}`;
}

function evidenceComponent(message: Record<string, unknown>, path: string, fixedComponent: string): string {
  const kind = evidenceKind(message, path);
  return kind === "tool_call" ? `tool_call: ${fixedComponent}`
    : kind === "reasoning" ? `reasoning: ${fixedComponent}`
      : kind === "answer" ? "answer: 终稿生成轮"
        : kind === "question" ? "question: 用户输入" : `material: ${fixedComponent}`;
}

function componentReview(request: AgentRequest, draft: unknown, audit: ToolAudit): ComponentReviewResult {
  const issues = componentSchema(draft) ? [] : schemaIssues(componentSchema.errors, draft);
  if (issues.length) throw new ValidationError(issues);
  const value = draft as { problems: { label: string; definition: string; problem_phenomena: string; reason: string;
    evidence: { index: number; reason: string }[]; calculations?: { text: string }[] }[] };
  const component = String(request.input.component ?? "").trim();
  if (!component) throw new ValidationError([{ category: "decision", code: "component_required", path: "/component",
    message: "组件审查任务缺少固定组件。" }]);
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const traceIndex = Number(request.input.trace_index);
  const problems: SessionProblem[] = value.problems.map((problem, index) => ({
    problem_id: `p${index + 1}`,
    component,
    label: problem.label,
    definition: problem.definition,
    problem_phenomena: problem.problem_phenomena,
    reason: problem.reason,
    evidence: problem.evidence.map((selection, evidenceIndex) => {
      const path = `/problems/${index}/evidence/${evidenceIndex}`;
      const reference = resolveEvidenceSelection(audit.evidenceBank ?? [], { evidence_index: selection.index }, path);
      const evidence = resolveAttributionEvidence(request, reference, audit, path);
      if (evidence.quote.length > 400) throw new ValidationError([{ category: "evidence", code: "quote_too_long", path: `${path}/index`,
        message: "quote 最多 400 字；请选择更精确的连续原文，不要截断或拼接。", actual: evidence.quote.length }]);
      const point = parseEvidenceCoordinates(evidence.evidence_id);
      if (!point) throw new ValidationError([{ category: "evidence", code: "evidence_position_invalid", path, message: "证据坐标不可解析。" }]);
      return { position: evidencePosition(traceIndex, evidence.message_index, point.kind === "image" ? "image" : point.path),
        component: evidenceComponent(raw.messages[evidence.message_index] ?? {}, point.kind === "image" ? "image" : point.path, component),
        quote: evidence.quote, reason: selection.reason };
    }),
    ...(problem.calculations?.length ? { calculations: problem.calculations } : {}),
  }));
  return { component, problems };
}

export const componentAttributionProfile: AgentProfile = {
  id: "component",
  requestSchema: requiredComponentRequest,
  submissionSchema: componentSubmissionSchema,
  resultSchema: componentResult,
  evidenceSelections: true,
  ...componentPrompt,
  renderPrompt(input, policy, failure) {
    return componentPrompt.renderPrompt({ ...input, component: input.component, trace_index: input.trace_index }, policy, failure);
  },
  toolNames: componentTools,
  resolve: componentReview,
};

export const traceAttributionProfile: AgentProfile = {
  id: "trace",
  requestSchema: { type: "object", required: ["trace_meta", "question", "answer", "problems"], additionalProperties: true },
  submissionSchema: traceSubmissionSchema,
  resultSchema: traceResult,
  ...tracePrompt,
  toolNames: [],
  resolve(request, draft) {
    const value = draft as { summary: string; is_correct: 1 | 0 | null; correct_reason: string };
    const result: TraceAttributionResult = { meta: (request.input.trace_meta ?? {}) as JsonObject,
      summary: value.summary, problem: (request.input.problems ?? []) as SessionProblem[],
      is_correct: value.is_correct, correct_reason: value.correct_reason };
    return result;
  },
};

export const sessionAttributionProfile: AgentProfile = {
  id: "session",
  requestSchema: { type: "object", required: ["session_meta", "qa", "turns"], additionalProperties: true },
  submissionSchema: sessionSubmissionSchema,
  resultSchema: sessionResult,
  ...sessionPrompt,
  toolNames: [],
  resolve(request, draft) {
    const value = draft as { session_summary: string; session_problem: { label: string; definition: string;
      problem_phenomena: string; reason: string; evidence: { trace_index: number; problem_index: number; reason: string }[];
      calculations?: { text: string }[] }[] };
    const traces = (request.input.turns ?? []) as TraceAttributionResult[];
    const session_problem: SessionProblem[] = value.session_problem.map((problem, index) => {
      const evidence = problem.evidence.flatMap((reference, evidenceIndex) => {
        const trace = traces[reference.trace_index], source = trace?.problem[reference.problem_index];
        const path = `/session_problem/${index}/evidence/${evidenceIndex}`;
        if (!trace || !source) throw new ValidationError([{ category: "evidence", code: "session_problem_reference",
          path, message: "session_problem 必须引用已有 trace Problem。" }]);
        return source.evidence.map(item => ({ ...item, reason: reference.reason }));
      });
      const components = [...new Set(problem.evidence.flatMap(reference =>
        traces[reference.trace_index]?.problem[reference.problem_index]?.component ? [traces[reference.trace_index]!.problem[reference.problem_index]!.component] : []))];
      return { problem_id: `s-p${index + 1}`, component: components.join(" / "),
        label: problem.label, definition: problem.definition, problem_phenomena: problem.problem_phenomena,
        reason: problem.reason, evidence, ...(problem.calculations?.length ? { calculations: problem.calculations } : {}) };
    });
    return { session_meta: (request.input.session_meta ?? {}) as JsonObject, turns: traces,
      session_summary: value.session_summary, session_problem } satisfies SessionAttributionResult;
  },
};
