import { fileSourceReader, problemLibraryFile, readProblemLibrary } from "@eval/data";
import { randomInt, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type PlannedTask, type ProblemLibrary, type TaskPlan, type ValidationIssue } from "@eval/contracts";
import { canonical, errorText, object, ValidationError } from "@eval/contracts";
import { emptyLibrary, projectLibrary } from "@eval/agents/clustering";
import { resolveAdapter } from "./adapters.js";
import type {
  BatchPreflight,
  Candidate,
  EvalConfig,
  RawInput,
  TaskData,
  Timing,
  VersionConfig,
} from "./types.js";

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
export function inputSources(candidates: Candidate[]): Map<string, Candidate[]> {
  const sources = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!sources.has(c.source)) sources.set(c.source, []);
    sources.get(c.source)!.push(c);
  }
  return sources;
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
  const messages = raw.messages;
  if (
    meta.ok === false ||
    !Array.isArray(messages) ||
    !messages.length ||
    messages.some((m) => !m || typeof m !== "object" || Array.isArray(m))
  )
    throw new Error("缺少有效回答或采集失败");
  const adapter = resolveAdapter(item.adapter);
  if (messages.some((m) => !adapter.accepts(m))) throw new Error("链路含未支持的消息类型");
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
  const references =
    raw.has_standard_answer === false
      ? []
      : ["ground_truth", "std_answer"]
          .map((k) => meta[k])
          .filter((v) => v !== null && v !== undefined && v !== "");
  if (new Set(references.map(canonical)).size > 1) throw new Error("ground_truth 与 std_answer 冲突");
  const llm = adapter.answerModel(raw, messages, final);
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
    return candidateKey(record) === candidateKey(candidate) ? { raw, line, record } : undefined;
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
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
/** Business identity for any task, including rewrite tasks that own no input. */
export function taskCase(data: TaskData): { batch_id: string; case_id: string } {
  return data.case ?? { batch_id: data.candidates.A.batch_id, case_id: data.candidates.A.case_id };
}
function taskKey(task: PlannedTask): string {
  const data = task.data as TaskData;
  const comparisonRole = data.verificationPending ? "draft" : data.verificationOf ? "verification" : "standalone";
  if (data.reviewOf) return canonical(["review", data.reviewOf.taskId, task.stage, data.group ?? Object.values(data.candidates).map((c) => c.version), ...(data.stage === "comparison" ? [comparisonRole] : [])]);
  if (data.stage === "criteria") return canonical(["criteria", data.criteriaScope]);
  if (data.stage === "clustering")
    return canonical([data.scope!.batch_id, "clustering", data.scope!.version, data.scope!.shard]);
  if (data.rewriteScope)
    return canonical([data.rewriteScope.batch_id, "rewrite", data.rewriteOf!.taskId]);
  const c = taskCase(data);
  const selector =
    data.stage === "rewrite"
      ? ["rewrite", data.rewriteOf!.taskId]
      : data.group ? [...data.group].sort() : [data.candidates.A.version];
  return canonical([c.batch_id, c.case_id, task.stage, selector, ...(data.stage === "attribution" && data.criteriaScope ? [data.criteriaScope] : []), ...(data.stage === "comparison" ? [comparisonRole] : [])]);
}
/** Batch identity for every stage, including clustering tasks that span cases. */
export function taskIdentity(data: TaskData): { batch_id: string; case_id: string | null } {
  if (data.scope) return { batch_id: data.scope.batch_id, case_id: null };
  if (data.rewriteScope) return { batch_id: data.rewriteScope.batch_id, case_id: null };
  const c = taskCase(data);
  return { batch_id: c.batch_id, case_id: c.case_id };
}
/** Prevent a comparison task from ranking answers of different declared size classes. */
export function assertComparableGroups(config: Pick<EvalConfig, "inputs" | "comparisons">): void {
  for (const version of config.inputs.versions)
    if (version.id.includes("__vs__")) throw new Error("输入版本 ID 不能包含对局保留分隔符 __vs__：" + version.id);
  const tiers = new Map(config.inputs.versions.map((version) => [version.id, version.comparison_tier]));
  for (const group of config.comparisons) {
    if (group.length < 2 || group.length > 3 || new Set(group).size !== group.length)
      throw new Error("对比组必须包含 2–3 个不同候选：" + group.join(" / "));
    const declared = new Set(group.map((id) => tiers.get(id)).filter((tier): tier is string => !!tier));
    if ((group.length === 3 || declared.size) && group.some((id) => !tiers.get(id)))
      throw new Error("对比组每个候选必须明确同档 comparison_tier：" + group.join(" / "));
    if (declared.size > 1)
      throw new Error(`对比组混合了不同模型规模（${[...declared].join(" / ")}）：${group.join(" / ")}`);
  }
}
/** Independent two-way tasks, deduplicated by the unordered business pair. */
export function expandComparisonPairs(groups: readonly (readonly string[])[]): string[][] {
  const pairs: string[][] = [], seen = new Set<string>();
  for (const group of groups) {
    if (group.length < 2 || group.length > 3 || new Set(group).size !== group.length)
      throw new Error("对比组必须包含 2–3 个不同候选：" + group.join(" / "));
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const pair = [group[i]!, group[j]!], key = canonical([...pair].sort());
      if (!seen.has(key)) { seen.add(key); pairs.push(pair); }
    }
  }
  return pairs;
}
/** Narrow configured groups without scheduling the same remaining model set twice. */
export function selectComparisonGroups(groups: readonly string[][], versionIds: readonly string[]): string[][] {
  const allowed = new Set(versionIds), seen = new Set<string>();
  const selected: string[][] = [];
  for (const group of groups) {
    const remaining = group.filter((id) => allowed.has(id));
    if (remaining.length < 2) continue;
    const key = canonical([...remaining].sort());
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(remaining);
  }
  return selected;
}
interface ScannedInput {
  index: number;
  batchId: string | null;
  caseId: string | null;
  record?: Candidate;
  raw?: RawInput;
  error?: unknown;
}
type InputScanner = (source: string, version: VersionConfig, defaultBatch: string | undefined,
  revision: string) => AsyncIterable<ScannedInput | undefined>;

