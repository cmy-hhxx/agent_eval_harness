import { cite, displayEvidence, evidenceSources, selectEvidenceSource, images, overlapsImagePlaceholder, jsonRanges, traceCallOrigins, traceExchanges, traceExecutionLinks } from "@eval/tools";
import { canonical, evidenceOrigin, type JsonObject } from "@eval/contracts";
import type { RawInput } from "../inputs/types.js";
import { traceCatalog } from "./catalog.js";

/** Omit repeated bookkeeping from model input; stored facts retain every source location. */
export function executionFactsView(facts: JsonObject): JsonObject {
  const entries = (value: unknown) => Array.isArray(value) ? value as JsonObject[] : [];
  const withoutProof = ({ source_evidence: _proof, ...entry }: JsonObject) => entry;
  return { ...facts, tool_calls: entries(facts.tool_calls).map(withoutProof), model_outputs: entries(facts.model_outputs).map(withoutProof),
    execution_links: entries(facts.execution_links).map(link => ({ ...link,
      model_inputs: entries(link.model_inputs).map(({ additional_input_locations: _repeats, ...input }) => input) })),
  };
}

/** Describes recorded payload shape, never the success or correctness of an Agent. */
function outputForm(value: unknown): string {
  if (value === undefined || value === null) return "absent";
  const decode = (value: unknown) => {
    if (typeof value !== "string") return value;
    const text = value.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u, "$1");
    try { return JSON.parse(text) as unknown; } catch { return text; }
  };
  let body = decode(value);
  if (Array.isArray(body) && body.length && body.every(row => row && typeof row === "object" && typeof row.content === "string" &&
    !row.function_call && !(Array.isArray(row.tool_calls) && row.tool_calls.length)))
    body = decode(body.map(row => row.content).join("\n"));
  return Array.isArray(body) && !body.length ? "empty_json_array"
    : typeof body === "string" ? body.length ? "nonempty_text" : "empty_text" : "structured_output";
}

/** Counts only received invocation records, excluding returns and generated plans. */
export function processExecutionFacts(raw: RawInput, original: RawInput, inputId: string,
  positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index })), scope?: number) {
  const proof = (index: number, key: string) => {
    const sources = evidenceSources({ [key]: raw.messages[index]![key] }), originals = evidenceSources({ [key]: original.messages[index]![key] });
    const safe = sources.filter(source => source.kind === "text" && (source.path === `/${key}` || source.path.startsWith(`/${key}/`)) &&
      source.quotable !== false && source.text.length && originals.some(other => other.kind === source.kind && other.path === source.path && other.text === source.text));
    const selected = safe.find(source => source.path.endsWith("/content")) ?? safe[0];
    return selected ? [displayEvidence(cite(inputId, index, selected, 0, Math.min(160, selected.text.length)))] : [];
  };
  return [...new Set(positions.map(point => point.trace_index))].filter(index => scope === undefined || index === scope).map(trace_index => {
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    const calls = new Map<string, number[]>();
    for (const index of indices) {
      const message = raw.messages[index]!;
      if (!["tool_call", "function_call"].includes(String(message.type))) continue;
      const name = typeof message.name === "string" ? message.name : "";
      const group = calls.get(name) ?? []; group.push(index); calls.set(name, group);
    }
    return { turn_index: trace_index, execution_links: traceExecutionLinks(indices.map(index => original.messages[index]!)).map(link => ({
      request_message_index: indices[link.request_index]!, return_message_indices: link.return_indices.map(index => indices[index]!),
      invoking_model_message_index: link.planner_index === null ? null : indices[link.planner_index]!,
      model_inputs: link.model_inputs.map(input => ({ ...input, message_index: indices[input.message_index]!,
        ...(input.additional_input_locations ? { additional_input_locations: input.additional_input_locations.map(location =>
          ({ ...location, message_index: indices[location.message_index]! })) } : {}) })), link_basis: link.link_basis,
    })), tool_calls: [...calls].map(([name, message_indices]) => ({ name, count: message_indices.length,
      message_indices, source_evidence: message_indices.flatMap(index => [...proof(index, "name"), ...proof(index, "type")]) })),
      model_outputs: indices.flatMap(message_index => {
        const message = raw.messages[message_index]!;
        if (message.type !== "llm_turn") return [];
        const key = Object.hasOwn(message, "output") ? "output" : "content";
        return [{ message_index, name: message.name ?? "", output_form: outputForm(message[key]), source_evidence: proof(message_index, key) }];
      }) };
  });
}

