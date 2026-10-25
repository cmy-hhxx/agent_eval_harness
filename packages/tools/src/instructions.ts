import { canonical } from "@eval/contracts";
import { cite, evidenceSources } from "./evidence.js";

export interface NormativeSource {
  message_index: number;
  path: string;
  role: "system" | "developer" | "user" | "tool";
  content: unknown;
  evidence: ReturnType<typeof cite>[];
}

export interface InstructionSource extends NormativeSource {
  role: "system" | "developer" | "tool";
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
const assistantKey = (value: unknown, renderedHtml = false): string | undefined => {
  const message = object(value);
  if (!message || message.role !== "assistant" && !(message.role === undefined && message.type === "final_answer")) return undefined;
  const content = renderedHtml ? contentText(message.content).replace(/<vis-html\s+ref=(['"])[^'"<>]+\1\s*\/>/gu, "") : message.content;
  const text = answerText(content), calls = message.tool_calls ?? [];
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
    return value && (value.role === "assistant" || value.role === undefined && value.type === "final_answer") && !!contentText(value.content).trim();
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
    return [{ index, context, originalOutputs: value.output, outputs: value.output.flatMap(output => {
      const key = assistantKey(output);
      return key ? [key] : [];
    }) }];
  });
  const answerTurns = new Set<number>();
  let anchor = finalKey ? turns.findLast(turn => turn.outputs.includes(finalKey)) : undefined;
  // A captured image replaces this renderer tag, not the generated prose. Match the
  // complete remaining text and require a unique generation; proximity is not proof.
  const finalContent = object(raw.messages[finalIndex])?.content;
  if (!anchor && finalKey && Array.isArray(finalContent) && finalContent.some(block => object(block)?.type === "output_image")) {
    const matches = turns.filter(turn => turn.originalOutputs.some(output =>
      /<vis-html\s+ref=(['"])[^'"<>]+\1\s*\/>/u.test(contentText(object(output)?.content)) && assistantKey(output, true) === finalKey));
    if (matches.length === 1) anchor = matches[0];
  }
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

/** Only an actual successful skill load supplies tool-origin instructions; ordinary tool data does not. */
function loadedSkillSources(raw: { messages: unknown[] }, inputId: string, finalIndex: number, answerTurns: Set<number>): NormativeSource[] {
  const result: NormativeSource[] = [], used = new Set<number>();
  let unpaired: number[] = [];
  const callId = (message: Record<string, unknown>, call: boolean) => {
    const values = [message.call_id, message.tool_call_id, ...(call ? [message.id] : [])].filter(id => id !== undefined);
    if (values.some(id => typeof id !== "string" || !id)) return null;
    const ids = values as string[];
    return new Set(ids).size > 1 ? null : ids[0];
  };
  raw.messages.slice(0, finalIndex).forEach((value, index) => {
    const returned = object(value);
    if (returned?.type === "tool_call" && returned.name === "view_skill" && callId(returned, true) === undefined)
      unpaired.push(index);
    if (returned?.type !== "tool_result" || returned.name !== "view_skill") return;
    const id = callId(returned, false);
    if (id === null) return;
    const candidates = id === undefined ? unpaired : raw.messages.slice(0, index).flatMap((item, i) => {
      const call = object(item);
      return call?.type === "tool_call" && call.name === "view_skill" && callId(call, true) === id ? [i] : [];
    });
    if (id === undefined) unpaired = [];
    if (candidates.length !== 1 || candidates[0]! < 0 || used.has(candidates[0]!)) return;
    if (id === undefined && candidates[0] !== index - 1) return;
    const callIndex = candidates[0]!, call = object(raw.messages[callIndex]);
    if (call?.type !== "tool_call" || call.name !== "view_skill" || callId(call, true) !== id) return;
    used.add(callIndex);
    if (typeof returned.output !== "string" || returned.isError || returned.is_error || returned.error ||
        ["failed", "error"].includes(String(returned.status))) return;
    const input = object(call.input), name = input?.name;
    if (typeof name !== "string" || !name || Object.keys(input!).some(key => key !== "name")) return;
    const envelope = /^\s*<skill_content name="([^"<>\r\n]+)">([\s\S]+)<\/skill_content>\s*$/u.exec(returned.output);
    if (!envelope || envelope[1] !== name || /<\/?skill_content\b/u.test(envelope[2]!)) return;
    // Known independent planner calls cannot inject their instructions into the answer chain.
    const parents = typeof call.parent_span === "string" ? raw.messages.slice(0, callIndex).flatMap((item, i) => {
      const turn = object(item);
      return turn?.type === "llm_turn" && turn.parent_span === call.parent_span ? [i] : [];
    }) : [];
    if (answerTurns.size && parents.length && !parents.some(i => answerTurns.has(i))) return;
    const source = evidenceSources(value).find(source => source.kind === "text" && source.path === "/output");
    if (!source) return;
    result.push({ message_index: index, path: "/output", role: "tool", content: returned.output,
      evidence: [cite(inputId, index, source, 0, source.text.length)] });
  });
  return result;
}

/** Retain governing messages from the actual answer chain and preceding top-level conversation. */
export function normativeSources(raw: { messages: unknown[] }, inputId: string, finalMessageIndex?: number): NormativeSource[] {
  const finalIndex = finalIndexOf(raw, finalMessageIndex);
  if (finalIndex < 0 || finalIndex >= raw.messages.length) return [];
  const answerTurns = new Set(answerTurnContexts(raw, finalIndex).map(turn => turn.message_index));

  const result: NormativeSource[] = [], seen = new Set<string>();
  const add = (messageIndex: number, path: string, value: unknown) => {
    const message = object(value);
    if (!message) return;
    const role = message.role ?? (message.type === "user_question" ? "user" : undefined);
    if (role !== "system" && role !== "developer" && role !== "user") return;
    if (message.content === undefined || !contentText(message.content).trim()) return;
    const key = canonical([role, message.content]);
    if (seen.has(key)) return;
    seen.add(key);
    const paths = new Set(contentPaths(message.content, path));
    const evidence = evidenceSources(raw.messages[messageIndex]).filter(source => source.kind === "text" &&
      source.text.length && paths.has(source.path))
      .map(source => cite(inputId, messageIndex, source, 0, source.text.length));
    result.push({ message_index: messageIndex, path, role, content: structuredClone(message.content), evidence });
  };
  raw.messages.slice(0, finalIndex).forEach((message, index) => {
    add(index, "/content", message);
    if (!answerTurns.has(index)) return;
    const context = contextOf(object(message)!);
    context!.messages.forEach((nested, nestedIndex) => add(index, `${context!.path}/${nestedIndex}/content`, nested));
  });
  return [...result, ...loadedSkillSources(raw, inputId, finalIndex, answerTurns)]
    .sort((a, b) => a.message_index - b.message_index);
}

/** Explicit instructions include matched skill loads, never arbitrary tool facts. */
export function instructionSources(raw: { messages: unknown[] }, inputId: string, finalMessageIndex?: number): InstructionSource[] {
  return normativeSources(raw, inputId, finalMessageIndex).filter((source): source is InstructionSource => source.role !== "user");
}
