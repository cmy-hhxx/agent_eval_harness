import { cite, displayEvidence, evidenceSources, jsonRanges, messageContentSources, selectEvidenceSource, traceExchanges } from "@eval/tools";
import { evidenceOrigin, overlapsImagePlaceholder, type JsonObject } from "@eval/contracts";
import { contentText } from "@eval/workflows/inputs";
import type { RawInput } from "../inputs/types.js";

type Source = ReturnType<typeof evidenceSources>[number];
type Entry = { message_index: number; source: Source; start: number; end: number; path: string; payloadField?: boolean; ranges?: { start: number; end: number }[] };
const cached = new WeakMap<RawInput, { original: RawInput; entries: Entry[] }>();
const segmenter = new Intl.Segmenter("zh", { granularity: "sentence" });

/** Whole paragraphs, lines or sentences; a budget never manufactures a short prefix/suffix. */
export function compactTextRanges(text: string, start = 0, end = text.length): { start: number; end: number }[] {
  if (end - start <= 400) return end > start && !overlapsImagePlaceholder(text, start, end) ? [{ start, end }] : [];
  // Minified tables have no sentence boundaries. Keep complete rows/properties at
  // their original offsets, including field names, rather than dropping the data.
  try {
    const ranges = [...jsonRanges(text).values()].filter(range => range.start >= start && range.end <= end && range.end - range.start <= 400 &&
      !overlapsImagePlaceholder(text, range.start, range.end))
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const result: { start: number; end: number }[] = [];
    for (const range of ranges) {
      const last = result.at(-1);
      if (last && range.start < last.end) continue;
      if (last && range.end - last.start <= 400 && !overlapsImagePlaceholder(text, last.start, range.end)) last.end = range.end;
      else result.push({ start: range.start, end: range.end });
    }
    if (result.length) return result;
  } catch { /* Prose and code retain their original paragraph/line boundaries. */ }
  const units: { start: number; end: number }[] = [];
  let cursor = start;
  const add = (from: number, to: number) => {
    if (!text.slice(from, to).trim()) return;
    if (to - from <= 400) { units.push({ start: from, end: to }); return; }
    for (const line of text.slice(from, to).matchAll(/[^\n]+(?:\n|$)/gu)) {
      const offset = from + line.index;
      if (line[0].length <= 400) units.push({ start: offset, end: offset + line[0].length });
      else for (const sentence of segmenter.segment(line[0])) if (sentence.segment.length <= 400 && sentence.segment.trim())
        units.push({ start: offset + sentence.index, end: offset + sentence.index + sentence.segment.length });
    }
  };
  for (const separator of text.slice(start, end).matchAll(/\n[\t ]*\n+/gu)) {
    add(cursor, start + separator.index); cursor = start + separator.index + separator[0].length;
  }
  add(cursor, end);
  const result: typeof units = [];
  for (const unit of units) {
    if (overlapsImagePlaceholder(text, unit.start, unit.end)) continue;
    const last = result.at(-1);
    if (last && unit.end - last.start <= 400 && !overlapsImagePlaceholder(text, last.start, unit.end)) last.end = unit.end;
    else result.push({ ...unit });
  }
  return result;
}

