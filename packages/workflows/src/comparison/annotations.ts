import type { JsonObject } from "@eval/contracts";
import { citationMarkers, type CitationMarker } from "@eval/tools";
import type { Finding, RawInput } from "./types.js";
import { citationInventory } from "./citations.js";

const aliases: Record<string, string> = {
  search: "Search",
  web_search: "Search",
  finquery: "FinQuery",
  finquery_market_data: "FinQueryMarketData",
  web_fetch: "WebFetch",
  accessingfulltext: "AccessingFullText",
  codeinterpreter: "CodeInterpreter",
  backtest: "Backtest",
  tickerchart: "TickerChart",
};
const toolName = (value: unknown): string | undefined =>
  typeof value === "string" && value ? aliases[value.toLowerCase().replaceAll("-", "_")] || value : undefined;
const citationKey = (marker: Pick<CitationMarker, "format" | "reference" | "attribute">) =>
  marker.format === "trace" ? `trace:${marker.attribute}:${marker.reference}` : `${marker.format}:${marker.reference}`;
function annotateLocalFindings(raw: RawInput, inputId: string, findings: Finding[]): JsonObject[] {
  const messages = raw.messages,
    calls = new Map<string, string>(),
    direct = new Map<number, string>();
  for (const m of messages)
    if (["function_call", "tool_call"].includes(m.type || "")) {
      const name = toolName(m.name);
      if (name) for (const key of ["call_id", "id"]) if (m[key]) calls.set(String(m[key]), name);
    }
  messages.forEach((m, i) => {
    const name =
      m.type === "function_call_output"
        ? calls.get(String(m.call_id))
        : ["function_call", "tool_call", "tool_result"].includes(m.type || "")
          ? toolName(m.name)
          : undefined;
    if (name) direct.set(i, name);
  });
  const lastUser = messages.findLastIndex((m) => m.type === "user_question" || m.role === "user");
  const final = messages.findLastIndex(
    (m) => m.type === "final_answer" || (m.type === "message" && m.role === "assistant"),
  );
  const candidates = [
    ...new Set([...direct].filter(([i]) => lastUser < i && i < final).map(([, name]) => name)),
  ].sort();
  const directory = new Map(citationInventory(raw, inputId, final).references.map(reference =>
    [citationKey({ ...reference, attribute: citationMarkers(reference.occurrences[0].quote)[0]?.attribute }), reference]));
  return findings.map((finding) => {
    const evidence = new Set<number>(),
      cited = new Set<number>(),
      refs = new Set<string>();
    for (const item of finding.evidence) {
      evidence.add(item.message_index);
      if (direct.has(item.message_index)) cited.add(item.message_index);
      for (const marker of citationMarkers(item.quote)) refs.add(citationKey(marker));
    }
    const sources = new Set(cited);
    let ambiguous = false;
    for (const key of refs) {
      const reference = directory.get(key);
      const indices = reference?.sources.filter(source => source.origin === "tool_return" &&
        lastUser < source.message_index && source.message_index < final).map(source => source.message_index) ?? [];
      if (reference?.status === "resolved" && indices.length && indices.every(index => direct.has(index)) &&
        new Set(indices.map(index => direct.get(index))).size === 1) indices.forEach(index => sources.add(index));
      else ambiguous = true;
    }
    const tools = [...new Set([...sources].map((i) => direct.get(i)!))].sort();
    const confidence =
      tools.length && !ambiguous ? "high" : tools.length || candidates.length ? "medium" : "none";
    return {
      tools,
      confidence,
      source: cited.size
        ? "evidence_message"
        : tools.length
          ? "quote_reference"
          : candidates.length
            ? "same_turn_tool_chain"
            : "none",
      locations: [...(sources.size ? sources : evidence)]
        .sort((a, b) => a - b)
        .map((i) => ({ message_index: i, tool_name: direct.get(i) || null })),
      ...(confidence !== "high" && candidates.length ? { candidate_tools: candidates } : {}),
    };
  });
}

/** Foreign grader evidence keeps its physical input identity throughout trace annotation. */
export function annotateFindings(raw: RawInput, inputId: string, findings: Finding[], inputs: Record<string, unknown> = {}): JsonObject[] {
  return findings.map(finding => {
    const own = finding.evidence.filter(item => !item.source_input_id);
    const foreign = new Map<string, Finding["evidence"]>();
    for (const item of finding.evidence) if (item.source_input_id) {
      const entries = foreign.get(item.source_input_id) ?? [];
      entries.push(item); foreign.set(item.source_input_id, entries);
    }
    if (!foreign.size) return annotateLocalFindings(raw, inputId, [finding])[0];
    const portions = [...(own.length ? [{ annotation: annotateLocalFindings(raw, inputId, [{ ...finding, evidence: own }])[0], inputId: undefined }] : []),
      ...[...foreign].map(([inputId, evidence]) => {
        const peer = inputs[inputId] as RawInput | undefined;
        if (!peer) throw new Error("归因证据来源输入不可定位：" + inputId);
        return { annotation: annotateLocalFindings(peer, inputId, [{ ...finding, evidence }])[0], inputId };
      })];
    const tools = [...new Set(portions.flatMap(({ annotation }) => annotation.tools as string[]))].sort();
    const confidence = portions.every(({ annotation }) => annotation.confidence === "high") ? "high"
      : portions.some(({ annotation }) => annotation.confidence !== "none") ? "medium" : "none";
    return { tools, confidence,
      source: portions.some(({ annotation }) => annotation.source === "evidence_message") ? "evidence_message"
        : tools.length ? "quote_reference" : "none",
      locations: portions.flatMap(({ annotation, inputId }) => (annotation.locations as JsonObject[])
        .map(location => ({ ...location, ...(inputId ? { source_input_id: inputId } : {}) }))),
      ...(confidence !== "high" ? { candidate_tools: [...new Set(portions.flatMap(({ annotation }) => annotation.candidate_tools as string[] ?? []))].sort() } : {}),
    };
  });
}
