import type { JsonObject } from "@eval/contracts";
import type { Finding, RawInput } from "./types.js";
import { strings } from "./input.js";

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
function traceRefs(text: string): string[] {
  return [...text.matchAll(/<trace\b[^>]*(?:anchor|ref)\s*=\s*["']([^"']+)/gi)].map((m) => m[1]);
}
export function annotateFindings(raw: RawInput, findings: Finding[]): JsonObject[] {
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
  const citations = new Map<string, Set<number>>(),
    anchors = new Map<string, Set<number>>();
  const add = (map: Map<string, Set<number>>, key: string, index: number) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(index);
  };
  for (const [index] of direct) {
    const message = messages[index];
    if (
      !(lastUser < index && index < final) ||
      !["function_call_output", "tool_result"].includes(message.type || "")
    )
      continue;
    for (const [location, text] of strings(message.output ?? message.content ?? "")) {
      for (const match of text.matchAll(/<referencable-result>\s*ID:\s*(\d+)/gi))
        add(citations, match[1], index);
      const refs = [
        ...traceRefs(text),
        ...[
          ...text.matchAll(
            /\b(?:serial_number|trace_id|anchor|ref|uid|id)\\?["']?\s*:\s*\\?["']([^"'\\]+)/gi,
          ),
        ].map((m) => m[1]),
      ];
      if (
        ["serial_number", "trace_id", "anchor", "ref", "uid", "id"].includes(location.split("/").at(-1) || "")
      )
        refs.push(text);
      for (const ref of refs) add(anchors, ref, index);
    }
  }
  return findings.map((finding) => {
    const evidence = new Set<number>(),
      cited = new Set<number>(),
      refs = new Set<string>(),
      traces = new Set<string>();
    for (const item of finding.evidence) {
      evidence.add(item.message_index);
      if (direct.has(item.message_index)) cited.add(item.message_index);
      for (const match of item.quote.matchAll(/\[\^(\d+)\]/g)) refs.add(match[1]);
      traceRefs(item.quote).forEach((ref) => traces.add(ref));
    }
    const resolved = [
      ...[...refs].map((ref) => citations.get(ref) || new Set<number>()),
      ...[...traces].map((ref) => anchors.get(ref) || new Set<number>()),
    ];
    const sources = new Set(cited);
    let ambiguous = false;
    for (const indices of resolved) {
      if (new Set([...indices].map((i) => direct.get(i))).size === 1) indices.forEach((i) => sources.add(i));
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
