import { answerTurnContexts, cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}

/** Only typed content text belongs to the generated answer; other output fields are not prose. */
function textPaths(content: unknown, path: string): string[] | null {
  if (typeof content === "string") return content.length ? [path] : null;
  if (!Array.isArray(content) || !content.length) return null;
  const paths: string[] = [];
  for (const [index, value] of content.entries()) {
    const block = object(value);
    if (!block || typeof block.type !== "string" || !["text", "output_text"].includes(block.type) || typeof block.text !== "string") return null;
    if (block.text.length) paths.push(`${path}/${index}/text`);
  }
  return paths.length ? paths : null;
}

export interface AnswerGeneration {
  available: true;
  message_type: "llm_turn";
  message_index: number;
  captured_final_message_index: number;
  matches_captured_final: boolean | null;
  input_contexts: {
    message_index: number;
    path: string;
    total_chars: number;
    read_request: { message_index: number; path: string; offset: 0; max_chars: 16000 };
  }[];
  blocks: {
    path: string;
    total_chars: number;
    text: string;
    reference: { evidence_id: string };
    read_request: { message_index: number; path: string; offset: 0; max_chars: 16000 };
  }[];
  reasoning_blocks?: AnswerGeneration['blocks'];
}

/** Keep original model generation distinct from the collected final, without inferring UI state or cause. */
export function getAnswerGeneration(raw: RawInput, inputId: string, finalIndex?: number): AnswerGeneration | null {
  const capturedIndex = finalIndex ?? raw.messages.findLastIndex(message => message.type === "final_answer");
  if (!Number.isInteger(capturedIndex) || capturedIndex < 0 || capturedIndex >= raw.messages.length ||
    raw.messages[capturedIndex]!.type !== "final_answer") return null;
  const contexts = answerTurnContexts(raw, capturedIndex);
  const messageIndex = contexts.at(-1)?.message_index;
  if (messageIndex === undefined) return null;
  if (raw.messages.slice(messageIndex + 1, capturedIndex).some(message => message.role === "user" || message.type === "user_question")) return null;
  const message = raw.messages[messageIndex]!, output = message.output;
  if (!Array.isArray(output) || output.length !== 1) return null;
  const item = object(output[0]);
  if (!item || item.role !== "assistant" || item.function_call ||
    (item.tool_calls != null && (!Array.isArray(item.tool_calls) || item.tool_calls.length))) return null;
  const paths = textPaths(item.content, "/output/0/content");
  if (!paths) return null;
  const sources = evidenceSources(message), blocks = paths.map(path => {
    const source = sources.find(value => value.kind === "text" && value.path === path);
    if (!source) return null;
    const evidence = cite(inputId, messageIndex, source, 0, source.text.length);
    return { path, total_chars: source.text.length, text: source.text, reference: { evidence_id: evidence.evidence_id },
      read_request: { message_index: messageIndex, path, offset: 0 as const, max_chars: 16000 as const } };
  });
  if (blocks.some(block => !block) || !blocks.some(block => block!.text.length)) return null;
  const knownBlocks = blocks as AnswerGeneration["blocks"];
  const reasoning = sources.filter(source=>source.kind==='text'&&!source.path.startsWith('/input')&&
    /(?:^|\/)(?:reasoning(?:_content)?|analysis|thinking)(?:\/|$)/iu.test(source.path)&&source.text.trim()).map(source=>{
    const characters=Array.from(source.text),text=characters.slice(0,2400).join(''),evidence=cite(inputId,messageIndex,source,0,Math.min(2400,characters.length));
    return {path:source.path,total_chars:characters.length,text,reference:{evidence_id:evidence.evidence_id},
      read_request:{message_index:messageIndex,path:source.path,offset:0 as const,max_chars:16000 as const}};
  });
  const captured = raw.messages[capturedIndex]!, finalPaths = textPaths(captured.content, "/content");
  const finalSources = evidenceSources(captured);
  const finalBlocks = finalPaths?.map(path => finalSources.find(source => source.kind === "text" && source.path === path)?.text);
  const matches = finalBlocks && finalBlocks.every(text => typeof text === "string")
    ? finalBlocks.length === knownBlocks.length && finalBlocks.every((text, index) => text === knownBlocks[index]!.text) : null;
  return { available: true, message_type: "llm_turn", message_index: messageIndex,
    captured_final_message_index: capturedIndex, matches_captured_final: matches, blocks: knownBlocks,
    ...(reasoning.length?{reasoning_blocks:reasoning}:{}),
    input_contexts: contexts.map(context => {
      const range = selectEvidenceSource(evidenceSources(raw.messages[context.message_index]), context.path)!;
      return { ...context, total_chars: range.end - range.start,
        read_request: { ...context, offset: 0, max_chars: 16000 } };
    }) };
}

/** Strictly equal text is already shown as the captured final; every block remains independently readable. */
export function answerGenerationPresentation(generation: AnswerGeneration | null, candidate: string) {
  if (!generation) return null;
  return { ...generation, input_contexts: generation.input_contexts.map(({ read_request: _read, ...context }) => ({ ...context,
    search_scope: { candidate, message_index: context.message_index, path: context.path },
  })), blocks: generation.blocks.map(({ text, read_request, ...block }) => ({ ...block,
    ...(generation.matches_captured_final === true ? {} : { text, read_request: { ...read_request, candidate } }),
  })) };
}
