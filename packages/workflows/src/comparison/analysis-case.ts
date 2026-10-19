import type { AnalysisReference } from "@eval/contracts";
import { isToolSpan } from "./adapters.js";
import { traceCatalog } from "./catalog.js";
import { locateAnalysisInput } from "./dashboard-view.js";
import { contentText, locateRecordStream } from "./input.js";
import type { RawInput } from "./types.js";

/** A navigation map, not a second copy of each model request's input history. */
export function analysisTraceMap(raw: RawInput, reference: AnalysisReference, finalIndex: number, audience: "model" | "user" = "model") {
  const previewChars = audience === "user" ? 2000 : 160;
  const catalog = traceCatalog(raw);
  // Some source spans omit call IDs but record the same completion time on both ends.
  // Require a unique pair across the entire trace; adjacency and timestamps alone are insufficient.
  const spans = new Map<string, { calls: number[]; results: number[] }>();
  const spanKey = (message: RawInput["messages"][number]) =>
    message.name && typeof message.end === "string" && message.end
      ? JSON.stringify([message.name, message.end]) : undefined;
  const withoutId = (message: RawInput["messages"][number]) => !message.call_id && !message.tool_call_id && !message.id;
  for (const entry of catalog) {
    const key = spanKey(raw.messages[entry.message_index]);
    if (!key) continue;
    const span = spans.get(key) ?? { calls: [], results: [] };
    if (["function_call", "tool_call"].includes(entry.type)) span.calls.push(entry.message_index);
    else if (["function_call_output", "tool_result"].includes(entry.type) || entry.role === "tool") span.results.push(entry.message_index);
    spans.set(key, span);
  }
  const nodes = catalog.map((entry) => {
    const message = raw.messages[entry.message_index];
    const call = ["function_call", "tool_call"].includes(entry.type);
    const result = isToolSpan(message) || ["function_call_output", "tool_result"].includes(entry.type) || entry.role === "tool";
    const span = spans.get(spanKey(message) ?? "");
    const callIndex = entry.call_message_index ?? (result && withoutId(message) && span?.calls.length === 1 && span.results.length === 1 &&
      span.calls[0] < entry.message_index && withoutId(raw.messages[span.calls[0]]) ? span.calls[0] : undefined);
    const body = audience === "user" ? contentText(message.content) : "";
    const summary = audience === "user" && entry.type === "reasoning" && !body.trim() ? contentText(message.summary) : "";
    const value = call ? message.arguments ?? message.input : result ? message.output ?? message.content
      : audience !== "user" ? undefined : entry.type === "llm_turn" ? message.output
      : summary || body;
    let text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    if (call && audience === "model" && value && typeof value === "object" && "description" in value && typeof value.description === "string" && value.description.trim())
      text = value.description + "\n" + text;
    const limit = entry.type === "reasoning" && audience === "user" ? text.length : previewChars;
    return {
      messageIndex: entry.message_index, type: entry.type, ...(entry.role ? { role: entry.role } : {}),
      ...(entry.name ? { name: entry.name } : {}), chars: entry.chars,
      ...(callIndex !== undefined ? { callMessageIndex: callIndex } : {}),
      ...(text ? { preview: text.slice(0, limit), previewTruncated: text.length > limit } : {}),
      ...(summary ? { previewKind: "summary" as const } : {}),
      reference: { ...reference, messageIndex: entry.message_index },
    };
  });
  return { messageCount: nodes.length, finalMessageIndex: finalIndex,
    toolCalls: nodes.filter(node => ["function_call", "tool_call"].includes(node.type)).length, nodes };
}

/** Resolve the current source record once, including its current final-answer coordinate. */
export async function readAnalysisAnswer(run: string, inputId: string, runId: string, audience?: "user") {
  const { candidate, config } = await locateAnalysisInput(run, inputId);
  const version = config.inputs.versions.find(entry => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  const { raw, record } = await locateRecordStream(candidate.source, candidate, version, config.inputs.default_batch_id);
  const reference = { runId, inputId };
  const text = contentText(raw.messages[record.final_index]?.content);
  return { reference, model: candidate.version, modelName: version.display_name ?? version.name,
    comparisonTier: version.comparison_tier ?? null, question: record.question,
    answer: { reference: { ...reference, messageIndex: record.final_index }, chars: text.length,
      complete: text.length <= 16000, ...(text.length <= 16000 ? { text } : { preview: text.slice(0, 400) }) },
    trace: analysisTraceMap(raw, reference, record.final_index, audience) };
}