/** Directory and exact public excerpts; no responsibility or semantic success classification. */
export function processMaterial(raw: RawInput, original: RawInput, inputId: string, candidate: string, maxChars = 12000,
  positions = raw.messages.map((_, message_index) => ({ trace_index: 0, message_index })), scope?: number) {
  const priority: { message_index: number; path: string }[] = [];
  for (const trace_index of new Set(positions.map(point => point.trace_index))) {
    if (scope !== undefined && trace_index !== scope) continue;
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    const messages = indices.map(index => raw.messages[index]!), origins = traceCallOrigins(messages);
    const completed = new Set(traceExchanges(messages).flatMap(exchange => {
      const call = messages[exchange.request_index]!, ids = [call.call_id, call.id];
      ids.push(...origins.filter(origin => origin.request_index === exchange.request_index).map(origin => origin.call_id));
      return ids.filter((id): id is string => typeof id === "string");
    }));
    const seen = new Set<string>();
    for (const message_index of indices) {
      const message = raw.messages[message_index]!, snapshot = message.input_messages;
      const nested = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : undefined;
      const context = Array.isArray(snapshot) ? snapshot : nested?.messages;
      if (Array.isArray(context)) context.forEach((value, index) => {
        if (!value || typeof value !== "object") return;
        const returned = value as Record<string, unknown>, id = returned.tool_call_id ?? returned.call_id;
        if (returned.role !== "tool" || typeof returned.content !== "string" || !returned.content.length ||
            typeof id === "string" && completed.has(id)) return;
        const key = canonical([id, returned.name, returned.content]);
        if (seen.has(key)) return;
        seen.add(key);
        priority.push({ message_index, path: `/input_messages${Array.isArray(snapshot) ? "" : "/messages"}/${index}/content` });
      });
    }
  }
  // Preserve explicit execution diagnostics without deciding whether they establish a defect.
  raw.messages.forEach((message, message_index) => {
    if (scope !== undefined && positions[message_index]!.trace_index !== scope) return;
    for (const parent of ["output", "result"]) {
      const value = message[parent];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      for (const key of ["stderr", "error", "warns", "status_code", "exit_code", "returncode", "is_error"])
        if (row[key] && (!Array.isArray(row[key]) || row[key].length)) priority.push({ message_index, path: `/${parent}/${key}` });
    }
  });
  let reserved = Math.floor(maxChars / 3);
  const priorityEvidence = priority.flatMap(({ message_index, path }) => {
    const selected = selectEvidenceSource(evidenceSources(raw.messages[message_index]), path);
    if (!selected || selected.source.quotable === false || !evidenceSources(original.messages[message_index]).some(source =>
      source.kind === selected.source.kind && source.path === selected.source.path && source.text === selected.source.text)) return [];
    const length = Math.min(400, selected.end - selected.start, reserved);
    if (length <= 0) return [];
    reserved -= length;
    return [{ ...displayEvidence(cite(inputId, message_index, selected.source, selected.start, selected.start + length)),
      origin: evidenceOrigin(raw.messages[message_index], path),
      partial: selected.end - selected.start > length, total_chars: selected.end - selected.start,
      read_request: { candidate, message_index, path, offset: 0, max_chars: Math.min(16000, selected.end - selected.start) } }];
  });
  let remaining = maxChars - priorityEvidence.reduce((sum, entry) => sum + entry.quote.length, 0);
  const perMessage = Math.max(1, Math.floor(remaining / Math.max(1, positions.filter(point => scope === undefined || point.trace_index === scope).length)));
  const process_evidence = raw.messages.flatMap((message, message_index) => {
    if (scope !== undefined && positions[message_index]!.trace_index !== scope) return [];
    const fields = ["content", "input", "output", "result", "arguments", "parameters", "reasoning_content", "reasoning", "thinking", "analysis", "error",
      "name", "type", "role", "model", "call_id", "tool_call_id", "parent_span", "span_id", "status", "script", "skill", "exit_code", "returncode", "success", "is_error"];
    const payload = (row: RawInput["messages"][number]) => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    const originals = new Map(evidenceSources(payload(original.messages[message_index]!)).map(source => [`${source.kind}:${source.path}`, source]));
    const locations = evidenceSources(payload(message));
    const text = locations.filter(source => source.kind === "text" && source.quotable !== false && source.text.length &&
      originals.get(`${source.kind}:${source.path}`)?.text === source.text);
    // Actual content precedes envelope identity; a name alone is not proof of a failed action.
    const selected = text.map(source => ({ source, start: 0, end: source.text.length, readPath: source.path }));
    // Numeric fields have no text leaves. Preserve their actual JSON bytes, including mixed text/numeric tables.
    let whole: ReturnType<typeof evidenceSources> | undefined, originalJson: string | undefined;
    const selectionCache = new WeakMap();
    for (const key of ["input", "arguments", "parameters", "output", "result", "content", "exit_code", "returncode", "success", "is_error"]) {
      const value = message[key];
      if (value === undefined || typeof value === "string") continue;
      // Parent JSON coordinates are usable only when public and original messages match.
      // Model snapshots can contain large private histories; their safe text leaves above suffice for navigation.
      if (Object.hasOwn(message, "input_messages")) continue;
      whole ??= evidenceSources(message);
      const field = selectEvidenceSource(whole, `/${key}`, selectionCache);
      if (!field || field.source.kind !== "json" || field.source.quotable === false) continue;
      originalJson ??= evidenceSources(original.messages[message_index]).find(source => source.kind === "json")!.text;
      if (originalJson !== field.source.text) continue;
      selected.unshift({ ...field, readPath: `/${key}` });
    }
    let allowance = Math.min(remaining, perMessage);
    return selected.flatMap(({ source, start: fieldStart, end: fieldEnd, readPath }) => {
      if (allowance <= 0) return [];
      const fieldLength = fieldEnd - fieldStart;
      const length = Math.min(fieldLength, allowance, 800), half = Math.min(400, Math.ceil(length / 2));
      const ranges = fieldLength <= length ? [[fieldStart, fieldEnd]]
        : [[fieldStart, fieldStart + half], [fieldEnd - (length - half), fieldEnd]].filter(([start, end]) => end! > start!);
      allowance -= length; remaining -= length;
      return ranges.flatMap(([start, end]) => {
        const entries = [];
        for (let offset = start!; offset < end!; offset += 400) {
          if (overlapsImagePlaceholder(source.text, offset, Math.min(end!, offset + 400))) continue;
          entries.push({
          ...displayEvidence(cite(inputId, message_index, source, offset, Math.min(end!, offset + 400))),
          origin: evidenceOrigin(message, readPath),
          partial: length < fieldLength, total_chars: fieldLength,
          read_request: { candidate, message_index, path: readPath, offset: 0, max_chars: Math.min(16000, fieldLength) },
        });
        }
        return entries;
      });
    });
  });
  // A repeated call id in a later turn must never bind to an earlier turn's invocation.
  const directory = [...new Set(positions.map(point => point.trace_index))].filter(index => scope === undefined || index === scope).flatMap(trace_index => {
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    const messages = indices.map(index => raw.messages[index]!), origins = traceCallOrigins(messages);
    const proof = (local: number, path: string) => {
      const index = indices[local]!, selected = selectEvidenceSource(evidenceSources(raw.messages[index]), path);
      if (!selected || selected.source.quotable === false || !evidenceSources(original.messages[index]).some(source =>
        source.kind === selected.source.kind && source.path === selected.source.path && source.text === selected.source.text)) return [];
      const result = [];
      for (let start = selected.start; start < Math.min(selected.end, selected.start + 800); start += 400)
        result.push(displayEvidence(cite(inputId, index, selected.source, start, Math.min(start + 400, selected.end))));
      return result;
    };
    return traceCatalog({ messages }).map(row => ({ ...row,
      message_index: indices[row.message_index]!,
      ...(row.call_message_index === undefined ? {} : { call_message_index: indices[row.call_message_index] }),
      ...(row.invoking_model_message_index === undefined ? {} : { invoking_model_message_index: indices[row.invoking_model_message_index] }),
      generated_arguments: origins.filter(origin => origin.request_index === row.message_index).map(origin => ({
        model_message_index: indices[origin.planner_index], request_message_index: indices[origin.request_index],
        source_evidence: [...proof(origin.planner_index, origin.arguments_path), ...proof(origin.request_index, origin.input_path)],
      })),
    }));
  }).filter(row => scope === undefined || positions[row.message_index]!.trace_index === scope);
  return { execution_facts: processExecutionFacts(raw, original, inputId, positions, scope), source_directory: directory.map(row => ({ ...row, position: positions[row.message_index],
    identity_evidence: ["name", "model", "call_id", "tool_call_id", "parent_span", "span_id", "script", "skill", "agent_name", "node_name", "service_name", "tool_name", "skill_name", "script_path"]
      .flatMap(key => {
        const value = raw.messages[row.message_index]![key];
        if (typeof value !== "string" || !value.length || value.length > 400 || value !== original.messages[row.message_index]![key]) return [];
        return evidenceSources({ [key]: value }).filter(source => source.kind === "text" && source.quotable !== false)
          .map(source => displayEvidence(cite(inputId, row.message_index, source, 0, source.text.length)));
      }),
    ...(images(raw.messages[row.message_index]).length ? { image_count: images(raw.messages[row.message_index]).length,
      view_request: { candidate, message_index: row.message_index } } : {}),
    ...Object.fromEntries(["model", "agent_name", "node_name", "service_name", "tool_name", "skill_name", "script_path", "start_time", "end_time", "finish_reason", "stop_reason", "exit_code", "returncode", "success", "is_error", "usage"]
      .filter(key => Object.hasOwn(raw.messages[row.message_index], key)).map(key => [key, raw.messages[row.message_index]![key]])) })), process_evidence: [...priorityEvidence, ...process_evidence] };
}

