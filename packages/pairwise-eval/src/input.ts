import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_POLICY, type PlannedTask, type TaskPlan, type ValidationIssue } from "../../contracts/src/index.js";
import { canonical, errorText, object, readJson, ValidationError } from "../../contracts/src/io.js";
import type { BatchPreflight, Candidate, EvalConfig, RawInput, TaskData, Timing, VersionConfig } from "./types.js";

export const ALLOWED_PAIRS = [
  ["a_fast", "aa_fast"],
  ["a_expert", "aa_expert"],
];
export function comparisonPair(versions: string[]): string[] {
  const pair = ALLOWED_PAIRS.find((p) => versions.length === 2 && p.every((v) => versions.includes(v)));
  if (!pair) throw new Error("不允许的对比：" + versions.join(" / "));
  return pair;
}
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
export function strings(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}
const normalize = (text: string) => text.replace(/\s+/gu, "");
async function inputFiles(target: string, versionId: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === `${versionId}.jsonl`) matches.push(file);
    }
  }
  await visit(target);
  return matches;
}
export async function loadConfig(file: string, env = process.env): Promise<EvalConfig> {
  const source = await readJson<Omit<EvalConfig, "judge"> & {
    judge: Omit<EvalConfig["judge"], "baseUrl"> & { baseUrlEnv: string };
  }>(file);
  const { baseUrlEnv, ...judge } = source.judge;
  if (!baseUrlEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseUrlEnv))
    throw new Error("Invalid judge.baseUrlEnv");
  const baseUrl = env[baseUrlEnv];
  if (!baseUrl) throw new Error(`Missing ${baseUrlEnv}; configure the shared model endpoint in .env`);
  const config: EvalConfig = { ...source, judge: { ...judge, baseUrl } };
  const directory = path.dirname(path.resolve(file));
  config.execution = {
    ...DEFAULT_POLICY,
    concurrency: 4,
    retries: 1,
    retryDelaySeconds: 10,
    initialContextChars: 16000,
    ...(config.execution as Partial<EvalConfig["execution"]>),
  };
  const versions = config.inputs?.versions;
  if (!Array.isArray(versions) || versions.length < 2) throw new Error("至少配置两个输入版本");
  for (const item of versions) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.id) || !["a", "aa"].includes(item.adapter))
      throw new Error("Invalid input version");
    item.path = path.resolve(directory, item.path);
    item.timing_unit ??= config.inputs.timing_unit ?? "ms";
    if (!["ms", "s"].includes(item.timing_unit)) throw new Error("Invalid timing unit");
  }
  for (const key of ["id", "name", "display_name"] as const) {
    const values = versions.map((v) => (key === "display_name" ? v.display_name || v.name : v[key]));
    if (values.some((v) => !v) || new Set(values).size !== values.length)
      throw new Error(`Duplicate or empty ${key}`);
  }
  for (const key of [
    "concurrency",
    "timeoutSeconds",
    "idleTimeoutSeconds",
    "maxToolCalls",
    "codeTimeoutSeconds",
    "maxOutputChars",
    "initialContextChars",
  ] as const) {
    if (!Number.isInteger(config.execution[key]) || config.execution[key] <= 0)
      throw new Error(`Invalid execution.${key}`);
  }
  for (const key of ["retries", "retryDelaySeconds", "repairAttempts"] as const)
    if (!Number.isInteger(config.execution[key]) || config.execution[key] < 0)
      throw new Error(`Invalid execution.${key}`);
  if (
    config.execution.maxTokens !== undefined &&
    (!Number.isInteger(config.execution.maxTokens) || config.execution.maxTokens < 1)
  )
    throw new Error("Invalid execution.maxTokens");
  if (
    !config.judge ||
    !["openai-completions", "openai-responses"].includes(config.judge.api) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.judge.apiKeyEnv)
  )
    throw new Error("Invalid model configuration");
  const base = new URL(config.judge.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid model baseUrl");
  for (const stage of ["correctness", "pairwise"] as const) {
    const model = config.judge[stage];
    if (!model?.model || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(model.thinking))
      throw new Error(`Invalid judge.${stage}`);
    for (const key of ["contextWindow", "maxOutputTokens"] as const)
      if (!Number.isInteger(model[key]) || model[key] <= 0) throw new Error(`Invalid judge.${stage}.${key}`);
  }
  config.outputDir = path.resolve(directory, config.outputDir);
  return config;
}
export function adapt(
  raw: RawInput,
  item: VersionConfig,
  source: string,
  line: number,
  defaultBatch?: string,
): Candidate {
  const meta = raw.meta || {};
  const errors: ValidationIssue[] = [];
  if (raw.request_time !== undefined && raw.request_time !== null &&
      (typeof raw.request_time !== "string" || !raw.request_time.trim()))
    errors.push({ category: "input", code: "request_time_invalid", path: "/request_time", actual: raw.request_time,
      expected: "非空字符串、null 或缺失", message: "request_time 必须是非空字符串或 null" });
  if (raw.has_standard_answer !== undefined && typeof raw.has_standard_answer !== "boolean")
    errors.push({ category: "input", code: "standard_answer_flag_invalid", path: "/has_standard_answer", actual: raw.has_standard_answer,
      expected: "boolean", message: "has_standard_answer 必须是布尔值" });
  const batch = raw.batch_id || meta.batch_id || defaultBatch,
    id = raw.case_id || meta.case_id;
  for (const [key, value] of [["batch_id", batch], ["case_id", id]] as const)
    if (typeof value !== "string" || !value.trim()) errors.push({ category: "input", code: "identity_invalid", path: "/" + key,
      actual: value ?? null, expected: "非空字符串", message: "缺少或无效的 " + key });
  if (errors.length) throw new ValidationError(errors);
  if (raw.version && raw.version !== item.name) throw new Error("输入 version 与配置版本不一致");
  if (raw.case_id && meta.case_id && raw.case_id !== meta.case_id)
    throw new Error("顶层 case_id 与 meta.case_id 冲突");
  const messages = raw.messages;
  if (
    meta.ok === false ||
    !Array.isArray(messages) ||
    !messages.length ||
    messages.some((m) => !m || typeof m !== "object" || Array.isArray(m))
  )
    throw new Error("缺少有效回答或采集失败");
  const supported =
    item.adapter === "a"
      ? ["message", "reasoning", "function_call", "function_call_output"]
      : ["user_question", "llm_turn", "tool_call", "tool_result", "final_answer"];
  if (messages.some((m) => !supported.includes(m.type || "message")))
    throw new Error("链路含未支持的消息类型");
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser < 0) throw new Error("无法定位用户问题");
  const final = messages.findLastIndex(
    (m, i) => i > lastUser && m.role === "assistant" && !!contentText(m.content).trim(),
  );
  if (final < 0) throw new Error("最后一轮没有完整最终回答");
  const content = messages[lastUser].content;
  const question =
    contentText(Array.isArray(content) ? content.slice(0, 1) : content).trim() ||
    String(meta.question || "").trim();
  if (!question || (meta.question && normalize(question) !== normalize(String(meta.question))))
    throw new Error("用户问题为空或 meta.question 不一致");
  const references = raw.has_standard_answer === false
    ? []
    : ["ground_truth", "std_answer"]
        .map((k) => meta[k])
        .filter((v) => v !== null && v !== undefined && v !== "");
  if (new Set(references.map(canonical)).size > 1) throw new Error("ground_truth 与 std_answer 冲突");
  let llm = meta.usage && typeof meta.usage === "object" ? object(meta.usage).type : null;
  if (item.adapter === "aa")
    llm = messages.slice(0, final).findLast((m) => m.type === "llm_turn" && m.model)?.model || llm;
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
    const value = meta[field];
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
    input_id: randomUUID(),
    trace_id: raw.trace_id || meta.trace_id ? String(raw.trace_id || meta.trace_id) : null,
    source,
    line,
    question,
    answer_timing: timing,
    final_index: final,
    reference: references[0] ?? null,
    llm: llm ? String(llm) : null,
  };
}
export function candidateKey(record: Candidate): string {
  return canonical([record.batch_id, record.case_id, record.version]);
}
export function taskKey(task: PlannedTask): string {
  const data = task.data as TaskData, a = data.candidates.A;
  return canonical([a.batch_id, a.case_id, task.stage, data.pair || [a.version]]);
}
export async function buildPlan(config: EvalConfig, previous?: TaskPlan): Promise<TaskPlan> {
  const oldTasks = new Map(previous?.tasks.map((task) => [taskKey(task), task]));
  const oldRecords = new Map((previous?.catalog as Candidate[] | undefined ||
    previous?.tasks.flatMap((task) => Object.values((task.data as TaskData).candidates)) || [])
    .map((record) => [candidateKey(record), record]));
  const records = new Map<string, Candidate>(),
    sourceTexts = new Map<string, string>(),
    inputs: Record<string, unknown> = {},
    cases = new Map<string, [string, string]>(),
    locations = new Map<string, { version: string; source: string; line: number }[]>();
  const issues: { batch_id?: string | null; [key: string]: unknown }[] = [],
    skipped: unknown[] = [],
    seen = new Set<string>(),
    invalid = new Set<string>();
  for (const version of config.inputs.versions) {
    let files: string[];
    try {
      files = await inputFiles(version.path, version.id);
    } catch (error) {
      issues.push({ source: version.path, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "input_file_missing" : "input_file_unreadable", version: version.id,
        errors: [{ category: "file", code: "input_file_unavailable", path: version.path, expected: "可读取的输入文件或目录", actual: (error as NodeJS.ErrnoException).code || null, message: errorText(error) }] });
      continue;
    }
    if (!files.length) {
      issues.push({ source: version.path, reason: "input_file_missing", version: version.id });
      continue;
    }
    for (const source of files) {
      try { if (!sourceTexts.has(source)) sourceTexts.set(source, await readFile(source, "utf8")); }
      catch (error) {
        issues.push({ source, reason: "input_file_unreadable", version: version.id,
          errors: [{ category: "file", code: "input_file_unavailable", path: source, expected: "可读取的输入文件", actual: (error as NodeJS.ErrnoException).code || null, message: errorText(error) }] });
        continue;
      }
      const text = sourceTexts.get(source)!;
      for (const [index, line] of text
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .entries()) {
        if (!line.trim()) continue;
        let key: string | undefined, batchId: string | null = null, caseId: string | null = null;
        try {
          const raw = object(JSON.parse(line)) as RawInput,
            meta = raw.meta || {};
          const batch = raw.batch_id || meta.batch_id || config.inputs.default_batch_id,
            id = raw.case_id || meta.case_id;
          if (
            (batch && config.inputs.batches?.length && !config.inputs.batches.includes(String(batch))) ||
            (id && config.inputs.case_ids?.length && !config.inputs.case_ids.includes(String(id)))
          )
            continue;
          batchId = batch ? String(batch) : null;
          caseId = id ? String(id) : null;
          if (batch && id) {
            key = canonical([String(batch), String(id), version.id]);
            cases.set(canonical([String(batch), String(id)]), [String(batch), String(id)]);
            const sources = locations.get(key) || [];
            sources.push({ version: version.id, source, line: index + 1 });
            locations.set(key, sources);
            if (seen.has(key)) throw new ValidationError([{ category: "input", code: "duplicate_input", path: "/",
              actual: [batch, id, version.id], expected: "每个业务标识仅一条记录", message: "duplicate_input: 同一批次、case、版本出现多条记录" }]);
            seen.add(key);
          }
          const record = adapt(raw, version, source, index + 1, config.inputs.default_batch_id);
          const old = oldRecords.get(candidateKey(record));
          if (old && isDeepStrictEqual(previous?.inputs[old.input_id], raw)) record.input_id = old.input_id;
          if (key && !invalid.has(key)) {
            records.set(key, record);
            inputs[record.input_id] = raw;
          }
        } catch (error) {
          if (key) {
            invalid.add(key);
            records.delete(key);
          }
          issues.push({
            source,
            line: index + 1,
            batch_id: batchId,
            case_id: caseId,
            version: version.id,
            identity: key ? JSON.parse(key) : null,
            ...(key ? { sources: locations.get(key) } : {}),
            reason: errorText(error),
            errors: error instanceof ValidationError ? error.issues : [{ category: "input", code: error instanceof SyntaxError ? "input_json_invalid" : "input_invalid", path: "/", actual: null, expected: "有效输入记录", message: errorText(error) }],
          });
        }
      }
    }
  }
  // Missing or invalid new materials do not erase the last valid snapshot.
  for (const [key, record] of oldRecords) if (!records.has(key)) {
    records.set(key, record);
    inputs[record.input_id] = previous!.inputs[record.input_id];
    cases.set(canonical([record.batch_id, record.case_id]), [record.batch_id, record.case_id]);
  }
  const selected = [...cases.values()]
    .sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1))
    .slice(0, config.inputs.limit);
  const tasks: PlannedTask[] = [],
    checks = new Map<string, PlannedTask>(),
    subjective = new Set<string>(),
    pairCounts: Record<string, number> = {};
  const byBatch = new Map<string, BatchPreflight>();
  function batchStats(batch: string): BatchPreflight {
    if (!byBatch.has(batch)) byBatch.set(batch, {
      cases: 0, valid_inputs: 0, correctness_tasks: 0, pairwise_tasks: 0, skipped_pairs: 0, input_issues: 0,
    });
    return byBatch.get(batch)!;
  }
  let validInputs = 0;
  for (const [batch, id] of selected) {
    const stats = batchStats(batch);
    stats.cases++;
    const available = config.inputs.versions
      .map((v) => records.get(canonical([batch, id, v.id])))
      .filter((r): r is Candidate => !!r);
    validInputs += available.length;
    stats.valid_inputs += available.length;
    const sources = (versions: string[]) => versions.flatMap((version) =>
      locations.get(canonical([batch, id, version])) || [],
    );
    const refs = new Map(
      available.filter((r) => r.reference !== null).map((r) => [canonical(r.reference), r.reference]),
    );
    const reference = refs.values().next().value ?? null;
    const conflict = new Set(available.map((r) => normalize(r.question))).size > 1 || refs.size > 1;
    if (conflict) issues.push({
      batch_id: batch, case_id: id, reason: "question_or_reference_conflict",
      sources: sources(available.map((record) => record.version)),
    });
    for (const pair of ALLOWED_PAIRS) {
      if (!pair.every((v) => config.inputs.versions.some((item) => item.id === v))) continue;
      const values = pair.map((v) => records.get(canonical([batch, id, v])));
      if (conflict || values.some((v) => !v)) {
        stats.skipped_pairs++;
        skipped.push({
          batch_id: batch,
          case_id: id,
          versions: pair,
          reason: conflict ? "case_conflict" : "missing_or_invalid_answer",
          missing: pair.filter((_, i) => !values[i]),
          sources: sources(pair),
        });
        continue;
      }
      const ordered = values as Candidate[];
      const pairKey = canonical([batch, id, "pairwise", pair]);
      const oldPair = oldTasks.get(pairKey), oldData = oldPair?.data as TaskData | undefined;
      if (oldData ? oldData.candidates.A.version !== ordered[0].version : randomInt(2)) ordered.reverse();
      const candidates = { A: ordered[0], B: ordered[1] },
        dependencies: Record<string, string> = {};
      for (const [label, record] of Object.entries(candidates)) {
        if (reference === null) subjective.add(canonical([record.batch_id, record.case_id, record.version]));
        else {
          const data: TaskData = {
            stage: "correctness",
            candidates: { A: record },
            reference,
            initialContextChars: config.execution.initialContextChars,
          };
          const old = oldTasks.get(canonical([batch, id, "correctness", [record.version]]));
          const checkId = old?.id || randomUUID();
          const oldCheck = old?.data as TaskData | undefined;
          data.revision = (oldCheck?.revision || 1) + Number(!!oldCheck &&
            (!isDeepStrictEqual(oldCheck.reference, reference) || oldCheck.candidates.A.input_id !== record.input_id));
          if (!checks.has(checkId)) stats.correctness_tasks++;
          checks.set(checkId, {
            id: checkId,
            stage: "correctness",
            dependencies: {},
            inputIds: { A: record.input_id },
            data,
          });
          dependencies[label] = checkId;
        }
      }
      const data: TaskData = {
        stage: "pairwise",
        candidates,
        reference,
        pair,
        initialContextChars: config.execution.initialContextChars,
        comparisonId: oldData?.comparisonId || "cmp_" + randomUUID(),
        revision: (oldData?.revision || 1) + Number(!!oldData &&
          (!isDeepStrictEqual(oldData.reference, reference) || Object.entries(candidates).some(([label, c]) =>
            c.input_id !== oldData.candidates[label].input_id))),
      };
      tasks.push({
        id: oldPair?.id || randomUUID(),
        stage: "pairwise",
        dependencies,
        inputIds: Object.fromEntries(Object.entries(candidates).map(([k, r]) => [k, r.input_id])),
        data,
      });
      const name = pair.join("__vs__");
      pairCounts[name] = (pairCounts[name] || 0) + 1;
      stats.pairwise_tasks++;
    }
  }
  for (const issue of issues) if (issue.batch_id) batchStats(issue.batch_id).input_issues++;
  const selectedKeys = new Set(selected.map((entry) => canonical(entry)));
  const catalog = [...records.values()].filter((record) => selectedKeys.has(canonical([record.batch_id, record.case_id])));
  const used = new Set(catalog.map((record) => record.input_id));
  return {
    tasks: [...checks.values(), ...tasks],
    inputs: Object.fromEntries(Object.entries(inputs).filter(([id]) => used.has(id))),
    catalog,
    summary: {
      valid_inputs: validInputs,
      cases: selected.length,
      correctness_tasks: checks.size,
      subjective_inputs_skipping_correctness: subjective.size,
      pairwise_tasks: tasks.length,
      allowed_pairs: ALLOWED_PAIRS,
      pair_counts: pairCounts,
      by_batch: Object.fromEntries([...byBatch].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      issues,
      skipped,
    },
  };
}
