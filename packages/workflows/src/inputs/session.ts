import { contentText } from "./records.js";
import { normalizeTraceInput } from "./normalize.js";
import type { Candidate, RawInput } from "./types.js";

/** One addressable QA trace in a session, with exact source coordinates retained separately. */
export interface SessionQa {
  trace_index: number;
  trace_id: string | null;
  question: string;
  answer: string;
}

export function sessionQas(raw: RawInput, candidate: Candidate): SessionQa[] {
  return (candidate.turns ?? [{ trace_index: 0, trace_id: candidate.trace_id, question: candidate.question,
    final_index: candidate.final_index, component_scopes: [] }]).map((trace, index) => {
    const projected = normalizeTraceInput(raw, trace.trace_index);
    return { trace_index: trace.trace_index, trace_id: trace.trace_id, question: trace.question,
      answer: contentText(projected.messages[trace.final_index ?? index]?.content) };
  });
}

/** Comparison receives the whole session as ordered QA text, never individual trace internals. */
export function sessionComparisonInput(raw: RawInput, candidate: Candidate): RawInput {
  const qas = sessionQas(raw, candidate);
  const question = qas.map((qa, index) => `Q${index + 1}: ${qa.question}`).join("\n\n");
  const answer = qas.map((qa, index) => `A${index + 1}: ${qa.answer}`).join("\n\n");
  return { ...raw, messages: [
    { type: "user_question", role: "user", content: question },
    { type: "final_answer", role: "assistant", content: answer },
  ], meta: { ...(raw.meta ?? {}), session_id: candidate.session_id ?? candidate.case_id } };
}
