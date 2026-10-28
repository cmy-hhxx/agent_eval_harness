import { analysisTraceMap } from "../review/analysis.js";
import { locateAnalysisInput } from "./analysis-input.js";
import { contentText, locateRecordStream } from "../inputs/records.js";

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
