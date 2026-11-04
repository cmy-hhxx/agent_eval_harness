import type { JsonObject } from "@eval/contracts";
import type { RubricCase, RubricChecklistItem } from "@eval/agents/rubric";
import type { Candidate } from "@eval/workflows/inputs";
import type { RubricStandardCategory } from "./catalog.js";

interface Span { type?: string; role?: string | null; content?: unknown }

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object") {
    const parts = value as Record<string, unknown>;
    if (typeof parts.text === "string") return parts.text;
  }
  return "";
};

/** Trace bodies stay out of the material; the judge reaches them through read_trace/search_trace. */
export function rubricMaterial(input: {
  candidate: Candidate;
  traceIndex: number;
  category: RubricStandardCategory;
  checklist: RubricChecklistItem[];
  messages: unknown[];
  positions: { trace_index: number; message_index: number }[];
  attribution?: JsonObject;
}): RubricCase {
  const { candidate, traceIndex, category, checklist, messages, positions } = input;
  const spans = positions.flatMap((point, index) => point.trace_index === traceIndex ? [{ message: (messages[index] ?? {}) as Span, index }] : []);
  const question = spans.find(span => span.message.type === "user_question" || span.message.role === "user");
  const finals = spans.filter(span => span.message.type === "final_answer");
  const answer = finals.length ? text(finals[finals.length - 1]!.message.content) : "";
  const traced = spans.some(span => ["llm_turn", "tool_call", "tool_result", "function_call", "function_call_output"].includes(String(span.message.type)));
  return {
    case_id: candidate.case_id,
    trace_index: traceIndex,
    batch_id: candidate.batch_id,
    version: candidate.version,
    category: {id: category.id, name: category.name, l1: category.l1, l1_name: category.l1_name, definition: category.definition, core: category.core},
    task_question: (question ? text(question.message.content) : "") || candidate.question,
    answer,
    availability: {answer: answer.trim() ? "available" : "unavailable", trace: traced ? "available" : "not_collected", user_context: "available"},
    checklist,
    ...(input.attribution ? {attribution: input.attribution} : {}),
  } as RubricCase;
}
