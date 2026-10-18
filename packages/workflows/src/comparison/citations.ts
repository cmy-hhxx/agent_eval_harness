import { answerTurnContexts, citationMarkers, cite, evidenceSources, parseEvidenceCoordinates, selectEvidenceSource, type CitationFormat } from "@eval/tools";

type Evidence = ReturnType<typeof cite>;
type EvidenceSource = ReturnType<typeof evidenceSources>[number];
export interface CitationContext extends Evidence {
  read_request: { message_index: number; path: string; offset: number; max_chars: number };
  end_offset: number;
}
export interface CitationSource extends CitationContext {
  origin: "tool_return" | "model_visible";
  /** Exact declared source address; absence does not establish that a document is missing. */
  document_url?: string;
}
export interface CitationOccurrence extends Evidence {
  context: CitationContext;
}
export interface CitationReference {
  reference: string;
  format: CitationFormat;
  status: "resolved" | "ambiguous" | "unknown";
  occurrences: CitationOccurrence[];
  sources: CitationSource[];
}
export interface CitationInventory {
  /** Observed source formats, not a requirement imposed on this answer. */
  protocols: CitationFormat[];
  references: CitationReference[];
  /** Exact addresses group repeated source fragments; different addresses do not prove independence. */
  document_groups: { url: string; references: { format: CitationFormat; reference: string }[] }[];
}

