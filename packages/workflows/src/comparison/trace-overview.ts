import { cite, displayEvidence, evidenceSources } from "@eval/tools";
import type { RawInput } from "./types.js";
import { traceCatalog } from "./catalog.js";

/** Bounded navigation excerpts, not a judgment of tool success or factual correctness. */
export function traceOverview(raw: RawInput, candidate: string, inputId: string, maxChars = 8000) {
  const catalog = traceCatalog(raw);
  const entries = raw.messages.flatMap((message, message_index) => {
    const returned = message.role === "tool" || ["function_call_output", "tool_result"].includes(message.type ?? "");
    const called = ["function_call", "tool_call"].includes(message.type ?? "");
    if (!returned && !called) return [];
    const fields = returned ? ["output", "content", "error", "errors", "status", "isError", "success"] : ["arguments", "input", "parameters"];
    // Do not scan repeated input_messages, model configuration or tool definitions.
    const payload = Object.fromEntries(fields.filter(key => Object.hasOwn(message, key)).map(key => [key, message[key]]));
    const sources = evidenceSources(payload).filter(source => source.kind === "text" && source.text.length);
    const signals: { path: string; value: unknown }[] = [];
    const scanFlags = (value: unknown, path: string) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const location = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if ((key === "isError" || key === "is_error") && child === true || key === "success" && child === false)
          signals.push({ path: location, value: child });
        if (key !== "input_messages") scanFlags(child, location);
      }
    };
    if (returned) scanFlags(payload, "");
    const anomalies = returned ? sources.flatMap(source => {
      const matches = [...source.text.matchAll(/\b(?:\w*Error|\w*Exception|Traceback|error|failed|failure|timeout)\b|报错|异常|失败|错误|超时/giu)];
      const diagnostic = [...source.text.matchAll(/\b\w*(?:Error|Exception)\s*:|Traceback \(most recent call last\)|^\s*(?:error|failed|failure|timeout|报错|错误|失败|超时)\s*[:：]/gimu)].at(-1);
      const match = diagnostic ?? matches.at(-1);
      return match ? [{ source, offset: Math.max(0, match.index! - 80), anomaly: true, diagnostic: !!diagnostic }] : [];
    }) : [];
    const diagnostics = anomalies.filter(item => item.diagnostic);
    const navigable = sources.filter(source => !/\/(?:type|id|uid|uuid|ref|url|mimeType|mime_type|serial_number)$/u.test(source.path) &&
      source.text.replace(/<\/?[\w-]+[^>]*>/gu, "").replace(/^\s*(?:ID|ref)\s*:\s*\S+\s*$/gimu, "").trim());
    const previews = navigable
      .filter(source => !diagnostics.some(item => item.source === source)).slice(0, 2)
      .map(source => ({ source, offset: 0, anomaly: false, diagnostic: false }));
    const hints = [...diagnostics, ...previews,
      ...anomalies.filter(item => !item.diagnostic && !previews.some(preview => preview.source === item.source))];
    const highlights = hints.slice(0, 4).map(({ source, offset, anomaly, diagnostic }) => {
      const end = Math.min(source.text.length, offset + (anomaly ? 300 : 180));
      const has_more = offset > 0 || end < source.text.length;
      return { path: source.path, total_chars: source.text.length, offset, end_offset: end, has_more, anomaly, diagnostic,
        ...displayEvidence(cite(inputId, message_index, source, offset, end)),
        ...(has_more ? { read_request: { candidate, message_index, path: source.path, offset: Math.max(0, offset - 200), max_chars: 1800 } } : {}) };
    });
    const link = catalog[message_index]!;
    return [{ message_index, kind: returned ? "return" : "call", name: link.name,
      ...(link.call_message_index !== undefined ? { call_message_index: link.call_message_index } : {}), text_fields: sources.length,
      anomaly_fields: anomalies.length + signals.length, diagnostic_fields: diagnostics.length + signals.length,
      signals: signals.slice(0, 4), highlights,
      omitted_highlights: Math.max(0, new Set([...navigable, ...anomalies.map(item => item.source)]).size - highlights.length) + Math.max(0, signals.length - 4) }];
  });
  const selected: typeof entries = [];
  const result = () => ({ entries: selected, total_entries: entries.length, omitted_entries: entries.length - selected.length,
    anomaly_fields: entries.reduce((total, entry) => total + entry.anomaly_fields, 0) });
  // Reserve space for excerpts: a noisy early return must not displace the later call directory.
  const priority = (a: typeof entries[number], b: typeof entries[number]) =>
    Number(b.diagnostic_fields > 0) - Number(a.diagnostic_fields > 0) || a.message_index - b.message_index;
  for (const entry of [...entries].sort(priority)) {
    selected.push({ ...entry, highlights: [], omitted_highlights: entry.omitted_highlights + entry.highlights.length });
    if (JSON.stringify(result()).length > maxChars / 2) selected.pop();
  }
  // First show one excerpt per return, before code prefixes or second excerpts of a long return.
  const ordered = [...selected].sort((a, b) => Number(b.diagnostic_fields > 0) - Number(a.diagnostic_fields > 0) ||
    Number(b.kind === "return") - Number(a.kind === "return") || a.message_index - b.message_index);
  const add = (entry: typeof entries[number], round: number) => {
    const highlight = entries.find(item => item.message_index === entry.message_index)!.highlights[round];
    if (!highlight) return;
    entry.highlights.push(highlight); entry.omitted_highlights--;
    if (JSON.stringify(result()).length > maxChars) { entry.highlights.pop(); entry.omitted_highlights++; }
  };
  // Cover returns first, then complete short results using the same envelope.
  // Full code prefixes are navigation, not conclusions; they get remaining space.
  for (const entry of ordered.filter(item => item.kind === "return")) add(entry, 0);
  for (const entry of ordered.filter(item => item.kind === "return").reverse()) {
    const highlight = entry.highlights[0];
    if (!highlight?.has_more || highlight.total_chars > 1200) continue;
    const source = evidenceSources(raw.messages[entry.message_index]).find(item => item.kind === "text" && item.path === highlight.path)!;
    const complete = { ...highlight, ...displayEvidence(cite(inputId, entry.message_index, source, 0, source.text.length)),
      offset: 0, end_offset: source.text.length, has_more: false };
    delete complete.read_request;
    entry.highlights[0] = complete;
    if (JSON.stringify(result()).length > maxChars) entry.highlights[0] = highlight;
  }
  for (let round = 0; round < 4; round++) for (const entry of ordered)
    if (round > 0 || entry.kind === "call") add(entry, round);
  selected.sort((a, b) => a.message_index - b.message_index);
  return result();
}
