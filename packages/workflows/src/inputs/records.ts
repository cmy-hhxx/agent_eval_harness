import { fileSourceReader } from "@eval/data";
import { randomUUID } from "node:crypto";
import { canonical, evidenceSources, object, ValidationError, type ValidationIssue } from "@eval/contracts";
import { inputAdapters, resolveAdapter } from "./adapters.js";
import { normalizeInput } from "./normalize.js";
import type { Candidate, CandidateTurn, RawInput, SessionTurn, Timing, VersionConfig } from "./types.js";

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .filter((v) => typeof v === "string" || (v && typeof v === "object"))
      .map(contentText)
      .join("\n");
  if (value && typeof value === "object") return String((value as { text?: unknown }).text ?? "");
  return "";
}

/** Published query payloads and form selections stay intact; citations use their original string leaves. */
export function structuredQuestion(content: unknown) {
  const node = content && typeof content === "object" && !Array.isArray(content)
    ? content as Record<string, unknown> : undefined;
  const query = node && typeof node.query === "string" && node.query.trim() &&
    typeof node.datajson === "string" && typeof node.contentConfigComefrom === "string";
  const selections = Array.isArray(content) && content.length > 0 && content.every(item =>
    item && typeof item === "object" && !Array.isArray(item) && typeof item.header === "string" &&
    Array.isArray(item.selected) && item.selected.every((value: unknown) => typeof value === "string"));
  if (!query && !selections) return undefined;
  return { text: JSON.stringify(content), sources: evidenceSources({ content })
    .filter(source => source.kind === "text" && source.text.length > 0 && source.quotable !== false) };
}

export function strings(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}

export function inputSources(candidates: Candidate[]): Map<string, Candidate[]> {
  const sources = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!sources.has(c.source)) sources.set(c.source, []);
    sources.get(c.source)!.push(c);
  }
  return sources;
}

export function adapt(
  value: unknown,
  item: VersionConfig,
  source: string,
  line: number,
  defaultBatch?: string,
): Candidate {
  const session = Object.hasOwn(object(value), "traces"), raw = normalizeInput(value);
  const inputId = randomUUID();
  const meta = raw.meta || {}, turns: SessionTurn[] = raw.turns ?? [{ meta, messages: raw.messages }];
  const errors: ValidationIssue[] = [];
  if (
    raw.request_time !== undefined &&
    raw.request_time !== null &&
    (typeof raw.request_time !== "string" || !raw.request_time.trim())
  )
    errors.push({
      category: "input",
      code: "request_time_invalid",
      path: "/request_time",
      actual: raw.request_time,
      expected: "非空字符串、null 或缺失",
      message: "request_time 必须是非空字符串或 null",
    });
  if (raw.has_standard_answer !== undefined && typeof raw.has_standard_answer !== "boolean")
    errors.push({
      category: "input",
      code: "standard_answer_flag_invalid",
      path: "/has_standard_answer",
      actual: raw.has_standard_answer,
      expected: "boolean",
      message: "has_standard_answer 必须是布尔值",
    });
  const batch = raw.batch_id || meta.batch_id || defaultBatch,
    id = raw.case_id || meta.case_id;
  for (const [key, value] of [
    ["batch_id", batch],
    ["case_id", id],
  ] as const)
    if (typeof value !== "string" || !value.trim())
      errors.push({
        category: "input",
        code: "identity_invalid",
        path: "/" + key,
        actual: value ?? null,
        expected: "非空字符串",
        message: "缺少或无效的 " + key,
      });
  if (errors.length) throw new ValidationError(errors);
  if (raw.version && raw.version !== item.name) throw new Error("输入 version 与配置版本不一致");
  if (raw.case_id && meta.case_id && raw.case_id !== meta.case_id)
    throw new Error("顶层 case_id 与 meta.case_id 冲突");
  if (meta.ok === false) throw new Error("缺少有效回答或采集失败");
  const details = turns.map((trace, trace_index) => {
    const messages = trace.messages, traceMeta = trace.meta ?? {};
    if (!Array.isArray(messages) || !messages.length ||
        messages.some((m) => !m || typeof m !== "object" || Array.isArray(m)))
      throw new Error(`trace ${trace_index} 缺少有效回答或采集失败`);
    const adapter = session
      ? Object.values(inputAdapters).find(adapter => messages.every(message => adapter.accepts(message)))
      : resolveAdapter(item.adapter);
    if (!adapter || messages.some((m) => !adapter.accepts(m))) throw new Error("链路含未支持的消息类型");
    const lastUser = messages.findLastIndex((m) => m.role === "user" || m.role === undefined && m.type === "user_question");
    if (lastUser < 0) throw new Error(`trace ${trace_index} 无法定位用户问题`);
    const final = messages.findLastIndex(
      (m, i) => i > lastUser &&
        (session && messages[lastUser].type === "user_question"
          ? m.type === "final_answer" && (m.role === undefined || m.role === "assistant")
          : m.role === "assistant" || m.role === undefined && m.type === "final_answer") &&
        !!contentText(m.content).trim(),
    );
    if (final < 0) throw new Error(`trace ${trace_index} 没有完整最终回答`);
    const content = messages[lastUser].content;
    const question = (structuredQuestion(content)?.text ?? contentText(Array.isArray(content) ? content.slice(0, 1) : content)).trim();
    if (!question) throw new Error(`trace ${trace_index} 用户问题为空`);
    const traceCandidate: CandidateTurn = {
      trace_index,
      trace_id: typeof traceMeta.trace_id === "string" ? traceMeta.trace_id : null,
      question,
      final_index: final,
    };
    return { trace, traceMeta, messages, adapter, final, question, traceCandidate };
  });
  const first = details[0]!, question = first.question, final = first.final;
  const references =
    raw.has_standard_answer === false
      ? []
      : ["ground_truth", "std_answer"]
          .map((k) => meta[k])
          .filter((v) => v !== null && v !== undefined && v !== "");
  if (new Set(references.map(canonical)).size > 1) throw new Error("ground_truth 与 std_answer 冲突");
  const llm = session && typeof first.traceMeta.model === "string" && first.traceMeta.model.trim()
    ? first.traceMeta.model : first.adapter.answerModel(raw, first.messages, final);
  const fields = {
    first_token_seconds: "first_token_time_cost",
    first_answer_seconds: "first_answer_time_cost",
    finish_seconds: "finish_answer_time_cost",
  };
  const timing: Timing = {
    first_token_seconds: null,
    first_answer_seconds: null,
    finish_seconds: null,
    source_unit: item.timing_unit || "ms",
    source_values: {},
    source_fields: {},
  };
  for (const [key, field] of Object.entries(fields)) {
    const value = Object.hasOwn(first.traceMeta, field) ? first.traceMeta[field] : meta[field];
    timing.source_values[key] = value ?? null;
    timing.source_fields[key] = `meta.${field}`;
    timing[key as keyof typeof fields] =
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value / (timing.source_unit === "ms" ? 1000 : 1)
        : null;
  }
  return {
    batch_id: String(batch),
    case_id: String(id),
    version: item.id,
    name: item.display_name || item.name,
    ...(item.display_name && item.display_name !== item.name ? { identity_names: [item.name] } : {}),
    input_id: inputId,
    trace_id: raw.trace_id || meta.trace_id ? String(raw.trace_id || meta.trace_id) : null,
    source,
    line,
    question,
    answer_timing: timing,
    final_index: final,
    reference: references[0] ?? null,
    llm: llm ? String(llm) : null,
    ...(meta.session_id || first.traceMeta.session_id ? { session_id: String(meta.session_id || first.traceMeta.session_id) } : {}),
    turns: details.map(item => item.traceCandidate),
  };
}

