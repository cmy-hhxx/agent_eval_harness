import { answerTurnContexts, evidenceCovers, evidenceId, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource } from "@eval/tools";
import type { ComparisonInput } from "./types.js";

type Leaf = { path: string; text: string };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function proseLeaves(content: unknown, path: string): Leaf[] | undefined {
  if (typeof content === "string") return [{ path, text: content }];
  const blocks = Array.isArray(content) ? content : [content];
  if (!blocks.length || !blocks.every(block => {
    const value = object(block);
    return value && ["text", "output_text"].includes(String(value.type)) && typeof value.text === "string";
  })) return undefined;
  return blocks.map((block, index) => ({ path: Array.isArray(content) ? `${path}/${index}/text` : `${path}/text`,
    text: object(block)!.text as string }));
}
function finalLeaves(raw: { messages: unknown[] }, material: ComparisonInput["candidates"][string], complete = true) {
  const final = object(raw.messages[material.final_message_index]);
  if (final?.role !== "assistant") return undefined;
  if (complete || !Array.isArray(final.content)) return proseLeaves(final.content, "/content");
  // Physical text can be checked beside other final material; mixed material cannot establish an alias.
  return final.content.flatMap((block, index) => proseLeaves(block, `/content/${index}`) ?? []);
}
function generationLeaves(raw: { messages: unknown[] }, material: ComparisonInput["candidates"][string]) {
  const generation = material.answer_generation;
  if (!generation?.available || generation.captured_final_message_index !== material.final_message_index ||
    generation.message_index !== answerTurnContexts(raw, material.final_message_index).at(-1)?.message_index) return undefined;
  if (raw.messages.slice(generation.message_index + 1, material.final_message_index).some(message =>
    object(message)?.role === "user" || object(message)?.type === "user_question")) return undefined;
  const turn = object(raw.messages[generation.message_index]);
  if (turn?.type !== "llm_turn" || !Array.isArray(turn.output) || turn.output.length !== 1) return undefined;
  const assistant = object(turn.output[0]);
  if (assistant?.role !== "assistant" || assistant.function_call ||
    (assistant.tool_calls != null && (!Array.isArray(assistant.tool_calls) || assistant.tool_calls.length)) ||
    !(typeof assistant.content === "string" || Array.isArray(assistant.content))) return undefined;
  const leaves = proseLeaves(assistant.content, "/output/0/content");
  if (!leaves || leaves.some(leaf => leaf.text && !generation.blocks.some(block =>
    block.path === leaf.path && block.total_chars === leaf.text.length))) return undefined;
  return leaves;
}
function isAnswerCoordinate(raw: { messages: unknown[] }, inputId: string, id: string, leaves: Leaf[], index: number): boolean {
  const coordinate = parseEvidenceCoordinates(id);
  if (!coordinate || coordinate.kind === "image" || coordinate.input_id !== inputId || coordinate.message_index !== index ||
    !evidenceCovers(raw, inputId, id, id)) return false;
  if (coordinate.kind === "text") return leaves.some(leaf => leaf.path === coordinate.path);
  const json = evidenceSources(raw.messages[index]).filter(source => source.kind === "json");
  return leaves.some(leaf => {
    const selected = selectEvidenceSource(json, leaf.path);
    return selected && (coordinate.start >= selected.start && coordinate.end <= selected.end ||
      evidenceCovers(raw, inputId, id, evidenceId(inputId, index, "text", leaf.path, 0, leaf.text.length)));
  });
}
function physicalTextRanges(raw: { messages: unknown[] }, inputId: string, id: string, leaves: Leaf[], index: number) {
  const coordinate = parseEvidenceCoordinates(id);
  if (!coordinate || coordinate.kind === "image" || !isAnswerCoordinate(raw, inputId, id, leaves, index)) return [];
  return leaves.flatMap((leaf, position) => {
    if (coordinate.kind === "text") return coordinate.path === leaf.path ? [{ position, start: coordinate.start, end: coordinate.end }] : [];
    return evidenceCovers(raw, inputId, id, evidenceId(inputId, index, "text", leaf.path, 0, leaf.text.length))
      ? [{ position, start: 0, end: leaf.text.length }] : [];
  });
}

/** This helper is only a mechanical proof test; matching behavior and responsibility remain independent judgments. */
export function actualAnswerEvidenceShares(raw: { messages: unknown[] }, inputId: string,
  material: ComparisonInput["candidates"][string], leftId: string, rightId: string): boolean {
  if (material.candidate_id !== inputId) return false;
  const captured = finalLeaves(raw, material), generated = generationLeaves(raw, material), generation = material.answer_generation;
  const sides = [{ leaves: finalLeaves(raw, material, false), index: material.final_message_index },
    { leaves: generated, index: generation?.message_index }];
  if (sides.some(side => side.leaves && side.index !== undefined &&
    isAnswerCoordinate(raw, inputId, leftId, side.leaves, side.index) &&
    isAnswerCoordinate(raw, inputId, rightId, side.leaves, side.index)) &&
    (evidenceCovers(raw, inputId, leftId, rightId) || evidenceCovers(raw, inputId, rightId, leftId))) return true;
  if (!captured || !generated || !generation || generation.matches_captured_final !== true ||
    object(raw.messages[material.final_message_index])?.type !== "final_answer" || captured.length !== generated.length ||
    captured.some((leaf, position) => leaf.text !== generated[position]!.text)) return false;
  const left = parseEvidenceCoordinates(leftId), right = parseEvidenceCoordinates(rightId);
  if (!left || !right || left.message_index === right.message_index) return false;
  const leftSide = sides.find(side => side.index === left.message_index), rightSide = sides.find(side => side.index === right.message_index);
  if (!leftSide?.leaves || !rightSide?.leaves || leftSide.index === undefined || rightSide.index === undefined) return false;
  const leftRanges = physicalTextRanges(raw, inputId, leftId, leftSide.leaves, leftSide.index),
    rightRanges = physicalTextRanges(raw, inputId, rightId, rightSide.leaves, rightSide.index);
  return leftRanges.some(a => rightRanges.some(b => a.position === b.position &&
    (a.start <= b.start && a.end >= b.end || b.start <= a.start && b.end >= a.end)));
}
