import { fileSourceReader } from "@eval/data";
import type { JsonObject } from "@eval/contracts";
import type { Candidate } from "@eval/workflows/inputs";
import type { RubricCategory } from "@eval/agents/rubric";

export interface AttributionLocation {
  path: string;
  revision: string;
  byteOffset: number;
  byteLength: number;
}

/** Retain source coordinates, not another copy of accepted attribution bodies. */
export async function attributionIndex(path: string): Promise<Map<string, AttributionLocation>> {
  const revision = await fileSourceReader.revision(path), index = new Map<string, AttributionLocation>();
  for await (const line of fileSourceReader.lines(path, revision)) {
    if (!line.line.trim()) continue;
    const row = JSON.parse(line.line) as JsonObject, meta = row.session_meta as JsonObject | undefined;
    const id = meta?.session_id;
    if (typeof id !== "string" || !id || !Array.isArray(row.turns)) throw new Error(`归因第 ${line.index} 行缺少会话身份或 turns`);
    if (index.has(id)) throw new Error(`归因重复会话：${id}`);
    index.set(id, {path, revision, byteOffset: line.byteOffset, byteLength: line.byteLength});
  }
  return index;
}

export function attributionMaterial(location: AttributionLocation, candidate: Candidate, traceIndex: number, category: RubricCategory): JsonObject {
  const row = JSON.parse(fileSourceReader.record(location.path, location.byteOffset, location.byteLength, location.revision)) as JsonObject;
  const traceId = candidate.turns?.find(turn => turn.trace_index === traceIndex)?.trace_id ?? candidate.trace_id;
  const turns = row.turns as JsonObject[];
  const matching = turns.filter(turn => (turn.meta as JsonObject)?.trace_id === traceId);
  if (!traceId || matching.length !== 1) throw new Error(`归因 trace 缺失或重复：${candidate.case_id}#${traceIndex}`);
  const turn = matching[0]!, meta = turn.meta as JsonObject;
  if (![category.l1, category.l1_name].includes(String(meta.task)) || ![category.id, category.name].includes(String(meta.subtask)))
    throw new Error(`归因 L1/L2 与输入不一致：${candidate.case_id}#${traceIndex}`);
  return {turn, session_summary: row.session_summary, session_problem: row.session_problem};
}
