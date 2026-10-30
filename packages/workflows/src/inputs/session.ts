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

/** The input UUID always addresses this ordered message space, in every evaluation stage. */
export function sessionSource(raw: RawInput) {
  const positions: { trace_index: number; message_index: number }[] = [];
  const messages = (raw.turns ?? [{ messages: raw.messages }]).flatMap((turn, trace_index) =>
    turn.messages.map((message, message_index) => {
      positions.push({ trace_index, message_index });
      return message;
    }));
  const { turns: _turns, ...record } = raw;
  return { raw: { ...record, messages } as RawInput, positions };
}

export function sessionQas(raw: RawInput, candidate: Candidate): SessionQa[] {
  return (candidate.turns ?? [{ trace_index: 0, trace_id: candidate.trace_id, question: candidate.question,
    final_index: candidate.final_index }]).map((trace, index) => {
    const projected = normalizeTraceInput(raw, trace.trace_index);
    return { trace_index: trace.trace_index, trace_id: trace.trace_id, question: trace.question,
      answer: contentText(projected.messages[trace.final_index ?? index]?.content) };
  });
}