const scanInputFile: InputScanner = async function* (source, version, defaultBatch, revision) {
  for await (const { line, index } of fileSourceReader.lines(source, revision)) {
    if (!line.trim()) { yield undefined; continue; }
    const entry: ScannedInput = { index, batchId: null, caseId: null };
    try {
      const raw = object(JSON.parse(line)) as RawInput, meta = raw.meta || {};
      const batch = raw.batch_id || meta.batch_id || defaultBatch, id = raw.case_id || meta.case_id;
      entry.batchId = batch ? String(batch) : null;
      entry.caseId = id ? String(id) : null;
      entry.record = adapt(raw, version, source, index, defaultBatch);
      entry.raw = raw;
    } catch (error) { entry.error = error; }
    yield entry;
  }
};

/** One dashboard's compact file projections, shared by inventory and read-only planning. */
export function createInputScanCache(): InputScanner {
  const files = new Map<string, { key: string; value: Promise<(ScannedInput | undefined)[]> }>();
  return async function* (source, version, defaultBatch, revision) {
    const id = canonical([source, version.id]);
    const { sources: _sources, ...adapterConfig } = version;
    const key = canonical([adapterConfig, defaultBatch ?? null, revision]);
    let entry = files.get(id);
    if (entry?.key !== key) {
      const value = (async () => {
        const rows: (ScannedInput | undefined)[] = [];
        try {
          for await (const row of scanInputFile(source, version, defaultBatch, revision)) {
            if (!row) { rows.push(undefined); continue; }
            const { raw: _raw, ...projection } = row;
            rows.push(projection);
          }
        } catch (error) {
          // Do not turn a partial read into an ordinary missing-file diagnostic.
          if (rows.length) throw new Error(errorText(error), { cause: error });
          throw error;
        }
        return rows;
      })();
      entry = { key, value };
      files.set(id, entry);
    }
    try {
      // A concurrent inventory request may have populated this entry earlier in the request.
      const rows = await entry.value;
      if (await fileSourceReader.revision(source) !== revision)
        throw new Error("读取期间输入文件发生变化，请重试：" + source);
      for (const row of rows) yield row && { ...row, ...(row.record ? { record: { ...row.record } } : {}) };
    } catch (error) {
      if (files.get(id) === entry) files.delete(id);
      throw error;
    }
  };
}

