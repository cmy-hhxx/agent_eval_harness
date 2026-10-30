import { Ajv2020 } from "ajv/dist/2020.js";
import { ValidationError, attributionEvidencePosition, resolveEvidenceSelection, schemaIssues, selectEvidence, type AgentProfile, type AgentRequest, type JsonObject, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { agentPrompt, attributionConditionalRules, attributionNoStandardReason, attributionTaxonomy } from "@eval/prompts";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceSubmissionSchema from "../../../../schemas/attribution/trace-summary-submission.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionSubmissionSchema from "../../../../schemas/attribution/session-summary-submission.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { resolveAttributionEvidence } from "./source-evidence.js";
import { attributionComponentLabel } from "./responsibility.js";
import { investigationMaterial } from "./investigation-material.js";
import { numericReferenceDirectory } from "./units.js";
import type { SessionAttributionResult, SessionProblem, TraceAttributionResult } from "./types.js";

const tools = ["read_trace", "search_trace", "view_image", "calculate", "execute_code", "read_artifact"];
const tracePrompt = agentPrompt("attribution", tools, { profile: "trace", fileSubmission: false });
const sessionPrompt = agentPrompt("attribution", tools, { profile: "session", fileSubmission: false });
const traceSubmission = structuredClone(traceSubmissionSchema);
const sessionSubmission = structuredClone(sessionSubmissionSchema);
for (const problem of [traceSubmission.properties.problems.items, sessionSubmission.properties.session_problem.items])
  Object.assign(problem.properties.component, { enum: Object.keys(attributionTaxonomy.components) });
const traceWithStandardSchema = { ...traceSubmission, required: ["summary", "problems", "is_correct", "correct_reason"] };
const validateTraceWithStandard = new Ajv2020({ allErrors: true, strict: false }).compile(traceWithStandardSchema);
const traceHasStandard = (request: AgentRequest) => (request.input.ground_truth as { available: boolean }).available;
const bareProblem = structuredClone(problemSchema) as Record<string, unknown>;
delete bareProblem.$id; delete bareProblem.$schema;
const traceResult = structuredClone(traceResultSchema) as any;
delete traceResult.$id; delete traceResult.$schema;
traceResult.properties.problem.items = bareProblem;
export const sessionAttributionResultSchema = structuredClone(sessionResultSchema) as any;
delete sessionAttributionResultSchema.$id; delete sessionAttributionResultSchema.$schema;
sessionAttributionResultSchema.properties.turns.items = traceResult;
sessionAttributionResultSchema.properties.session_problem.items = bareProblem;

function evidenceKind(message: Record<string, unknown>, path: string): "reasoning" | "tool_call" | "answer" | "question" | "material" {
  if (message.role === "tool" || ["tool_call", "tool_result", "function_call", "function_call_output"].includes(String(message.type))) return "tool_call";
  if (/tool_calls?|function_call|tool_result|function_call_output/iu.test(path)) return "tool_call";
  if (/reasoning|thinking|analysis|calculations?/iu.test(path)) return "reasoning";
  if (message.type === "final_answer" || message.role === "assistant") return "answer";
  if (message.type === "user_question" || message.role === "user") return "question";
  if (["tool_result", "function_call_output"].includes(String(message.type))) return "tool_call";
  return "material";
}

function evidenceComponent(message: Record<string, unknown>, path: string, fixedComponent: string): string {
  const kind = evidenceKind(message, path);
  const source = message.model ?? message.name ?? fixedComponent;
  return kind === "tool_call" ? `tool_call: ${message.name ?? fixedComponent}`
    : kind === "reasoning" ? `reasoning: ${source}`
      : kind === "answer" ? "answer: 终稿生成轮"
        : kind === "question" ? "question: 用户输入" : `material: ${source}`;
}

/** Split one rejected long quote into real, independently selectable excerpts without changing source bytes. */
function quoteRepair(request: AgentRequest, audit: ToolAudit, evidence: { evidence_id: string; message_index: number; quote: string }) {
  const point = parseEvidenceCoordinates(evidence.evidence_id);
  const raw = request.sources.answer.value as { messages: unknown[] };
  if (!point || point.kind === "image") return undefined;
  const source = evidenceSources(raw.messages[evidence.message_index]).find(item => item.kind === point.kind && item.path === point.path);
  if (!source) return undefined;
  const limit = 400, span = point.end - point.start;
  const starts = [...new Set([point.start, point.start + Math.floor(Math.max(0, span - limit) / 2), point.end - limit])]
    .filter(start => start >= point.start && start < point.end).slice(0, 3);
  const bank = audit.evidenceBank ?? (audit.evidenceBank = []);
  const choices = starts.map(start => {
    const item = cite(request.sources.answer.id, evidence.message_index, source, start, Math.min(point.end, start + limit));
    const { evidence_id: _id, ...display } = item;
    return { evidence_index: selectEvidence(bank, item).evidence_index, ...display };
  });
  return { choices, append: starts.map(start => cite(request.sources.answer.id, evidence.message_index, source,
    start, Math.min(point.end, start + limit)).evidence_id) };
}

type SubmittedProblem = Omit<SessionProblem, "problem_id" | "evidence"> & { actor_index: number; evidence: { index: number; reason: string }[] };
function resolveProblems(request: AgentRequest, problems: SubmittedProblem[], audit: ToolAudit, field: string, session = false): SessionProblem[] {
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const issues: ValidationIssue[] = [];
  const result = problems.map((problem, index) => {
    const component = attributionComponentLabel(problem.component, problem.actor_index, request.input.components as JsonObject[]);
    const actor = (request.input.components as JsonObject[]).find(entry => entry.component_index === problem.actor_index)!;
    const { actor_index: _componentIndex, ...description } = problem;
    return { ...description, component, problem_id: `${session ? "s-" : ""}p${index + 1}`,
      evidence: problem.evidence.flatMap((selection, evidenceIndex) => {
        try {
          const path = `/${field}/${index}/evidence/${evidenceIndex}`;
          const reference = resolveEvidenceSelection(audit.evidenceBank ?? [], { evidence_index: selection.index }, path);
          const evidence = resolveAttributionEvidence(request, reference, audit, path);
          if (evidence.quote.length > 400) {
            const repair = quoteRepair(request, audit, evidence);
            throw new ValidationError([{ category: "evidence", code: "quote_too_long", path: `${path}/index`,
              message: "引文超过400字，请只替换本条 evidence.index，选择反馈中不超过400字的原文片段。",
              expected: { quote_chars_limit: 400, validation_limit: 400,
                ...(repair ? { suggested_evidence: repair.choices, append_evidence_ids: repair.append } : {}) } }]);
          }
          const point = parseEvidenceCoordinates(evidence.evidence_id);
          const position = (request.input.source_positions as { trace_index: number; message_index: number }[])[evidence.message_index];
          if (!point || !position) throw new ValidationError([{ category: "evidence", code: "evidence_position_invalid", path,
            message: "证据必须能定位到本次收到的原始消息。" }]);
          return [{ position: attributionEvidencePosition(position.trace_index, position.message_index, evidence.evidence_id),
            component: evidenceComponent(raw.messages[evidence.message_index] ?? {}, point.kind === "image" ? "image" : point.path, String(actor.name)),
            quote: evidence.quote, reason: selection.reason }];
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          issues.push(...error.issues!);
          return [];
        }
      }) };
  });
  if (issues.length) throw new ValidationError(issues);
  return result;
}
export const traceAttributionProfile: AgentProfile = {
  id: "trace", requestSchema: { type: "object", required: ["trace_meta", "question", "answer", "compact", "ground_truth", "source_positions"],
    properties: { ground_truth: { type: "object", required: ["available", "value"],
      properties: { available: { type: "boolean" }, value: {} }, additionalProperties: false } }, additionalProperties: true },
  submissionSchema: traceSubmission,
  modelSubmissionSchema(request) {
    if (traceHasStandard(request)) return traceWithStandardSchema;
    const { is_correct: _correct, correct_reason: _reason, ...properties } = traceSubmission.properties;
    return { ...traceSubmission, properties };
  },
  validateSubmission(request, draft) {
    return traceHasStandard(request) && !validateTraceWithStandard(draft) ? schemaIssues(validateTraceWithStandard.errors, draft) : [];
  },
  resultSchema: traceResult, evidenceSelections: true, maxEvidenceQuoteChars: 400,
  ...tracePrompt, toolNames: tools,
  renderPrompt(input, policy, failure) {
    const truth = input.ground_truth as { available: boolean; value: unknown };
    const numeric = truth.available ? numericReferenceDirectory(truth.value) : [];
    const rules = attributionConditionalRules({ standardAnswer: truth.available, numeric: numeric.length > 0,
      tableDoubts: false, images: false, captureGaps: false });
    const repair = failure?.draft !== undefined && failure.errors.length && failure.errors.every(error =>
      error.code === "quote_too_long" || error.code === "schema_maxLength" && error.path.endsWith("/quote"))
      ? { previous_submission: failure.draft, errors: failure.errors } : undefined;
    return (rules ? rules + "\n\n" : "") + tracePrompt.renderPrompt(investigationMaterial({ ...input,
      numeric_references: numeric.map(item => ({ ...item, reference_index: item.reference_index + 1 })),
      ...(repair ? { evidence_repair: repair } : {}) }), policy, repair ? undefined : failure);
  },
  resolve(request, draft, audit) {
    const value = draft as { summary: string; problems: SubmittedProblem[]; is_correct: 1 | 0 | null; correct_reason: string };
    return { meta: request.input.trace_meta as JsonObject, summary: value.summary,
      problem: resolveProblems(request, value.problems, audit, "problems"),
      is_correct: traceHasStandard(request) ? value.is_correct : null,
      correct_reason: traceHasStandard(request) ? value.correct_reason : attributionNoStandardReason } satisfies TraceAttributionResult;
  },
};
export const sessionAttributionProfile: AgentProfile = {
  id: "session", requestSchema: { type: "object", required: ["session_meta", "qa", "source_positions", "turns", "compact"], additionalProperties: true },
  submissionSchema: sessionSubmission, resultSchema: sessionAttributionResultSchema,
  evidenceSelections: true, maxEvidenceQuoteChars: 400, ...sessionPrompt, toolNames: tools,
  resolve(request, draft, audit) {
    const value = draft as { session_summary: string; session_problem: SubmittedProblem[] };
    return { session_meta: request.input.session_meta as JsonObject, turns: request.input.turns as TraceAttributionResult[],
      session_summary: value.session_summary, session_problem: resolveProblems(request, value.session_problem, audit, "session_problem", true) } satisfies SessionAttributionResult;
  },
};

/** Single-turn session: the process judgment is final; session assembly needs no second model call. */
export const singleSessionAttributionProfile: AgentProfile = {
  ...traceAttributionProfile, id: "single", resultSchema: sessionAttributionResultSchema,
  resolve(request, draft, audit) {
    const turn = traceAttributionProfile.resolve!(request, draft, audit) as TraceAttributionResult;
    return { session_meta: request.input.session_meta as JsonObject, turns: [turn],
      session_summary: turn.summary, session_problem: [] } satisfies SessionAttributionResult;
  },
};