function sources(raw: RawInput, original: RawInput, positions: { trace_index: number }[]): Entry[] {
  const previous = cached.get(raw);
  if (previous?.original === original) return previous.entries;
  const questions = new Map<number, string>();
  raw.messages.forEach((message, index) => {
    const trace = positions[index]!.trace_index;
    if (!questions.has(trace) && (message.role === "user" || message.type === "user_question")) questions.set(trace, contentText(message.content));
  });
  const observations = new Map<number, Set<string>>();
  for (const [index, message] of raw.messages.entries()) if (message.role === "tool" || ["tool_result", "function_call_output"].includes(String(message.type))) {
    const seen = observations.get(positions[index]!.trace_index) ?? new Set<string>();
    evidenceSources(message).filter(source => source.kind === "text").forEach(source => seen.add(source.text));
    observations.set(positions[index]!.trace_index, seen);
  }
  const entries = raw.messages.flatMap((message, message_index) => {
    const publicSources = evidenceSources(message), originalSources = evidenceSources(original.messages[message_index]);
    const originalText = new Map(originalSources.filter(source => source.kind === "text").map(source => [source.path, source.text]));
    const result: Entry[] = publicSources.filter(source => source.kind === "text" && source.quotable !== false && source.text.trim() &&
      /^\/(?:content|input|output|result|arguments|parameters|reasoning_content|reasoning|thinking|analysis|error)(?:\/|$)/u.test(source.path) &&
      originalText.get(source.path) === source.text)
      .map(source => ({ message_index, source, start: 0, end: source.text.length, path: source.path }));
    // Tool observations in model inputs remain execution evidence, without treating the snapshot as a fresh invocation.
    const seen = observations.get(positions[message_index]!.trace_index) ?? new Set<string>();
    observations.set(positions[message_index]!.trace_index, seen);
    const snapshot = message.input_messages as JsonObject | unknown[] | undefined;
    const context = Array.isArray(snapshot) ? snapshot : snapshot?.messages;
    const anchor = Array.isArray(context) ? context.findLastIndex(row => row && typeof row === "object" &&
      (row as JsonObject).role === "user" && contentText((row as JsonObject).content) === questions.get(positions[message_index]!.trace_index)) : -1;
    result.push(...publicSources.filter(source => source.kind === "text" && source.quotable !== false && source.text.trim() &&
      /^\/input_messages\/(?:messages\/)?\d+\/content(?:\/|$)/u.test(source.path) && evidenceOrigin(message, source.path).enclosing_role === "tool" &&
      anchor >= 0 && Number(/^\/input_messages\/(?:messages\/)?(\d+)/u.exec(source.path)![1]) > anchor &&
      !seen.has(source.text) && originalText.get(source.path) === source.text &&
      (seen.add(source.text), true))
      .map(source => ({ message_index, source, start: 0, end: source.text.length, path: source.path })));
    if (publicSources.find(source => source.kind === "json")?.text === originalSources.find(source => source.kind === "json")?.text) {
      const diagnostics = ["output", "result"].flatMap(key => {
        const value = message[key] as JsonObject | undefined;
        return value && typeof value === "object" ? ["stderr", "error", "status_code", "exit_code", "returncode", "is_error"]
          .filter(field => value[field]).map(field => `/${key}/${field}`) : [];
      });
      const payloadFields = ["output", "result"].flatMap(key => {
        const value = message[key];
        return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value)
          .map(field => `/${key}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`) : [];
      });
      for (const path of ["/input", "/output", "/result", "/arguments", "/parameters", ...diagnostics, ...payloadFields]) {
        const selected = selectEvidenceSource(publicSources, path);
        if (selected?.source.kind === "json" && selected.source.quotable !== false)
          result.push({ message_index, ...selected, path, payloadField: payloadFields.includes(path) && !diagnostics.includes(path) });
      }
    }
    return result;
  });
  cached.set(raw, { original, entries });
  return entries;
}