export interface PlanOptions {
  acceptedTaskIds?: ReadonlySet<string>;
  /** Skip raw input materialization when only task counts or summaries are needed. */
  materializeInputs?: boolean;
  /** Compact projections are for new read-only previews, never execution or reconciliation. */
  scanFile?: InputScanner;
}
export async function buildPlan(
  config: EvalConfig,
  previous?: TaskPlan,
  options: PlanOptions = {},
): Promise<TaskPlan> {
  const accepted = options.acceptedTaskIds ?? new Set<string>();
  assertComparableGroups(config);
  const comparisonPairs = expandComparisonPairs(config.comparisons);
  // A persisted standalone task remains an executable current definition. Reconciliation
  // retains it; planning a second definition for its pair would duplicate formal delivery.
  const retainedPairs = new Set((previous?.tasks ?? []).filter(task => task.stage === "comparison" &&
    !(task.data as TaskData).verificationPending &&
    (accepted.has(task.id) || (!(task.data as TaskData).verificationOf && !(task.data as TaskData).supersededBy)))
    .flatMap((task) => {
      const data = task.data as TaskData, identity = taskCase(data), group = data.group!;
      return group.flatMap((first, index) => group.slice(index + 1).map((second) =>
        canonical([identity.batch_id, identity.case_id, [first, second].sort()])));
    }));
  if (options.scanFile && (options.materializeInputs !== false || previous))
    throw new Error("输入扫描索引仅用于新运行的只读预检");
  const oldTasks = new Map(previous?.tasks.map((task) => [taskKey(task), task]));
  const oldRecords = new Map(
    (
      (previous?.catalog as Candidate[] | undefined) ||
      previous?.tasks.flatMap((task) => Object.values((task.data as TaskData).candidates)) ||
      []
    ).map((record) => [candidateKey(record), record]),
  );
  const records = new Map<string, Candidate>(),
    freshRecords = new Set<Candidate>(),
    sourceRevisions = new Map<string, string>(),
    inputs: Record<string, unknown> = {},
    cases = new Map<string, [string, string]>(),
    locations = new Map<string, { version: string; source: string; line: number }[]>(),
    resolvedSources: Record<string, string[]> = {};
  const issues: { batch_id?: string | null; [key: string]: unknown }[] = [],
    skipped: unknown[] = [],
    seen = new Set<string>(),
    invalid = new Set<string>();
  for (const version of config.inputs.versions) {
    const label = version.sources.map((source) => source.path).join(", ");
    let files: string[];
    try {
      files = await fileSourceReader.files(version.sources);
    } catch (error) {
      issues.push({
        source: label,
        reason:
          (error as NodeJS.ErrnoException).code === "ENOENT" ? "input_file_missing" : "input_file_unreadable",
        version: version.id,
        errors: [
          {
            category: "file",
            code: "input_file_unavailable",
            path: label,
            expected: "可读取的输入文件或目录",
            actual: (error as NodeJS.ErrnoException).code || null,
            message: errorText(error),
          },
        ],
      });
      continue;
    }
    if (!files.length) {
      issues.push({
        source: label,
        reason: "input_file_missing",
        version: version.id,
      });
      continue;
    }
    resolvedSources[version.id] = files;
    for (const source of files) {
      let scanned = false;
      try {
        const revision = sourceRevisions.get(source) ?? await fileSourceReader.revision(source);
        sourceRevisions.set(source, revision);
        for await (const row of (options.scanFile ?? scanInputFile)(source, version, config.inputs.default_batch_id, revision)) {
          scanned = true;
          if (!row) continue;
          const { index, batchId, caseId, raw } = row;
          let key: string | undefined;
          try {
            if (
              (batchId && config.inputs.batches?.length && !config.inputs.batches.includes(batchId)) ||
              (caseId && config.inputs.case_ids?.length && !config.inputs.case_ids.includes(caseId))
            )
              continue;
            if (batchId && caseId) {
              key = canonical([batchId, caseId, version.id]);
              cases.set(canonical([batchId, caseId]), [batchId, caseId]);
              const sources = locations.get(key) || [];
              sources.push({ version: version.id, source, line: index });
              locations.set(key, sources);
              if (seen.has(key))
                throw new ValidationError([
                  {
                    category: "input",
                    code: "duplicate_input",
                    path: "/",
                    actual: [batchId, caseId, version.id],
                    expected: "每个业务标识仅一条记录",
                    message: "duplicate_input: 同一批次、case、版本出现多条记录",
                  },
                ]);
              seen.add(key);
            }
            if (row.error) throw row.error;
            const record = row.record!;
            const old = oldRecords.get(candidateKey(record));
            let unchanged = old?.source === record.source && old?.line === record.line;
            if (old && Object.hasOwn(previous!.inputs, old.input_id)) {
              try { unchanged = isDeepStrictEqual(previous!.inputs[old.input_id], raw); }
              // A lazy prior plan cannot read the old body after a source rewrite. Its
              // registered business identity still survives reordered or appended rows.
              catch { unchanged = true; }
            }
            if (
              old &&
              unchanged
            )
              record.input_id = old.input_id;
            if (key && !invalid.has(key)) {
              records.set(key, record);
              freshRecords.add(record);
            }
          } catch (error) {
            if (key) {
              invalid.add(key);
              records.delete(key);
            }
            issues.push({
              source,
              line: index,
              batch_id: batchId,
              case_id: caseId,
              version: version.id,
              identity: key ? JSON.parse(key) : null,
              ...(key ? { sources: locations.get(key) } : {}),
              reason: errorText(error),
              errors:
                error instanceof ValidationError
                  ? error.issues
                  : [
                      {
                        category: "input",
                        code: error instanceof SyntaxError ? "input_json_invalid" : "input_invalid",
                        path: "/",
                        actual: null,
                        expected: "有效输入记录",
                        message: errorText(error),
                      },
                    ],
            });
          }
        }
      } catch (error) {
        // A mid-read failure cannot leave partly registered candidates in the plan.
        if (scanned || !(error as NodeJS.ErrnoException).code) throw error;
        issues.push({
          source,
          reason: "input_file_unreadable",
          version: version.id,
          errors: [{
            category: "file",
            code: "input_file_unavailable",
            path: source,
            expected: "可读取的输入文件",
            actual: (error as NodeJS.ErrnoException).code || null,
            message: errorText(error),
          }],
        });
      }
    }
  }
  // Keep registered work on invalid scans; the caller must not run it without its original material.
  for (const [key, record] of oldRecords)
    if (!records.has(key)) {
      records.set(key, record);
      if (Object.hasOwn(previous!.inputs, record.input_id))
        inputs[record.input_id] = previous!.inputs[record.input_id];
      cases.set(canonical([record.batch_id, record.case_id]), [record.batch_id, record.case_id]);
    }
  const selected = [...cases.values()]
    .sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1))
    .slice(0, config.inputs.limit);
  // Read each model's problem library once; clustering tasks get its projection and budget headroom.
  const libraries = new Map<string, ProblemLibrary>();
  if (config.clustering.enabled)
    for (const version of config.inputs.versions) {
      const file = problemLibraryFile(config.problemLibrary, version.id);
      libraries.set(version.id, (await readProblemLibrary(file)) ?? emptyLibrary(version.id));
    }
  const tasks: PlannedTask[] = [],
    criteriaTasks = new Map<string, PlannedTask>(),
    checks = new Map<string, PlannedTask>(),
    rewrites = new Map<string, PlannedTask>(),
    groupCounts: Record<string, number> = {};
  /** One polish task per accepted source result; rewrite tasks own no input material. */
  function addRewrite(
    sourceStage: "attribution" | "comparison" | "clustering",
    sourceTaskId: string,
    resultId: string,
    context: Pick<TaskData, "case" | "rewriteScope">,
    revision: number,
    names: Record<string, string>,
  ) {
    if (!config.rewrite[sourceStage]) return;
    if (rewrites.has(sourceTaskId)) return;
    const key = context.rewriteScope
      ? canonical([context.rewriteScope.batch_id, "rewrite", sourceTaskId])
      : canonical([context.case!.batch_id, context.case!.case_id, "rewrite", ["rewrite", sourceTaskId]]);
    const old = oldTasks.get(key);
    rewrites.set(sourceTaskId, {
      id: old?.id || randomUUID(),
      stage: "rewrite",
      dependencies: { source: sourceTaskId },
      inputIds: {},
      data: {
        stage: "rewrite",
        candidates: {},
        reference: null,
        rewriteOf: { stage: sourceStage, taskId: sourceTaskId, resultId },
        rewriteNames: names,
        ...((old?.data as TaskData | undefined)?.comparisonRewriteScope
          ? { comparisonRewriteScope: (old!.data as TaskData).comparisonRewriteScope } : {}),
        ...((old?.data as TaskData | undefined)?.rewriteSlotIds
          ? { rewriteSlotIds: (old!.data as TaskData).rewriteSlotIds } : {}),
        ...(sourceStage === "comparison" && config.rewrite.comparisonItems && !accepted.has(old?.id ?? "")
          ? { comparisonRewriteScope: "all" as const } : {}),
        ...context,
        revision,
      },
    });
  }
  const byBatch = new Map<string, BatchPreflight>();
  function batchStats(batch: string): BatchPreflight {
    if (!byBatch.has(batch))
      byBatch.set(batch, {
        cases: 0,
        valid_inputs: 0,
        attribution_tasks: 0,
        comparison_tasks: 0,
        comparison_verification_tasks: 0,
        skipped_groups: 0,
        input_issues: 0,
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
    const sources = (versions: string[]) =>
      versions.flatMap((version) => locations.get(canonical([batch, id, version])) || []);
    // A single known reference propagates across the same question. Conflicting
    // references form separate scopes; an unreferenced answer never switches
    // standards depending on which opponent happens to be in the pair.
    const scopeOf = (record: Candidate) => {
      const matching = available.filter((other) => normalize(other.question) === normalize(record.question));
      const refs = new Map(matching.filter((other) => other.reference !== null)
        .map((other) => [canonical(other.reference), other.reference]));
      return { question: normalize(record.question), reference: refs.size === 1 ? refs.values().next().value : record.reference };
    };
    for (const group of comparisonPairs) {
      if (!group.every((v) => config.inputs.versions.some((item) => item.id === v))) continue;
      if (retainedPairs.has(canonical([batch, id, [...group].sort()]))) continue;
      const values = group.map((v) => records.get(canonical([batch, id, v])));
      const present = values.filter((value): value is Candidate => !!value);
      const refs = new Map(present.map(scopeOf).map((scope) => [canonical(scope.reference), scope.reference]));
      const reference = refs.values().next().value ?? null;
      const conflict = new Set(present.map((record) => normalize(record.question))).size > 1 || refs.size > 1;
      if (conflict) issues.push({ batch_id: batch, case_id: id, versions: group,
        reason: "question_or_reference_conflict", sources: sources(group) });
      if (conflict || values.some((v) => !v)) {
        stats.skipped_groups++;
        skipped.push({
          batch_id: batch,
          case_id: id,
          versions: group,
          reason: conflict ? "case_conflict" : "missing_or_invalid_answer",
          missing: group.filter((_, i) => !values[i]),
          sources: sources(group),
        });
        continue;
      }
      const groupKey = canonical([batch, id, "comparison", [...group].sort(), "draft"]);
      const verificationKey = canonical([batch, id, "comparison", [...group].sort(), "verification"]);
      const oldGroup = oldTasks.get(groupKey),
        oldData = oldGroup?.data as TaskData | undefined;
      let ordered: Candidate[] = [];
      if (oldData) {
        const byVersion = new Map((values as Candidate[]).map((candidate) => [candidate.version, candidate]));
        ordered = Object.keys(oldData.candidates)
          .sort()
          .map((label) => byVersion.get(oldData.candidates[label]!.version)!)
          .filter((candidate): candidate is Candidate => !!candidate);
      }
      if (ordered.length !== values.length) {
        ordered = [...(values as Candidate[])];
        for (let i = ordered.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
        }
      }
      if (ordered.length > LABELS.length) throw new Error("对比组候选数超过盲测标签容量");
      const candidates = Object.fromEntries(ordered.map((candidate, i) => [LABELS[i]!, candidate])),
        dependencies: Record<string, string> = {};
      const rubricCandidates = available.filter((record) => {
        const scope = scopeOf(record);
        return scope.question === normalize(ordered[0]!.question) && isDeepStrictEqual(scope.reference, reference) &&
          comparisonPairs.some((pair) => pair.includes(record.version));
      }).sort((a, b) => a.version.localeCompare(b.version));
      const criteriaScope = canonical([batch, id, rubricCandidates.map((c) => c.version)]);
      let criteria = criteriaTasks.get(criteriaScope);
      if (!criteria) {
        const old = oldTasks.get(canonical(["criteria", criteriaScope]));
        const changed = !!old && (!isDeepStrictEqual((old.data as TaskData).reference, reference) ||
          rubricCandidates.some((candidate, i) => {
            const prior = (old.data as TaskData).candidates[LABELS[i]!];
            return candidate.input_id !== prior?.input_id || candidate.question !== prior.question ||
              candidate.final_index !== prior.final_index;
          }));
        criteria = {
          id: old && !(changed && accepted.has(old.id)) ? old.id : randomUUID(), stage: "criteria", dependencies: {},
          inputIds: Object.fromEntries(rubricCandidates.map((c, i) => [LABELS[i]!, c.input_id])),
          data: { stage: "criteria", candidates: Object.fromEntries(rubricCandidates.map((c, i) => [LABELS[i]!, c])),
            reference, criteriaScope, revision: old && !accepted.has(old.id)
              ? ((old.data as TaskData).revision ?? 1) + Number(changed) : 1 },
        };
        criteriaTasks.set(criteriaScope, criteria);
      }
      dependencies.criteria = criteria.id;
      for (const [label, record] of Object.entries(candidates)) {
        const checkKey = canonical([batch, id, "attribution", [record.version], criteriaScope]);
        const existing = checks.get(checkKey);
        if (existing) {
          dependencies[label] = existing.id;
          continue;
        }
        const acceptedCheck = previous?.tasks.find((task) => task.stage === "attribution" && accepted.has(task.id) &&
          (task.data as TaskData).candidates.A.input_id === record.input_id);
        if (acceptedCheck) {
          checks.set(checkKey, acceptedCheck);
          dependencies[label] = acceptedCheck.id;
          stats.attribution_tasks++;
          continue;
        }
        const data: TaskData = {
          stage: "attribution",
          // Internal slot only; attribution materials and tools use `answer`.
          candidates: { A: record },
          reference,
          criteriaScope,
          initialContextChars: config.execution.initialContextChars,
        };
        const old = oldTasks.get(checkKey);
        const checkId = old?.id || randomUUID();
        const oldCheck = old?.data as TaskData | undefined;
        data.revision =
          (oldCheck?.revision || 1) +
          Number(
            !!oldCheck &&
              (!isDeepStrictEqual(oldCheck.reference, reference) ||
                oldCheck.candidates.A.input_id !== record.input_id),
          );
        stats.attribution_tasks++;
        checks.set(checkKey, {
          id: checkId,
          stage: "attribution",
          dependencies: { criteria: criteria.id },
          inputIds: { answer: record.input_id },
          data,
        });
        addRewrite(
          "attribution",
          checkId,
          checkId,
          { case: { batch_id: record.batch_id, case_id: record.case_id, question: record.question } },
          data.revision || 1,
          { A: record.name },
        );
        dependencies[label] = checkId;
      }
      const data: TaskData = {
        stage: "comparison",
        verificationPending: true,
        candidates,
        reference,
        criteriaScope,
        group,
        initialContextChars: config.execution.initialContextChars,
        comparisonId: oldData?.comparisonId || "cmp_" + randomUUID(),
        revision:
          (oldData?.revision || 1) +
          Number(
            !!oldData &&
              (!isDeepStrictEqual(oldData.reference, reference) ||
                Object.entries(candidates).some(
                  ([label, c]) => c.input_id !== oldData.candidates[label]!.input_id,
                )),
          ),
      };
      const comparisonTask: PlannedTask = {
        id: oldGroup?.id || randomUUID(),
        stage: "comparison",
        dependencies,
        inputIds: Object.fromEntries(Object.entries(candidates).map(([k, r]) => [k, r.input_id])),
        data,
      };
      const oldVerification = oldTasks.get(verificationKey);
      const { verificationPending: _pending, ...verificationData } = data;
      const verification: PlannedTask = { ...comparisonTask, id: oldVerification?.id || randomUUID(),
        dependencies: { ...dependencies, draft: comparisonTask.id },
        data: { ...verificationData, verificationOf: { taskId: comparisonTask.id } } satisfies TaskData };
      tasks.push(comparisonTask, verification);
      addRewrite(
        "comparison",
        verification.id,
        data.comparisonId!,
        { case: { batch_id: batch, case_id: id, question: ordered[0]!.question } },
        data.revision || 1,
        Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.name])),
      );
      const name = group.join("+");
      groupCounts[name] = (groupCounts[name] || 0) + 1;
      stats.comparison_tasks++;
      stats.comparison_verification_tasks++;
    }
  }
  // Clustering groups the batch's attribution receipts per model; shards bound prompt and output size.
  const clusteringTasks: PlannedTask[] = [];
  if (config.clustering.enabled) {
    interface CasePlan {
      input_id: string;
      case_id: string;
      source: string;
      line: number;
      task_id: string;
      revision: number;
    }
    interface Shard {
      version: string;
      batch_id: string;
      shard: number;
      cases: CasePlan[];
    }
    const grouped = new Map<string, { version: string; batch_id: string; cases: CasePlan[] }>();
    // Retained pairs do not appear in this planning pass's local tasks. Their active
    // current definitions still gate new clustering shards, including a pending followup.
    const activeComparisons = [...new Map([...(previous?.tasks ?? []), ...tasks]
      .filter(task => task.stage === "comparison").map(task => [task.id, task])).values()]
      .filter(task => !(task.data as TaskData).verificationPending && !(task.data as TaskData).supersededBy);
    const referencedAttributions = new Set(activeComparisons.flatMap(task => Object.keys((task.data as TaskData).candidates)
      .map(label => task.dependencies[label])));
    const comparedInputs = new Set(activeComparisons.flatMap(task => Object.values(task.inputIds)));
    const acceptedClusters = (previous?.tasks ?? []).filter((task) => task.stage === "clustering" && accepted.has(task.id));
    const covered = new Set(acceptedClusters.flatMap((task) => Object.values(task.dependencies)));
    const retained = (previous?.tasks ?? []).filter((task) => task.stage === "attribution" && accepted.has(task.id));
    const attributions = new Map([...checks.values(), ...retained].map((task) => [task.id, task]));
    for (const task of attributions.values()) {
      if (covered.has(task.id)) continue;
      const data = task.data as TaskData,
        candidate = data.candidates.A;
      if (comparedInputs.has(candidate.input_id) && !referencedAttributions.has(task.id)) continue;
      const key = canonical([candidate.version, candidate.batch_id]);
      const entry = grouped.get(key) ?? {
        version: candidate.version,
        batch_id: candidate.batch_id,
        cases: [],
      };
      entry.cases.push({
        input_id: candidate.input_id,
        case_id: candidate.case_id,
        source: candidate.source,
        line: candidate.line,
        task_id: task.id,
        revision: data.revision || 1,
      });
      grouped.set(key, entry);
    }
    const shards: Shard[] = [];
    for (const entry of [...grouped.values()].sort((a, b) =>
      canonical([a.version, a.batch_id]) < canonical([b.version, b.batch_id]) ? -1 : 1,
    )) {
      entry.cases.sort((a, b) =>
        canonical([a.case_id, a.input_id]) < canonical([b.case_id, b.input_id]) ? -1 : 1,
      );
      const size = config.clustering.maxCasesPerTask;
      const firstShard = 1 + Math.max(-1, ...acceptedClusters.map((task) => (task.data as TaskData).scope!)
        .filter((scope) => scope.version === entry.version && scope.batch_id === entry.batch_id).map((scope) => scope.shard));
      for (let index = 0; index * size < entry.cases.length; index++)
        shards.push({
          version: entry.version,
          batch_id: entry.batch_id,
          shard: firstShard + index,
          cases: entry.cases.slice(index * size, (index + 1) * size),
        });
    }
    const shardCount = new Map<string, number>(),
      shardIndex = new Map<string, number>();
    for (const shard of shards)
      shardCount.set(shard.version, (shardCount.get(shard.version) ?? 0) + 1);
    for (const shard of shards) {
      const library = libraries.get(shard.version)!;
      const activeClasses = Object.values(library.classes).filter(
        (problem) => problem.status === "active",
      ).length;
      const activeComponents = Object.keys(library.components).length;
      const count = shardCount.get(shard.version)!,
        index = shardIndex.get(shard.version) ?? 0;
      shardIndex.set(shard.version, index + 1);
      // Reserve the run's whole headroom across shards so concurrent tasks cannot exceed the cap.
      const share = (total: number) =>
        Math.floor(total / count) + (index < total % count ? 1 : 0);
      const old = oldTasks.get(canonical([shard.batch_id, "clustering", shard.version, shard.shard]));
      clusteringTasks.push({
        id: old?.id || randomUUID(),
        stage: "clustering",
        dependencies: Object.fromEntries([
          ...shard.cases.map((entry) => [entry.input_id, entry.task_id]),
          ...activeComparisons.filter(comparison => shard.cases.some(entry => Object.values(comparison.inputIds).includes(entry.input_id)))
            .map((comparison) => ["comparison:" + comparison.id, comparison.id]),
        ]),
        inputIds: {},
        data: {
          stage: "clustering",
          candidates: {},
          reference: null,
          projection: projectLibrary(library),
          scope: {
            version: shard.version,
            batch_id: shard.batch_id,
            shard: shard.shard,
            cases: Object.fromEntries(
              shard.cases.map((entry) => [
                entry.input_id,
                { case_id: entry.case_id, source: { file: entry.source, line: entry.line } },
              ]),
            ),
            budget: {
              active_classes: activeClasses,
              max_classes: config.clustering.maxClassesPerModel,
              max_new_classes: Math.min(
                config.clustering.maxNewClassesPerTask,
                share(Math.max(0, config.clustering.maxClassesPerModel - activeClasses)),
              ),
              active_components: activeComponents,
              max_components: config.clustering.maxComponentsPerModel,
              // Bind narrows this to the components the task's observations actually use.
              max_new_components: share(Math.max(0, config.clustering.maxComponentsPerModel - activeComponents)),
              consolidate: activeClasses >= config.clustering.consolidateAt,
              min_support: config.clustering.minSupport,
            },
          },
          revision: Math.max(...shard.cases.map((entry) => entry.revision), 1),
        },
      });
      const task = clusteringTasks.at(-1)!;
      const version = config.inputs.versions.find((item) => item.id === shard.version)!;
      addRewrite("clustering", task.id, task.id, {
        rewriteScope: { batch_id: shard.batch_id, model: version.display_name || version.name },
      }, (task.data as TaskData).revision!, {});
    }
  }
  for (const issue of issues) if (issue.batch_id) batchStats(issue.batch_id).input_issues++;
  const selectedKeys = new Set(selected.map((entry) => canonical(entry)));
  const catalog = [...records.values()].filter((record) =>
    selectedKeys.has(canonical([record.batch_id, record.case_id])),
  );
  const used = new Set(catalog.map((record) => record.input_id));
  // Retain byte coordinates only; the Host reads a record when preparing an active task.
  if (config.comparisons.length && options.materializeInputs !== false) {
    const bySource = new Map<string, Map<number, Candidate[]>>();
    for (const record of catalog) {
      if (!freshRecords.has(record)) continue;
      const lines = bySource.get(record.source) ?? new Map<number, Candidate[]>();
      lines.set(record.line, [...(lines.get(record.line) ?? []), record]);
      bySource.set(record.source, lines);
    }
    for (const [source, lines] of bySource) {
      const found = new Set<number>();
      for await (const { index, byteOffset, byteLength } of fileSourceReader.lines(source, sourceRevisions.get(source)!)) {
        const candidates = lines.get(index);
        if (!candidates) continue;
        for (const candidate of candidates) {
          const version = config.inputs.versions.find((item) => item.id === candidate.version)!;
          Object.defineProperty(inputs, candidate.input_id, {
            enumerable: true,
            configurable: true,
            get() {
              const raw = object(JSON.parse(fileSourceReader.record(source, byteOffset, byteLength, sourceRevisions.get(source)!))) as RawInput;
              const current = adapt(raw, version, source, index, config.inputs.default_batch_id);
              if (candidateKey(current) !== candidateKey(candidate) || current.question !== candidate.question || current.final_index !== candidate.final_index)
                throw new Error("读取期间输入源记录发生变化，请重试：" + source);
              return raw;
            },
          });
        }
        found.add(index);
      }
      if (found.size !== lines.size) throw new Error("读取期间输入源记录缺失，请重试：" + source);
    }
  }
  for (const id of Object.keys(inputs)) if (!used.has(id)) delete inputs[id];
  return {
    tasks: [...criteriaTasks.values(), ...checks.values(), ...tasks, ...clusteringTasks, ...rewrites.values()],
    inputs,
    catalog,
    summary: {
      valid_inputs: validInputs,
      cases: selected.length,
      criteria_tasks: criteriaTasks.size,
      attribution_tasks: checks.size,
      comparison_tasks: tasks.filter(task => !(task.data as TaskData).verificationPending).length,
      comparison_verification_tasks: tasks.filter(task => !!(task.data as TaskData).verificationOf).length,
      rewrite_tasks: rewrites.size,
      clustering_tasks: clusteringTasks.length,
      comparisons: config.comparisons,
      group_counts: groupCounts,
      sources: resolvedSources,
      by_batch: Object.fromEntries([...byBatch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      issues,
      skipped,
    },
  };
}
