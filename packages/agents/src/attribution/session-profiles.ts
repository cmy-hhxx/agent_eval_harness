import { Ajv2020 } from "ajv/dist/2020.js";
import { ValidationError, attributionEvidencePosition, resolveEvidenceSelection, schemaIssues, selectEvidence, type AgentProfile, type AgentRequest, type JsonObject, type JsonSchema, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { agentPrompt, attributionNoStandardReason } from "@eval/prompts";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceSubmissionSchema from "../../../../schemas/attribution/trace-summary-submission.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionSubmissionSchema from "../../../../schemas/attribution/session-summary-submission.schema.json" with { type: "json" };
import componentSubmissionSchema from "../../../../schemas/attribution/component-submission.schema.json" with { type: "json" };
import componentResultSchema from "../../../../schemas/attribution/component-result.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { resolveAttributionEvidence } from "./source-evidence.js";
import { attributionComponentIdentity, validateComponentReview, validateP4Problem, type ComponentReview, type SubmittedProblem } from "./responsibility.js";
import type { SessionAttributionResult, SessionProblem, TraceAttributionResult } from "./types.js";

const tools = ["read_trace", "search_trace", "view_image", "calculate", "execute_code", "read_artifact"];
const componentPrompt = agentPrompt("attribution", tools, { profile: "component", fileSubmission: false });
const tracePrompt = agentPrompt("attribution", [], { profile: "trace", fileSubmission: false });
const sessionPrompt = agentPrompt("attribution", tools, { profile: "session", fileSubmission: false });
const traceSubmission = structuredClone(traceSubmissionSchema);
const sessionSubmission = structuredClone(sessionSubmissionSchema);
const traceWithStandardSchema = { ...traceSubmission, required: [...traceSubmission.required, "is_correct", "correct_reason"] };
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

function evidenceKind(message: Record<string, unknown>, path: string): "reasoning" | "tool_call" | "answer" | "question" | "model" | "material" {
  if (message.role === "tool" || ["tool_call", "tool_result", "function_call", "function_call_output"].includes(String(message.type))) return "tool_call";
  if (/tool_calls?|function_call|tool_result|function_call_output/iu.test(path)) return "tool_call";
  if (/reasoning|thinking|analysis|calculations?/iu.test(path)) return "reasoning";
  if (message.type === "llm_turn") return "model";
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
      : kind === "answer" ? "answer: 答案合成"
        : kind === "model" ? `model: ${source}`
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

/** Offer actual tool receipts after the failure so a recovery claim can select real follow-up output. */
function recoveryReceiptChoices(request: AgentRequest, audit: ToolAudit, after: number, originMessages: Set<number>) {
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const positions = request.input.source_positions as { trace_index: number }[];
  const traces = new Set([...originMessages].flatMap(index => positions[index] === undefined ? [] : [positions[index]!.trace_index]));
  const bank = audit.evidenceBank ?? (audit.evidenceBank = []);
  const choices: { evidence_id: string; evidence_index: number; message_index: number; quote: string }[] = [];
  for (let index = after + 1; index < raw.messages.length && choices.length < 3; index++) {
    const point = positions[index];
    if (!point || !traces.has(point.trace_index)) continue;
    const message = raw.messages[index]!;
    if (message.role !== "tool" && !["tool_result", "function_call_output"].includes(String(message.type))) continue;
    const sources = evidenceSources(message).filter(item => item.kind === "text" && item.quotable !== false && item.text.length);
    const source = sources.find(item => /\/(?:output|content|result)(?:\/|$)/u.test(item.path)) ??
      sources.sort((a, b) => b.text.length - a.text.length)[0];
    if (!source) continue;
    const receipt = cite(request.sources.answer.id, index, source, 0, Math.min(400, source.text.length));
    choices.push({ evidence_id: receipt.evidence_id, evidence_index: selectEvidence(bank, receipt).evidence_index,
      message_index: index, quote: receipt.quote });
  }
  return { suggested_evidence: choices.map(({ evidence_id: _id, ...visible }) => visible), append: choices.map(item => item.evidence_id) };
}

/** Each problem names one actor offered by this request; the program copies its catalog name. */
function resolveProblems(request: AgentRequest, problems: SubmittedProblem[], audit: ToolAudit, field: string, offset = 0): SessionProblem[] {
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  const issues: ValidationIssue[] = [], resolvedMessages: number[][] = [];
  const result = problems.map((problem, index) => {
    const identity = attributionComponentIdentity(problem.actor_index, request.input.components as JsonObject[], `${field}/${index + offset}/actor_index`);
    const { tool_error_indices: _errorIndices, actor_index: _actor, ...description } = problem;
    const messages: number[] = [];
    const resolved = { ...description, component: identity.name, component_family: identity.component_family, component_role: identity.component_role,
      evidence: problem.evidence.flatMap((selection, evidenceIndex) => {
        try {
          const path = `${field}/${index + offset}/evidence/${evidenceIndex}`;
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
          messages.push(evidence.message_index);
          return [{ position: attributionEvidencePosition(position.trace_index, position.message_index, evidence.evidence_id),
            component: evidenceComponent(raw.messages[evidence.message_index] ?? {}, point.kind === "image" ? "image" : point.path, identity.name),
            quote: evidence.quote, reason: selection.reason }];
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          issues.push(...error.issues!);
          return [];
        }
      }) };
    resolvedMessages.push(messages);
    return resolved;
  });
  if (issues.length) throw new ValidationError(issues);
  const errorMessages = new Map<number, Set<number>>(((request.input.tool_errors as JsonObject[] | undefined) ?? []).map(error => [
    Number(error.tool_error_idx), new Set((error.evidence as JsonObject[]).flatMap(item => {
      const point = parseEvidenceCoordinates(String(item.evidence_id));
      return point ? [point.message_index] : [];
    }))]));
  const finalMessages = new Set(((request.input.final_message_indices as number[] | undefined) ?? []));
  result.forEach((problem, index) => {
    const submitted = problems[index]!;
    validateP4Problem(submitted, resolvedMessages[index]!, { messages: raw.messages, finalMessages,
      errorMessages: new Set(submitted.tool_error_indices.flatMap(id => [...errorMessages.get(id) ?? []])),
      componentRole: problem.component_role }, `${field}/${index + offset}`);
  });
  return result;
}

function traceToolErrors(request: AgentRequest): JsonObject[] { return request.input.tool_errors as JsonObject[]; }

/** Each task offers one program-formed group; the model selects members but never forms or renames them. */
function resolveComponentReview(request: AgentRequest, review: ComponentReview, audit: ToolAudit): SessionProblem[] {
  const components = request.input.components as JsonObject[], errors = traceToolErrors(request);
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  validateComponentReview(components, review, errors);
  const read = (selection: number, path: string) => resolveAttributionEvidence(request,
    resolveEvidenceSelection(audit.evidenceBank ?? [], { evidence_index: selection }, path), audit, path);
  review.evidence.forEach((selection, j) => read(selection, `/evidence/${j}`));
  for (const [j, error] of review.tool_error_reviews.entries()) {
    const path = `/tool_error_reviews/${j}/evidence`;
    const origin = errors.find(item => item.tool_error_idx === error.tool_error_idx)!;
    const messages = new Set((origin.evidence as { evidence_id: string }[]).map(item => parseEvidenceCoordinates(item.evidence_id)!.message_index));
    const proofs = error.evidence.map((selection, k) => read(selection, `${path}/${k}`));
    if (!proofs.some(proof => messages.has(proof.message_index)))
      throw new ValidationError([{ category: "evidence", code: "tool_error_origin", path,
        message: "处置必须回指该条 tool_error 的原始报错消息，并结合实际请求、参数/代码、回执和后续结果核对原因及剩余影响。" }]);
    if (error.status === "recovered_impact" || error.status === "recovered_no_impact") {
      const lastError = Math.max(...messages);
      if (!proofs.some(proof => {
        const message = raw.messages[proof.message_index];
        return proof.message_index > lastError && (message?.role === "tool" || ["tool_result", "function_call_output"].includes(String(message?.type)));
      })) {
        const repair = recoveryReceiptChoices(request, audit, lastError, messages);
        throw new ValidationError([{ category: "evidence", code: "tool_error_recovery", path,
          message: "recovered_no_impact/recovered_impact 必须选择该次报错之后的实际工具回执，证明重试、修复或替代路径恢复；仅失败回执、计划或终稿自述不证明恢复。若实际未恢复但交付不受影响，改记 no_delivery_impact 并说明理由；补选反馈中 suggested_evidence 的后续工具回执后重算剩余影响，仍无法确认则记 uncertain。",
          expected: { recovery_receipt_after_message_index: lastError,
            ...(repair.suggested_evidence.length ? { suggested_evidence: repair.suggested_evidence, append_evidence_ids: repair.append } : {}) } }]);
      }
    }
  }
  return resolveProblems(request, review.problems, audit, "/problems");
}


const componentResult = structuredClone(componentResultSchema) as any;
componentResult.properties.problem.items = bareProblem;

/** A group task investigates one program-formed invocation chain or the delivery; normal groups return no problems. */
export const componentAttributionProfile: AgentProfile = {
  id: "component", requestSchema: { type: "object", required: ["components", "tool_errors", "source_positions", "trace_index"] },
  submissionSchema: componentSubmissionSchema, resultSchema: componentResult, evidenceSelections: true, maxEvidenceQuoteChars: 400,
  ...componentPrompt, toolNames: tools, maxToolCalls: 4,
  resolve(request, draft, audit) {
    const value = draft as ComponentReview;
    const problems = resolveComponentReview(request, value, audit);
    return { components: (request.input.components as JsonObject[]).map(component => String(component.name)), content: value.content,
      evidence: value.evidence, tool_error_reviews: value.tool_error_reviews, problem: problems };
  },
};

/** This call only summarizes code-merged component results; it cannot change the problems. */
const traceWithoutStandardSchema = ((): JsonSchema => {
  const { is_correct: _correct, correct_reason: _reason, ...properties } = traceSubmission.properties;
  return { ...traceSubmission, properties };
})();
export const traceAttributionProfile: AgentProfile = {
  id: "trace", requestSchema: { type: "object", required: ["trace_meta", "ground_truth", "problem", "failed_components"] },
  submissionSchema: traceSubmission, resultSchema: traceResult, ...tracePrompt, toolNames: [], maxToolCalls: 0,
  // Both variants are fixed; returning one object per variant keeps schema validation compiled once.
  modelSubmissionSchema(request) {
    return traceHasStandard(request) ? traceWithStandardSchema : traceWithoutStandardSchema;
  },
  validateSubmission(request, draft) {
    return traceHasStandard(request) && !validateTraceWithStandard(draft) ? schemaIssues(validateTraceWithStandard.errors, draft) : [];
  },
  resolve(request, draft) {
    const value = draft as { summary: string; is_correct: 1 | 0 | null; correct_reason: string };
    const partial = (request.input.failed_components as string[]).length > 0;
    return { meta: request.input.trace_meta as JsonObject, summary: (partial ? "评测覆盖不完整：部分组件调查未完成；" : "") + value.summary, problem: request.input.problem as SessionProblem[],
      is_correct: traceHasStandard(request) ? value.is_correct : null,
      correct_reason: traceHasStandard(request) ? value.correct_reason : attributionNoStandardReason } satisfies TraceAttributionResult;
  },
};

export const sessionAttributionProfile: AgentProfile = {
  id: "session", requestSchema: { type: "object", required: ["session_meta", "qa", "source_positions", "turns", "components"] },
  submissionSchema: sessionSubmission, resultSchema: sessionAttributionResultSchema,
  evidenceSelections: true, maxEvidenceQuoteChars: 400, ...sessionPrompt, toolNames: tools, maxToolCalls: 2,
  resolve(request, draft, audit) {
    const value = draft as { session_summary: string; session_problem: Omit<SubmittedProblem, "tool_error_indices">[] };
    const problems = value.session_problem.flatMap((problem, index) => {
      const resolved = resolveProblems(request, [{ ...problem, tool_error_indices: [] }], audit, "/session_problem", index);
      const positions = request.input.source_positions as { trace_index: number }[];
      const traces = new Set(problem.evidence.map(item => {
        const point = parseEvidenceCoordinates(audit.evidenceBank![item.index - 1]!);
        return point && positions[point.message_index]!.trace_index;
      }));
      if (traces.size < 2) throw new ValidationError([{ category: "evidence", code: "cross_turn_evidence", path: `/session_problem/${index}/evidence`,
        message: "跨轮问题必须引用至少两个 trace 的原始问答或执行证据；单轮问题保留在对应 turn。" }]);
      return resolved;
    });
    return { session_meta: request.input.session_meta as JsonObject, turns: request.input.turns as TraceAttributionResult[],
      session_summary: value.session_summary, session_problem: problems } satisfies SessionAttributionResult;
  },
};

/** A single-turn session is a code-owned assembly, with no additional model request. */
export const sessionAssemblyProfile: AgentProfile = {
  id: "assembly", requestSchema: { type: "object", required: ["session_meta", "turns"] },
  submissionSchema: sessionAttributionResultSchema, resultSchema: sessionAttributionResultSchema,
  ...tracePrompt, toolNames: [], maxToolCalls: 0,
  resolve(request) {
    const turns = request.input.turns as TraceAttributionResult[];
    return { session_meta: request.input.session_meta as JsonObject, turns, session_summary: turns[0]!.summary, session_problem: [] };
  },
};
