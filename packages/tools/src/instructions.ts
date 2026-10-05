import { canonical } from "@eval/contracts";
import { cite, evidenceSources } from "./evidence.js";

export interface NormativeSource {
  message_index: number;
  path: string;
  role: "system" | "developer" | "user";
  content: unknown;
  evidence: ReturnType<typeof cite>[];
}

export interface InstructionSource extends NormativeSource {
  role: "system" | "developer";
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const contentText = (value: unknown): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map(contentText).join("\n")
  : typeof object(value)?.text === "string" ? object(value)!.text as string : "";
const contentPaths = (value: unknown, path: string): string[] => typeof value === "string" ? [path]
  : Array.isArray(value) ? value.flatMap((child, index) => contentPaths(child, `${path}/${index}`))
  : typeof object(value)?.text === "string" ? [`${path}/text`] : [];
// Collected assistant messages omit renderer-only visual resource tags from the LLM output.
const answerText = (value: unknown) => contentText(value).replace(/<visual>\s*\{[^{}]*\}\s*<\/visual>/gu, "")
  .replace(/\s+/gu, " ").trim();
const assistantKey = (value: unknown): string | undefined => {
  const message = object(value);
  if (message?.role !== "assistant") return undefined;
  const text = answerText(message.content), calls = message.tool_calls ?? [];
  if (!text && (!Array.isArray(calls) || !calls.length)) return undefined;
  return canonical({ text, tool_calls: calls });
};
const contextOf = (turn: Record<string, unknown>): { messages: unknown[]; path: string } | undefined => {
  if (Array.isArray(turn.input_messages)) return { messages: turn.input_messages, path: "/input_messages" };
  const nested = object(turn.input_messages);
  if (Array.isArray(nested?.messages)) return { messages: nested.messages, path: "/input_messages/messages" };
  return undefined;
};

const finalIndexOf = (raw: { messages: unknown[] }, provided?: number) =>
  provided ?? raw.messages.findLastIndex(message => {
    const value = object(message);
    return value?.role === "assistant" && !!contentText(value.content).trim();
  });

/** Return the actual final-answer assistant history in source order, excluding independent planners. */
export function answerTurnContexts(raw: { messages: unknown[] }, finalMessageIndex?: number): { message_index: number; path: string }[] {
  const finalIndex = finalIndexOf(raw, finalMessageIndex);
  if (finalIndex < 0 || finalIndex >= raw.messages.length) return [];
  const finalKey = assistantKey(raw.messages[finalIndex]);
  const turns = raw.messages.slice(0, finalIndex).flatMap((message, index) => {
    const value = object(message);
    if (value?.type !== "llm_turn") return [];
    const context = contextOf(value);
    if (!context || !Array.isArray(value.output)) return [];
    return [{ index, context, outputs: value.output.flatMap(output => {
      const key = assistantKey(output);
      return key ? [key] : [];
    }) }];
  });
  const answerTurns = new Set<number>();
  const anchor = finalKey && turns.findLast(turn => turn.outputs.includes(finalKey));
  const visit = (turn: typeof turns[number]) => {
    if (answerTurns.has(turn.index)) return;
    answerTurns.add(turn.index);
    const history = new Set(turn.context.messages.flatMap(message => {
      const key = assistantKey(message);
      return key ? [key] : [];
    }));
    for (const previous of turns) if (previous.index < turn.index && previous.outputs.some(key => history.has(key)))
      visit(previous);
  };
  if (anchor) visit(anchor);
  return turns.filter(turn => answerTurns.has(turn.index))
    .map(turn => ({ message_index: turn.index, path: turn.context.path }));
}

/** Retain governing messages from the actual answer chain and preceding top-level conversation. */
export function normativeSources(raw: { messages: unknown[] }, inputId: string, finalMessageIndex?: number): NormativeSource[] {
  const finalIndex = finalIndexOf(raw, finalMessageIndex);
  if (finalIndex < 0 || finalIndex >= raw.messages.length) return [];
  const answerTurns = new Set(answerTurnContexts(raw, finalIndex).map(turn => turn.message_index));

  const result: NormativeSource[] = [], seen = new Set<string>();
  const add = (messageIndex: number, path: string, value: unknown) => {
    const message = object(value);
    if (message?.role !== "system" && message?.role !== "developer" && message?.role !== "user") return;
    if (message.content === undefined || !contentText(message.content).trim()) return;
    const key = canonical([message.role, message.content]);
    if (seen.has(key)) return;
    seen.add(key);
    const paths = new Set(contentPaths(message.content, path));
    const evidence = evidenceSources(raw.messages[messageIndex]).filter(source => source.kind === "text" &&
      source.text.length && paths.has(source.path))
      .map(source => cite(inputId, messageIndex, source, 0, source.text.length));
    result.push({ message_index: messageIndex, path, role: message.role, content: structuredClone(message.content), evidence });
  };
  raw.messages.slice(0, finalIndex).forEach((message, index) => {
    add(index, "/content", message);
    if (!answerTurns.has(index)) return;
    const context = contextOf(object(message)!);
    context!.messages.forEach((nested, nestedIndex) => add(index, `${context!.path}/${nestedIndex}/content`, nested));
  });
  return result;
}

/** The public instruction catalogue remains limited to system/developer messages. */
export function instructionSources(raw: { messages: unknown[] }, inputId: string, finalMessageIndex?: number): InstructionSource[] {
  return normativeSources(raw, inputId, finalMessageIndex).filter((source): source is InstructionSource => source.role !== "user");
}