/** Present split text results at their real leaf coordinates, without serialized transport wrappers. */
export function citationSourceParts(raw: { messages: unknown[] }, inputId: string, source: CitationSource): CitationSource[] {
  const point = parseEvidenceCoordinates(source.evidence_id);
  if (point?.kind !== "json" || !/^<referencable-result>/u.test(source.quote)) return [source];
  const locations = evidenceSources(raw.messages[source.message_index]);
  const container = locations.find(item => item.kind === "json" && item.path === point.path)!;
  const parts = locations.filter(item => item.kind === "text" && /\/(?:text|content|\d+)$/u.test(item.path)).flatMap(leaf => {
    const selected = selectEvidenceSource([container], leaf.path);
    if (!selected) return [];
    const valueStart = selected.end - JSON.stringify(leaf.text).length + 1;
    const from = Math.max(point.start, valueStart), to = Math.min(point.end, selected.end - 1);
    if (from >= to) return [];
    const decode = (end: number) => (JSON.parse('"' + container.text.slice(valueStart, end) + '"') as string).length;
    const start = decode(from), end = decode(to), quote = leaf.text.slice(start, end);
    if (!quote.replace(/<referencable-result>\s*ID:\s*\d+|<\/referencable-result>/gu, "").trim()) return [];
    return [{ ...source, ...cite(inputId, source.message_index, leaf, start, end),
      read_request: { message_index: source.message_index, path: leaf.path, offset: start, max_chars: Math.min(16000, end - start) },
      end_offset: end }];
  });
  return parts.length ? parts : [source];
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const isReturn = (message: Record<string, unknown>) => message.role === "tool" ||
  ["function_call_output", "tool_result"].includes(String(message.type));
const sourceFields = new Set(["output", "content", "result"]);
const documentUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value !== value.trim() || !/^https?:\/\//u.test(value)) return undefined;
  try { new URL(value); return value; } catch { return undefined; }
};
/** Only the current footnote envelope's explicit metadata, including JSON-escaped split leaves. */
const footnoteDocumentUrl = (quote: string): string | undefined => {
  const summary = quote.search(/(?:^|\r?\n|\\n)[ \t]*摘要[:：]/u);
  const metadata = summary < 0 ? quote : quote.slice(0, summary);
  const urls = new Set([...metadata.matchAll(/(?:^|\r?\n|\\n)[ \t]*溯源地址[:：][ \t]*(https?:\/\/[^\s"\\<>（）]+)/gu)]
    .flatMap(match => documentUrl(match[1]) ?? []));
  return urls.size === 1 ? [...urls][0] : undefined;
};

/** Blank lines bound the original paragraph in this leaf; adjacent claims stay intact. */
function occurrenceContext(inputId: string, messageIndex: number, source: EvidenceSource, start: number, end: number): CitationContext {
  let from = 0, to = source.text.length;
  for (const match of source.text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/gu)) {
    const next = match.index + match[0].length;
    if (next <= start) from = next;
    else if (match.index >= end) { to = match.index; break; }
  }
  return { ...cite(inputId, messageIndex, source, from, to),
    read_request: { message_index: messageIndex, path: source.path, offset: from, max_chars: Math.min(16000, to - from) },
    end_offset: to };
}

/** Ref identifies a search/data projection; anchor identifies its actual traceable action. */
function traceSources(value: Record<string, unknown>): { reference: string; attribute: "ref" | "anchor" }[] {
  const sources: { reference: string; attribute: "ref" | "anchor" }[] = [];
  const reference = value.serial_number ?? value.ref;
  const search = typeof value.title === "string" &&
    ["summary", "content", "url"].some(key => typeof value[key] === "string");
  const finance = typeof value.query === "string" &&
    ["datas", "columns", "row_count"].some(key => Object.hasOwn(value, key));
  if (typeof reference === "string" && /^[A-Za-z0-9]{7}$/u.test(reference) && (search || finance))
    sources.push({ reference, attribute: "ref" });
  if (typeof value.action_id === "string" && /^[A-Za-z0-9]{7}$/u.test(value.action_id) &&
      (value.traceability === true || value.traceability === 1) && typeof value.stdout === "string")
    sources.push({ reference: value.action_id, attribute: "anchor" });
  return sources;
}

const referenceKey = (format: CitationFormat, reference: string, attribute: "ref" | "anchor" = "ref") =>
  format === "trace" ? `trace:${attribute}:${reference}` : `${format}:${reference}`;

/** Every non-whitespace character must belong to complete returned JSON documents. */
function jsonDocuments(text: string): { start: number; end: number; value: unknown }[] {
  const documents: { start: number; end: number; value: unknown }[] = [];
  let from = 0;
  while (from < text.length) {
    while (/\s/u.test(text[from] ?? "") && from < text.length) from++;
    if (from === text.length) break;
    if (!["{", "["].includes(text[from])) return [];
    const stack: string[] = [];
    let quoted = false, escaped = false, end = from;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) return [];
        if (!stack.length) { end++; break; }
      }
    }
    if (stack.length || quoted) return [];
    try { documents.push({ start: from, end, value: JSON.parse(text.slice(from, end)) }); }
    catch { return []; }
    from = end;
  }
  return documents;
}
const visualEnvelopeFields = new Set([...sourceFields, "resources", "items"]);
const visualReference = (value: Record<string, unknown>) => value.type === "vis-html" &&
  typeof value.id === "string" && /^[^\s"<>]+$/u.test(value.id) ? value.id : undefined;
/** Resource records and returned envelopes only; documentation examples are not resource IDs. */
function visualReferences(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(visualReferences);
  const node = record(value);
  if (!node) return [];
  const reference = visualReference(node);
  if (reference) return [reference];
  return Object.entries(node).flatMap(([key, child]) => key === "stdout" && typeof child === "string"
    ? jsonDocuments(child).flatMap(document => visualReferences(document.value))
    : visualEnvelopeFields.has(key) ? visualReferences(child) : []);
}

/** Locate balanced literal JSON objects without synthesizing any source text. */
function jsonObjects(text: string): { start: number; end: number; value: Record<string, unknown> }[] {
  const found: { start: number; end: number; value: Record<string, unknown> }[] = [];
  const stack: number[] = [];
  let quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && stack.length) quoted = true;
    else if (char === "{") stack.push(index);
    else if (char === "}" && stack.length) {
      const start = stack.pop()!;
      const literal = text.slice(start, index + 1);
      // Avoid parsing unrelated row objects and instruction examples.
      if (!/"(?:serial_number|ref|action_id)"\s*:/u.test(literal)) continue;
      try {
        const value = record(JSON.parse(literal));
        if (value && traceSources(value).length) found.push({ start, end: index + 1, value });
      } catch { /* A malformed block is not a usable citation directory. */ }
    }
  }
  return found;
}

