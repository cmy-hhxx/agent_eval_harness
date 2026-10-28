import { Ajv2020 } from "ajv/dist/2020.js";
import { ValidationError, resolveEvidenceSelection, schemaIssues, selectEvidence, type AgentProfile, type AgentRequest, type JsonObject, type ToolAudit } from "@eval/contracts";
import { agentPrompt, attributionConditionalRules, attributionNoStandardReason } from "@eval/prompts";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import componentRequestSchema from "../../../../schemas/attribution/component-request.schema.json" with { type: "json" };
import componentSubmissionSchema from "../../../../schemas/attribution/component-submission.schema.json" with { type: "json" };
import componentResultSchema from "../../../../schemas/attribution/component-result.schema.json" with { type: "json" };
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceSubmissionSchema from "../../../../schemas/attribution/trace-summary-submission.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionSubmissionSchema from "../../../../schemas/attribution/session-summary-submission.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { resolveAttributionEvidence } from "./source-evidence.js";
import { investigationMaterial } from "./investigation-material.js";
import { numericReferenceDirectory } from "./units.js";
import type { ComponentReviewResult, SessionAttributionResult, SessionProblem, TraceAttributionResult } from "./types.js";

const componentTools = [
  "read_trace", "search_trace", "view_image", "calculate", "execute_code",
  "read_artifact",
];
const componentPrompt = agentPrompt("attribution", componentTools, { profile: "component", fileSubmission: false });
const tracePrompt = agentPrompt("attribution", [], { profile: "trace", fileSubmission: false });
const sessionPrompt = agentPrompt("attribution", [], { profile: "session", fileSubmission: false });
const componentSchema = new Ajv2020({ allErrors: true, strict: false }).compile(componentSubmissionSchema);
const traceWithStandardSchema = { ...traceSubmissionSchema, required: ["summary", "is_correct", "correct_reason"] };
const validateTraceWithStandard = new Ajv2020({ allErrors: true, strict: false }).compile(traceWithStandardSchema);
const traceHasStandard = (request: AgentRequest) => (request.input.ground_truth as { available: boolean }).available;
const copy = <T>(value: T): T => structuredClone(value);
const inline = <T>(value: T): T => {
  const result = copy(value) as Record<string, unknown>;
  delete result.$id;
  delete result.$schema;
  return result as T;
};
const bareProblem = copy(problemSchema) as Record<string, unknown>;
delete bareProblem.$id;
delete bareProblem.$schema;
const componentResult = copy(componentResultSchema) as any;
componentResult.properties.problems.items = copy(bareProblem);
const traceResult = copy(traceResultSchema) as any;
traceResult.properties.problem.items = copy(bareProblem);
export const sessionAttributionResultSchema = copy(sessionResultSchema) as any;
delete sessionAttributionResultSchema.$id;
delete sessionAttributionResultSchema.$schema;
const inlineTraceResult = inline(traceResult) as any;
inlineTraceResult.properties.problem.items = copy(bareProblem);
sessionAttributionResultSchema.properties.turns.items = inlineTraceResult;
sessionAttributionResultSchema.properties.session_problem.items = copy(bareProblem);

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
      if (evidence.quote.length > 800) {
        const repair = quoteRepair(request, audit, evidence);
        throw new ValidationError([{ category: "evidence", code: "quote_too_long", path: `${path}/index`,
          message: "quote 校验上限为 800 字；请优先选择不超过 400 字的片段，并只替换本条 evidence.index，不要重新生成整份归因。", actual: evidence.quote.length,
          expected: { quote_chars_limit: 400, validation_limit: 800,
            ...(repair ? { suggested_evidence: repair.choices, append_evidence_ids: repair.append,
              repair_action: "从 suggested_evidence 中选择 2–3 个能支持同一结论的合规引用并替换 index；保留其余字段。" } : {}) } }]);
      }
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
  requestSchema: componentRequestSchema,
  submissionSchema: componentSubmissionSchema,
  resultSchema: componentResult,
  evidenceSelections: true,
  maxEvidenceQuoteChars: 400,
  ...componentPrompt,
  renderPrompt(input, policy, failure) {
    const analysis = input.task_analysis as { requirements: Record<string, unknown>[] } | undefined;
    const answer = input.answer as Record<string, unknown>, truth = input.ground_truth as { available: boolean; value: unknown } | undefined;
    const requirements = analysis?.requirements.map((item, index) => ({ ...item, requirement_index: Number(item.requirement_index ?? index) + 1 }));
    const numeric = truth?.available ? numericReferenceDirectory(truth.value) : [];
    const tables = answer.table_check_results as { rows: unknown[] }[] | undefined;
    const images = answer.final_images as { image_count: number } | undefined;
    const rules = attributionConditionalRules({ standardAnswer: truth?.available ?? false, numeric: numeric.length > 0,
      tableDoubts: Number(answer.table_check_count ?? 0) > 0 || (tables?.some(table => table.rows.length > 0) ?? false),
      images: (images?.image_count ?? 0) > 0, captureGaps: Array.isArray(answer.capture_gaps) && answer.capture_gaps.length > 0 });
    const shown = { ...input, ...(analysis ? { task_analysis: { ...analysis, requirements } } : {}) };
    return (rules ? rules + "\n\n" : "") + componentPrompt.renderPrompt(investigationMaterial({ ...shown,
      numeric_references: numeric.map(item => ({ ...item, reference_index: item.reference_index + 1 })) }), policy, failure);
  },
  toolNames: componentTools,
  resolve: componentReview,
};

export const traceAttributionProfile: AgentProfile = {
  id: "trace",
  requestSchema: { type: "object", required: ["trace_meta", "question", "answer", "problems", "ground_truth"],
    properties: { ground_truth: { type: "object", required: ["available", "value"],
      properties: { available: { type: "boolean" }, value: {} }, additionalProperties: false } }, additionalProperties: true },
  submissionSchema: traceSubmissionSchema,
  modelSubmissionSchema(request) {
    return traceHasStandard(request) ? traceWithStandardSchema : { ...traceSubmissionSchema,
      properties: { summary: traceSubmissionSchema.properties.summary } };
  },
  validateSubmission(request, draft) {
    return traceHasStandard(request) && !validateTraceWithStandard(draft) ? schemaIssues(validateTraceWithStandard.errors, draft) : [];
  },
  resultSchema: traceResult,
  ...tracePrompt,
  toolNames: [],
  resolve(request, draft) {
    const value = draft as { summary: string; is_correct: 1 | 0 | null; correct_reason: string };
    const unreviewed = (request.input.review_coverage as { unreviewed_count: number } | undefined)?.unreviewed_count ?? 0;
    const result: TraceAttributionResult = { meta: (request.input.trace_meta ?? {}) as JsonObject,
      summary: value.summary + (unreviewed ? `（本次有 ${unreviewed} 项审查未完成，问题清单仅覆盖已完成范围。）` : ""),
      problem: (request.input.problems ?? []) as SessionProblem[],
      is_correct: traceHasStandard(request) ? value.is_correct : null,
      correct_reason: traceHasStandard(request) ? value.correct_reason : attributionNoStandardReason };
    return result;
  },
};

export const sessionAttributionProfile: AgentProfile = {
  id: "session",
  requestSchema: { type: "object", required: ["session_meta", "qa", "turns"], additionalProperties: true },
  submissionSchema: sessionSubmissionSchema,
  resultSchema: sessionAttributionResultSchema,
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
