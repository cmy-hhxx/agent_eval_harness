import { object } from "@eval/contracts";
import type { Message, RawInput } from "./types.js";

/**
 * A source structure. Adapters are pure declarations: add a new structure by
 * implementing this interface and registering it in `inputAdapters`; no other
 * module branches on the adapter id.
 */
export interface InputAdapter {
  readonly id: string;
  /** Whether a message belongs to this structure. */
  accepts(message: Message): boolean;
  /** The answering model recorded by the source, or null when absent. */
  answerModel(raw: RawInput, messages: Message[], finalIndex: number): string | null;
}

const accepts =
  (types: string[], fallback?: string) =>
  (message: Message): boolean =>
    types.includes(String(message.type || fallback));

/** `meta.usage.type` is the only model field shared by both current sources. */
const metadataModel = (raw: RawInput): string | null => {
  const usage = raw.meta?.usage;
  return usage && typeof usage === "object" ? ((object(usage).type as string | undefined) ?? null) : null;
};

export const inputAdapters: Record<string, InputAdapter> = {
  /** OpenAI-style `messages` trace: reasoning and function calls, no explicit turns. */
  a: {
    id: "a",
    accepts: accepts(["message", "reasoning", "function_call", "function_call_output"], "message"),
    answerModel: (raw) => metadataModel(raw),
  },
  /** Agent-turns trace: explicit user/llm/tool/final_answer markers. */
  b: {
    id: "b",
    accepts: accepts(["user_question", "llm_turn", "tool_call", "tool_result", "final_answer"]),
    answerModel: (raw, messages, finalIndex) => {
      const model = messages.slice(0, finalIndex).findLast((m) => m.type === "llm_turn" && m.model)?.model;
      return model ? String(model) : metadataModel(raw);
    },
  },
};

export const inputAdapterIds = Object.keys(inputAdapters);

export function resolveAdapter(id: string): InputAdapter {
  const adapter = inputAdapters[id];
  if (!adapter) throw new Error("未注册的输入适配器：" + id);
  return adapter;
}
