import { object } from "@eval/contracts";
import type { RawInput } from "./types.js";

/** Project a single session trace into the shared material view; never rewrite source messages. */
export function normalizeInput(value: unknown): RawInput {
  const source = object(value);
  if (!Object.hasOwn(source, "traces")) return source as RawInput;
  if (Object.hasOwn(source, "messages")) throw new Error("输入不能同时包含 messages 和 traces");
  if (!Array.isArray(source.traces) || !source.traces.length) throw new Error("traces 必须是非空数组");
  if (source.traces.length !== 1) throw new Error("暂不支持多轮评测：traces 必须恰好包含一轮，不能截取或拼接");
  const session = object(source.meta), trace = object(source.traces[0]), metadata = object(trace.meta);
  if (!Array.isArray(trace.messages) || !trace.messages.length ||
      trace.messages.some(message => !message || typeof message !== "object" || Array.isArray(message)))
    throw new Error("traces[0].messages 必须是非空消息对象数组");
  for (const [declared, actual, field] of [
    [session.n_traces, source.traces.length, "meta.n_traces"],
    [session.n_messages, trace.messages.length, "meta.n_messages"],
    [metadata.n_messages, trace.messages.length, "traces[0].meta.n_messages"],
  ] as const)
    if (declared !== undefined && declared !== actual) throw new Error(`${field} 与实际数量不一致`);
  for (const key of ["case_id", "batch_id", "session_id"]) {
    const identity = source[key] ?? session[key];
    if (identity !== undefined && metadata[key] !== undefined && identity !== metadata[key])
      throw new Error(`外层 ${key} 与 traces[0].meta.${key} 冲突`);
  }
  const meta = { ...metadata, ...session };
  // Case identity belongs to the outer record, also used by scanning and duplicate detection.
  for (const key of ["case_id", "batch_id"]) {
    delete meta[key];
    if (Object.hasOwn(session, key)) meta[key] = session[key];
  }
  // These describe the selected answer, not session totals or the fetching agent.
  for (const key of ["trace_id", "model", "usage", "first_token_time_cost", "first_answer_time_cost", "finish_answer_time_cost"]) {
    delete meta[key];
    if (Object.hasOwn(metadata, key)) meta[key] = metadata[key];
  }
  if (metadata.ok === false) meta.ok = false;
  const { traces: _traces, ...record } = source;
  return { ...record, meta, trace_id: metadata.trace_id ?? null, messages: trace.messages } as RawInput;
}
