import { analysisTraceMap } from "../review/analysis.js";
import { locateAnalysisInput } from "./analysis-input.js";
import { contentText, locateRecordStream } from "../inputs/records.js";
import { sessionSource } from "../inputs/session.js";

/** Resolve the current source record once, including its current final-answer coordinate. */
export async function readAnalysisAnswer(run: string, inputId: string, runId: string, audience?: "user") {
  const { candidate, config } = await locateAnalysisInput(run, inputId);
  const version = config.inputs.versions.find(entry => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  const { raw, record } = await locateRecordStream(candidate.source, candidate, version, config.inputs.default_batch_id);
  const reference = { runId, inputId };
  const source = sessionSource(raw), last = record.turns?.at(-1);
  const finalIndex = source.positions.findIndex(point => point.trace_index === (last?.trace_index ?? 0) &&
    point.message_index === (last?.final_index ?? record.final_index));
  const text = contentText(source.raw.messages[finalIndex]?.content);
  return { reference, model: candidate.version, modelName: version.display_name ?? version.name,
    comparisonTier: version.comparison_tier ?? null, question: record.question,
    answer: { reference: { ...reference, messageIndex: finalIndex }, chars: text.length,
      complete: text.length <= 16000, ...(text.length <= 16000 ? { text } : { preview: text.slice(0, 400) }) },
    trace: analysisTraceMap(raw, reference, finalIndex, audience) };
}