export function compactProcessExcerpts(field: string, raw: RawInput, original: RawInput, inputId: string,
  positions: { trace_index: number }[], traceIndex: number, finalIndex: number, maxChars = 8000, messageIndices?: ReadonlySet<number>): JsonObject[] {
  const finals = new Set(messageContentSources(raw.messages[finalIndex]).map(source => source.text));
  const entries = sources(raw, original, positions);
  const failures = new Set<number>();
  if (field === "tool_errors") {
    for (const [index, message] of raw.messages.entries()) {
      if (positions[index]!.trace_index !== traceIndex) continue;
      const returned = message.role === "tool" || ["tool_result", "function_call_output"].includes(String(message.type));
      for (const value of [message, message.output, message.result]) if (returned && value && typeof value === "object") {
        const row = value as JsonObject;
        if ([row.exit_code, row.returncode].some(code => typeof code === "number" && code !== 0) ||
          typeof row.status_code === "number" && row.status_code < 0 || row.is_error === true || row.isError === true || row.success === false ||
          typeof row.error === "string" && !!row.error.trim()) failures.add(index);
      }
    }
    for (const entry of entries) if (entry.source.kind === "text" && positions[entry.message_index]!.trace_index === traceIndex &&
      (/^\/(?:output|content|result|output\/stderr|result\/stderr)$/u.test(entry.path) || entry.path.startsWith("/input_messages/")) &&
      /Traceback \(most recent call last\)|\b[A-Za-z_]*(?:Error|Exception):|^Tool execution is forbidden/imu.test(entry.source.text.slice(entry.start, entry.end)))
      failures.add(entry.message_index);
    const indices = positions.flatMap((point, index) => point.trace_index === traceIndex ? [index] : []);
    for (const link of traceExchanges(indices.map(index => raw.messages[index]!)))
      if (link.return_indices.some(index => failures.has(indices[index]!))) failures.add(indices[link.request_index]!);
  }
  // Source selection precedes both splitting and budget allocation.
  const selected = entries.filter(entry => {
    if (entry.payloadField && field !== "component_investigation") return false;
    if (positions[entry.message_index]!.trace_index !== traceIndex || entry.message_index === finalIndex) return false;
    if (messageIndices && !messageIndices.has(entry.message_index)) return false;
    const message = raw.messages[entry.message_index]!, origin = evidenceOrigin(message, entry.path);
    const tool = ["tool_call", "tool_result", "function_call", "function_call_output"].includes(String(message.type)) || message.role === "tool" || origin.enclosing_role === "tool";
    if (field === "tool_errors") return tool && failures.has(entry.message_index);
    if (field === "execution_chain") return tool;
    if (field === "component_investigation") {
      if (entry.path.startsWith("/input_messages/")) return false;
      if (message.type === "llm_turn") return entry.source.kind === "text" && !finals.has(entry.source.text) &&
        /\/(?:output|content|text|arguments|reasoning_content|reasoning|thinking|analysis)$/u.test(entry.path);
      if (!tool) return false;
      const payload = ["input", "arguments", "parameters", "output", "content", "result"].find(key => Object.hasOwn(message, key));
      const value = payload && message[payload];
      const wrapper = value && typeof value === "object" && !Array.isArray(value) &&
        ["stdout", "stderr"].some(key => typeof (value as JsonObject)[key] === "string");
      if (/^\/(?:output|result)\/(?:prompt|QTime|chunks_info|action_id|call_id|traceability)(?:\/|$)/u.test(entry.path)) return false;
      if (value && typeof value === "object" && !wrapper) {
        const returned = message.role === "tool" || ["tool_result", "function_call_output"].includes(String(message.type));
        const parent = returned && !Array.isArray(value) ? new RegExp(`^/${payload}/[^/]+$`, "u").test(entry.path) : entry.path === `/${payload}`;
        return entry.source.kind === "json" && parent ||
          entry.source.kind === "text" && entry.path.startsWith(`/${payload}/`) && entry.source.text.length > 400;
      }
      return entry.source.kind === "text" ? !/^\/(?:output|result)\/(?:action_id|call_id|id|type|status_msg)$/u.test(entry.path)
        : /\/(?:stderr|error|exit_code|returncode|status_code)$/u.test(entry.path);
    }
    if (["components", "component_investigation", "artifacts"].includes(field)) return tool || message.type === "llm_turn" && !finals.has(entry.source.text);
    if (!["plans", "reasoning_chain", "reflections"].includes(field) || message.type !== "llm_turn" || entry.source.kind !== "text" || finals.has(entry.source.text)) return false;
    if (/(?:^|\/)(?:reasoning_content|reasoning|thinking|analysis)(?:\/|$)/u.test(entry.path)) return true;
    if (!/^\/output(?:\/\d+)?\/content$|^\/output$|^\/content$/u.test(entry.path)) return false;
    const text = entry.source.text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u, "$1");
    if (field === "plans") return !!text;
    try { return !!text && typeof JSON.parse(text) !== "object"; } catch { return !!text; }
  });
  const diagnostic = (entry: Entry) => Number(/\/(?:stderr|error|exit_code|returncode|status_code)(?:\/|$)/u.test(entry.path)) * 4 +
    (field === "component_investigation" ? /\/(?:datas|data|rows|results|result)$/u.test(entry.path) ? 2 : /\/columns$/u.test(entry.path) ? 1 : 0 : 0);
  const ordered = selected.sort((a, b) => diagnostic(b) - diagnostic(a) || a.message_index - b.message_index);
  let remaining = maxChars;
  const queues = ordered.map(entry => ({ entry, ranges: entry.ranges ??= compactTextRanges(entry.source.text, entry.start, entry.end) }));
  const result: JsonObject[] = [], seen = new Set<string>();
  for (let round = 0; queues.some(queue => round < queue.ranges.length); round++) for (const { entry, ranges } of queues) {
    // Include the last complete block early so rebuild results are not displaced by long setup text.
    const range = ranges[round === 0 ? 0 : round === 1 ? ranges.length - 1 : round - 1];
    if (!range || range.end - range.start > remaining) continue;
    const proof = displayEvidence(cite(inputId, entry.message_index, entry.source, range.start, range.end));
    const id = String(proof.reference.evidence_id); if (seen.has(id)) continue;
    seen.add(id); remaining -= range.end - range.start;
    result.push({ ...proof, origin: evidenceOrigin(raw.messages[entry.message_index], entry.path), partial: range.start > entry.start || range.end < entry.end,
      total_chars: entry.end - entry.start });
  }
  return result;
}

export function compactFinalMaterial(finalIndex: number, raw: RawInput, inputId: string, maxChars = 1600, structuredQuestion = false) {
  let remaining = maxChars, omitted = false;
  const content = structuredQuestion ? evidenceSources(raw.messages[finalIndex]).filter(source => source.kind === "text" &&
    /^\/content(?:\/|$)/u.test(source.path) && source.quotable !== false) : messageContentSources(raw.messages[finalIndex]);
  const final_evidence = content.flatMap(source => {
    const ranges = compactTextRanges(source.text);
    let cursor = 0;
    for (const range of ranges) {
      if (source.text.slice(cursor, range.start).trim()) omitted = true;
      cursor = range.end;
    }
    if (source.text.slice(cursor).trim()) omitted = true;
    return ranges.flatMap(range => {
    if (range.end - range.start > remaining) { omitted = true; return []; }
    remaining -= range.end - range.start;
    return [displayEvidence(cite(inputId, finalIndex, source, range.start, range.end))];
    });
  });
  return { final_message_index: finalIndex, final_evidence, final_context: { partial: omitted } };
}
