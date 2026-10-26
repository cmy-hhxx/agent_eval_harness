import { object } from "@eval/contracts";
import type { RawInput, SessionTurn } from "./types.js";

/** Validate a session or flat record without rewriting its source messages. */
export function normalizeInput(value: unknown): RawInput {
  const source = object(value);
  if (!Object.hasOwn(source, "traces")) return source as RawInput;
  if (Object.hasOwn(source, "messages")) throw new Error("输入不能同时包含 messages 和 traces");
  if (!Array.isArray(source.traces) || !source.traces.length) throw new Error("traces 必须是非空数组");
  const session = object(source.meta), turns: SessionTurn[] = source.traces.map((value, index) => {
    const trace = object(value), metadata = object(trace.meta);
    if (!Array.isArray(trace.messages) || !trace.messages.length ||
        trace.messages.some(message => !message || typeof message !== "object" || Array.isArray(message)))
      throw new Error(`traces[${index}].messages 必须是非空消息对象数组`);
    if (metadata.n_messages !== undefined && metadata.n_messages !== trace.messages.length)
      throw new Error(`traces[${index}].meta.n_messages 与实际数量不一致`);
    for (const key of ["case_id", "batch_id", "session_id"]) {
      const identity = source[key] ?? session[key];
      if (identity !== undefined && metadata[key] !== undefined && identity !== metadata[key])
        throw new Error(`外层 ${key} 与 traces[${index}].meta.${key} 冲突`);
    }
    if (metadata.ok === false) throw new Error("trace 采集失败");
    return { meta: metadata, messages: trace.messages } as SessionTurn;
  });
  if (session.n_traces !== undefined && session.n_traces !== turns.length)
    throw new Error("meta.n_traces 与实际数量不一致");
  const totalMessages = turns.reduce((total, turn) => total + turn.messages.length, 0);
  if (session.n_messages !== undefined && session.n_messages !== totalMessages)
    throw new Error("meta.n_messages 与会话消息总数不一致");
  const { traces: _traces, ...record } = source;
  return { ...record, meta: session, session_meta: session, messages: turns[0]!.messages, turns } as RawInput;
}

/** Project one trace for tools and Agents while retaining the session-level source identity. */
export function normalizeTraceInput(value: unknown, traceIndex = 0): RawInput {
  const source = object(value);
  const input = Array.isArray(source.turns) && Object.hasOwn(source, "messages") ? source as RawInput : normalizeInput(value);
  if (!input.turns) {
    if (traceIndex !== 0) throw new Error("单轮输入只能选择 trace_index 0");
    return input;
  }
  const trace = input.turns[traceIndex];
  if (!trace) throw new Error(`trace_index 不在会话目录中：${traceIndex}`);
  const { turns: _turns, ...session } = input;
  const meta = { ...(session.meta ?? {}), ...(trace.meta ?? {}) };
  for (const key of ["case_id", "batch_id"]) {
    delete meta[key];
    if (session[key] !== undefined) meta[key] = session[key];
    else if (input.meta && input.meta[key] !== undefined) meta[key] = input.meta[key];
  }
  if (trace.meta?.ok === false) meta.ok = false;
  return { ...session, meta, trace_id: trace.meta?.trace_id ?? null, messages: trace.messages };
}