/** Copy small structured source values once; semantic importance remains the compact model's choice. */
export function structuredProcessFacts(raw: RawInput, maxChars = 14000, selected?: ReadonlySet<number>) {
  const payloads = raw.messages.flatMap((message, message_index) =>
    selected && !selected.has(message_index) ? [] : ["input", "arguments", "parameters", "output", "result", "content", "exit_code", "returncode", "success", "is_error"].flatMap(key => {
      if (!Object.hasOwn(message, key)) return [];
      let value = message[key];
      if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return []; }
      }
      return value !== undefined ? [{ message_index, path: `/${key}`, value }] : [];
    }));
  const allowance = Math.max(64, Math.floor(maxChars / Math.max(1, payloads.length)));
  return payloads.map(({ message_index, path, value }) => {
    const fields: Record<string, unknown> = {};
    let chars = 2, partial = false;
    const numeric = (node: unknown) => typeof node === "number" || typeof node === "string" && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/iu.test(node);
    const visit = (node: unknown, location: string, numericPass: boolean) => {
      if (node && typeof node === "object") {
        const entries = Object.entries(node);
        for (const [key, child] of Array.isArray(node) ? entries.slice(0, 5) : entries)
          visit(child, `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, numericPass);
        if (Array.isArray(node) && entries.length > 5) partial = true;
      } else if (typeof node === "number" || typeof node === "boolean" || node === null || typeof node === "string" && node.length <= 160) {
        if (numeric(node) !== numericPass || Object.hasOwn(fields, location)) return;
        const size = JSON.stringify([location, node]).length;
        if (chars + size <= allowance) { fields[location] = node; chars += size; }
        else partial = true;
      } else partial = true;
    };
    // Preserve the payload's own scalar context before spending the rest on nested series.
    if (value && typeof value === "object" && !Array.isArray(value))
      for (const [key, child] of Object.entries(value)) if (!child || typeof child !== "object")
        visit(child, `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, numeric(child));
    // Large column descriptions must not exhaust the remaining budget before table values.
    visit(value, "", true);
    visit(value, "", false);
    return { message_index, path, fields, partial,
      read_request: { candidate: "answer", message_index, path, offset: 0, max_chars: 16000 } };
  });
}

/** Resolve selected scalar facts to their exact source bytes, including JSON stored inside a string. */
export function referencedProcessFacts(raw: RawInput, original: RawInput, inputId: string,
  positions: { trace_index: number; message_index: number }[], scope?: number) {
  const selected = scope === undefined ? undefined : new Set(positions.flatMap((point, index) => point.trace_index === scope ? [index] : []));
  return structuredProcessFacts(raw, 14000, selected).flatMap(row => {
    const message = raw.messages[row.message_index]!, originalMessage = original.messages[row.message_index]!;
    const sources = evidenceSources(message), originals = evidenceSources(originalMessage);
    const text = sources.find(source => source.kind === "text" && source.path === row.path);
    const json = sources.find(source => source.kind === "json")!;
    const source = text ?? json;
    // Never issue coordinates in a rewritten JSON parent or a privacy placeholder.
    if (source.quotable === false || !originals.some(item => item.kind === source.kind && item.path === source.path && item.text === source.text)) return [];
    let ranges: ReturnType<typeof jsonRanges>;
    try { ranges = jsonRanges(source.text); } catch { return []; }
    return Object.entries(row.fields).flatMap(([field_path, value]) => {
      const pointer = (text ? "" : row.path) + field_path;
      const span = ranges.get(pointer);
      if (!span || span.end - span.start > 400) return [];
      if (!Object.is(JSON.parse(source.text.slice(span.valueStart, span.end)), value)) return [];
      const evidence = displayEvidence(cite(inputId, row.message_index, source, span.start, span.end));
      return [{ value, origin: evidenceOrigin(message, row.path + field_path),
        location: { ...positions[row.message_index]!, source_message_index: row.message_index, path: row.path, field_path },
        source_evidence: [{ ...evidence, location: { ...positions[row.message_index]!, source_message_index: row.message_index,
          path: source.path, start: span.start, end: span.end } }] }];
    });
  });
}