/** References identify source material; they do not prove a whole sentence or a rendered view. */
export function citationInventory(raw: { messages: unknown[] }, inputId: string, finalIndex: number): CitationInventory {
  const directory = new Map<string, CitationSource[]>();
  const protocols = new Set<CitationFormat>();
  const add = (format: CitationFormat, reference: string, evidence: Evidence, origin: CitationSource["origin"],
    attribute: "ref" | "anchor" = "ref", declaredUrl?: string) => {
    const key = referenceKey(format, reference, attribute);
    protocols.add(format);
    const sources = directory.get(key) ?? [];
    if (!sources.some(source => source.evidence_id === evidence.evidence_id && source.origin === origin)) {
      const coordinate = parseEvidenceCoordinates(evidence.evidence_id);
      if (!coordinate || coordinate.kind === "image") throw new Error("引用目录证据不是文本坐标");
      const { start, end, path } = coordinate;
      const url = format === "footnote" ? footnoteDocumentUrl(evidence.quote) : documentUrl(declaredUrl);
      sources.push({ ...evidence, origin, ...(url ? { document_url: url } : {}), read_request: { message_index: evidence.message_index,
        path, offset: start, max_chars: Math.min(16000, end - start) }, end_offset: end });
    }
    directory.set(key, sources);
  };
  const sourceEvidence = (message: unknown, messageIndex: number, path: string) => {
    const selected = selectEvidenceSource(evidenceSources(message), path);
    return selected ? cite(inputId, messageIndex, selected.source, selected.start, selected.end) : undefined;
  };
  const indexText = (source: EvidenceSource, messageIndex: number, origin: CitationSource["origin"], from = 0,
    until = source.text.length, visual = true) => {
    const text = source.text.slice(from, until);
    if (visual) for (const document of jsonDocuments(text)) for (const reference of new Set(visualReferences(document.value)))
      add("vis-html", reference, cite(inputId, messageIndex, source, from + document.start, from + document.end), origin);
    for (const block of jsonObjects(text)) for (const ref of traceSources(block.value))
      add("trace", ref.reference, cite(inputId, messageIndex, source, from + block.start, from + block.end), origin,
        ref.attribute, typeof block.value.url === "string" ? block.value.url : undefined);
    // The renderer's current financial projection has a literal field block rather than JSON.
    const blocks = [...text.matchAll(/^finquery_result:\s*\r?\nserial_number:\s*([A-Za-z0-9]{7})\s*\r?\nquery:[^\n]+\r?\nrow_count:\s*\d+\s*\r?\n/gmu)];
    for (const [index, match] of blocks.entries()) {
      const start = match.index;
      const next = blocks[index + 1]?.index ?? text.length;
      const tail = text.slice(start, next);
      // Separate a following literal JSON result from this field block.
      const jsonStart = tail.search(/\n\{"serial_number"\s*:/u);
      const end = jsonStart < 0 ? next : start + jsonStart;
      add("trace", match[1], cite(inputId, messageIndex, source, from + start, from + end), origin);
    }
  };
  raw.messages.slice(0, finalIndex).forEach((value, messageIndex) => {
    const message = record(value);
    if (!message || !isReturn(message)) return;
    const sources = evidenceSources(message);
    const leaves = sources.filter(source => source.kind === "text" && sourceFields.has(source.path.split("/")[1] ?? ""));
    let opened: { reference: string; source: EvidenceSource; start: number } | undefined;
    for (const source of leaves) {
      for (const match of source.text.matchAll(/<referencable-result>\s*ID:\s*(\d+)|<\/referencable-result>/gu)) {
        if (match[1] !== undefined) opened = { reference: match[1], source, start: match.index };
        else if (opened) {
          const end = match.index + match[0].length;
          if (opened.source.path === source.path)
            add("footnote", opened.reference, cite(inputId, messageIndex, source, opened.start, end), "tool_return");
          else {
            // A may split one result among content parts. Its evidence is a real JSON range.
            const jsonSources = sources.filter(item => item.kind === "json");
            const first = selectEvidenceSource(jsonSources, opened.source.path);
            const last = selectEvidenceSource(jsonSources, source.path);
            if (first && last) {
              // JSON pointer ranges include object keys. String values end at the range end,
              // so locate their opening quotes independently of the property's key or layout.
              const firstValueStart = first.end - JSON.stringify(opened.source.text).length;
              const lastValueStart = last.end - JSON.stringify(source.text).length;
              const from = firstValueStart + 1 + JSON.stringify(opened.source.text.slice(0, opened.start)).length - 2;
              const to = lastValueStart + 1 + JSON.stringify(source.text.slice(0, end)).length - 2;
              add("footnote", opened.reference, cite(inputId, messageIndex, first.source, from, to), "tool_return");
            }
          }
          opened = undefined;
        }
      }
      indexText(source, messageIndex, "tool_return");
    }
    const walk = (child: unknown, path: string) => {
      const node = record(child);
      if (node) {
        const refs = traceSources(node), evidence = refs.length ? sourceEvidence(message, messageIndex, path) : undefined;
        if (evidence) for (const ref of refs) add("trace", ref.reference, evidence, "tool_return", ref.attribute, typeof node.url === "string" ? node.url : undefined);
      }
      if (child && typeof child === "object") for (const [key, item] of Object.entries(child))
        walk(item, `${path}/${pointer(key)}`);
    };
    const walkVisual = (child: unknown, path: string) => {
      const node = record(child), reference = node && visualReference(node);
      if (reference) {
        const evidence = sourceEvidence(message, messageIndex, path);
        if (evidence) add("vis-html", reference, evidence, "tool_return");
      } else if (Array.isArray(child)) child.forEach((item, index) => walkVisual(item, `${path}/${index}`));
      else if (node) for (const [key, item] of Object.entries(node))
        if (visualEnvelopeFields.has(key)) walkVisual(item, `${path}/${pointer(key)}`);
    };
    for (const [key, child] of Object.entries(message)) if (sourceFields.has(key)) {
      walk(child, `/${key}`);
      walkVisual(child, `/${key}`);
    }
  });

  // B assigns some IDs after the raw tool return. Only the actual final renderer's material
  // is an eligible directory; planner turns and system instruction examples are excluded.
  const context = answerTurnContexts(raw, finalIndex).at(-1);
  const turn = context && record(raw.messages[context.message_index]);
  if (context && turn) {
    const turnIndex = context.message_index;
    const instructions = turn.input_messages;
    const nested = record(instructions);
    const messages = Array.isArray(instructions) ? instructions : Array.isArray(nested?.messages) ? nested.messages : [];
    const rootPath = context.path;
    const sources = evidenceSources(turn);
    messages.forEach((value, index) => {
      const item = record(value);
      if (!item || !["user", "tool"].includes(String(item.role))) return;
      const prefix = `${rootPath}/${index}/content`;
      for (const source of sources.filter(source => source.kind === "text" &&
        (source.path === prefix || source.path.startsWith(prefix + "/")))) {
        if (item.role === "tool") indexText(source, turnIndex, "model_visible");
        else {
          // Fast's final user message wraps current results, history and instructions together.
          // Only the current named search/financial sections are source directories.
          const start = source.text.search(/^你(?:通过网络搜索查到的内容|取到的金融数据)[:：]/mu);
          if (start < 0) continue;
          const metadata = source.text.slice(start).search(/^(?:你调用客服工具拿到的内容[:：]|以下是仅供你知悉的背景元数据|当前时间[:：]|用户 KYC\s*\/\s*记忆信息[:：]|NER 抽取结果)/mu);
          const end = metadata < 0 ? source.text.length : start + metadata;
          indexText(source, turnIndex, "model_visible", start, end, false);
        }
      }
    });
  }
  const references = new Map<string, CitationReference>();
  const final = record(raw.messages[finalIndex]);
  if (final) for (const source of evidenceSources({ content: final.content }).filter(source => source.kind === "text"))
    for (const marker of citationMarkers(source.text)) {
      const key = referenceKey(marker.format, marker.reference, marker.attribute);
      const sources = directory.get(key) ?? [];
      const primary = sources.filter(item => item.origin === "tool_return");
      // Repeated identical full results are multiple locations of one logical source.
      // A changed body remains ambiguous even at the same URL.
      const count = new Set((primary.length ? primary : sources).map(item => item.quote)).size;
      const entry = references.get(key) ?? { reference: marker.reference, format: marker.format,
        status: count === 0 ? "unknown" : count === 1 ? "resolved" : "ambiguous", occurrences: [], sources };
      entry.occurrences.push({ ...cite(inputId, finalIndex, source, marker.start, marker.end),
        context: occurrenceContext(inputId, finalIndex, source, marker.start, marker.end) });
      references.set(key, entry);
    }
  const documents = new Map<string, CitationInventory["document_groups"][number]>();
  for (const reference of references.values()) for (const source of reference.sources) {
    if (!source.document_url) continue;
    const group = documents.get(source.document_url) ?? { url: source.document_url, references: [] };
    if (!group.references.some(item => item.format === reference.format && item.reference === reference.reference))
      group.references.push({ format: reference.format, reference: reference.reference });
    documents.set(group.url, group);
  }
  return { protocols: [...protocols], references: [...references.values()], document_groups: [...documents.values()] };
}