export function candidateKey(record: Candidate): string {
  return canonical([record.batch_id, record.case_id, record.version]);
}

function recordMatch(
  value: string | undefined,
  line: number,
  candidate: Candidate,
  version: VersionConfig,
  source: string,
  defaultBatch?: string,
): { raw: RawInput; line: number; record: Candidate } | undefined {
  if (!value || !value.trim()) return undefined;
  try {
    const raw = object(JSON.parse(value)) as RawInput;
    const record = adapt(raw, version, source, line, defaultBatch);
    return candidateKey(record) === candidateKey(candidate) ? { raw: normalizeInput(raw), line, record } : undefined;
  } catch {
    return undefined;
  }
}

/** Stream one registered record: the recorded line is re-read first, then the whole source. */
export async function locateRecordStream(
  source: string,
  candidate: Candidate,
  version: VersionConfig,
  defaultBatch?: string,
): Promise<{ raw: RawInput; line: number; record: Candidate; byteOffset: number; byteLength: number }> {
  const scan = async (expectedLine?: number) => {
    for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(source)) {
      if (expectedLine !== undefined && index !== expectedLine) continue;
      const found = recordMatch(line, index, candidate, version, source, defaultBatch);
      if (found) return { ...found, byteOffset, byteLength };
      if (expectedLine !== undefined) return undefined;
    }
    return undefined;
  };
  const direct = await scan(candidate.line);
  if (direct) return direct;
  const found = await scan();
  if (found) return found;
  throw new Error("输入源记录与登记的业务标识不一致：" + candidate.input_id);
}

interface ScannedInput {
  index: number;
  batchId: string | null;
  caseId: string | null;
  record?: Candidate;
  raw?: RawInput;
  error?: unknown;
}

export async function* scanInputFile(source: string, version: VersionConfig, defaultBatch: string | undefined,
  revision: string): AsyncGenerator<ScannedInput | undefined> {
  for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(source, revision)) {
    if (!line.trim()) { yield undefined; continue; }
    const entry: ScannedInput = { index, batchId: null, caseId: null };
    try {
      const raw = object(JSON.parse(line)) as RawInput, meta = raw.meta || {};
      const batch = raw.batch_id || meta.batch_id || defaultBatch, id = raw.case_id || meta.case_id;
      entry.batchId = batch ? String(batch) : null;
      entry.caseId = id ? String(id) : null;
      // Coordinates travel with the admitted record so execution never rescans the source.
      entry.record = { ...adapt(raw, version, source, index, defaultBatch), byte_offset: byteOffset, byte_length: byteLength };
      entry.raw = normalizeInput(raw);
    } catch (error) { entry.error = error; }
    yield entry;
  }
}
