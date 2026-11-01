import { fileSourceReader } from "@eval/data";
import { canonical, errorText, ValidationError, type JsonObject } from "@eval/contracts";
import { adapt, candidateKey, scanInputFile } from "./records.js";
import { normalizeInput } from "./normalize.js";
import type { Candidate, EvaluationConfig, VersionConfig } from "./types.js";

/** One physical input file's admitted records. Candidates stay thin and carry byte coordinates. */
export interface InputShard {
  source: string;
  revision: string;
  candidates: Candidate[];
  issues: JsonObject[];
}

export interface ShardScanOptions {
  /** Thin catalog rows admitted so far; the workflow appends every yielded candidate. */
  catalog(): readonly Candidate[];
  /** Business identities admitted by earlier shards, keyed by batch/case/version. */
  admitted: Set<string>;
  /** Rows still expected by an explicit inputs.records scope. */
  foundScope?: Set<string>;
  /** Fully evaluated physical files by revision; an unchanged file is never read again. */
  completed?: Readonly<Record<string, string>>;
}

interface ScopeRow { batch_id: string; case_id: string; trace_id?: string }

/**
 * Plan one physical source at a time. A file whose rows are already catalogued under the same
 * revision is re-planned from the catalog; only a new or changed file is read again.
 */
export async function* scanInputShards(config: EvaluationConfig, options: ShardScanOptions): AsyncGenerator<InputShard> {
  const scope = config.inputs.records;
  if (scope && new Set(scope.map(row => canonical([row.model, row.input_file, row.input_index]))).size !== scope.length)
    throw new Error("输入范围包含重复坐标");
  const scopeRows = scope && new Map(scope.map(row =>
    [canonical([row.model, row.input_file, row.input_index + 1]), row as unknown as ScopeRow]));
  for (const version of config.inputs.versions) {
    const label = version.sources.map(source => source.path).join(", ");
    let files: string[];
    try {
      files = await fileSourceReader.files(version.sources);
    } catch (error) {
      yield { source: label, revision: "", candidates: [], issues: [fileIssue(label, error)] };
      continue;
    }
    if (!files.length) {
      yield { source: label, revision: "", candidates: [], issues: [{ source: label, reason: "input_file_missing", version: version.id }] };
      continue;
    }
    for (const source of files) {
      const known = options.catalog().filter(candidate => candidate.source === source && candidate.version === version.id);
      const revision = await fileSourceReader.revision(source).catch(() => undefined);
      if (revision === undefined) {
        yield { source, revision: "", candidates: [], issues: [fileIssue(source, new Error("输入文件不可读"))] };
        continue;
      }
      // A finished file keeps its rows in the delivery ledger, not in the state file.
      if (options.completed?.[source] === revision) continue;
      // Rows already catalogued at this revision are planned and bound; only new files are read.
      if (known.some(candidate => candidate.source_revision === revision)) continue;
      if (known.length) throw new Error("输入文件在评测期间发生变化，请重新开始：" + source);
      yield await readShard(source, revision, version, config, options, scopeRows);
    }
  }
  if (scopeRows && options.foundScope && options.foundScope.size !== scopeRows.size)
    throw new Error("输入范围存在缺失或已变动的记录，请检查输入文件");
}

function fileIssue(source: string, error: unknown): JsonObject {
  return {
    source,
    reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "input_file_missing" : "input_file_unreadable",
    errors: [{
      category: "file",
      code: "input_file_unavailable",
      path: source,
      expected: "可读取的输入文件或目录",
      actual: (error as NodeJS.ErrnoException)?.code || null,
      message: errorText(error),
    }],
  };
}

async function readShard(source: string, revision: string, version: VersionConfig, config: EvaluationConfig,
  options: ShardScanOptions, scopeRows: Map<string, ScopeRow> | undefined): Promise<InputShard> {
  const candidates: Candidate[] = [], issues: JsonObject[] = [];
  const previous = new Map(options.catalog().filter(candidate => candidate.source === source)
    .map(candidate => [candidateKey(candidate), candidate]));
  try {
    for await (const row of scanInputFile(source, version, config.inputs.default_batch_id, revision)) {
      if (!row) continue;
      const { index, batchId, caseId } = row;
      let key: string | undefined;
      try {
        if (scopeRows) {
          const coordinate = canonical([version.id, source, index]), selected = scopeRows.get(coordinate);
          if (!selected) continue;
          if (selected.batch_id !== batchId || selected.case_id !== caseId)
            throw new Error("输入范围与记录身份不一致：" + source + ":" + index);
          options.foundScope?.add(coordinate);
        }
        if ((batchId && config.inputs.batches?.length && !config.inputs.batches.includes(batchId)) ||
            (caseId && config.inputs.case_ids?.length && !config.inputs.case_ids.includes(caseId))) continue;
        if (batchId && caseId) {
          key = canonical([batchId, caseId, version.id]);
          if (options.admitted.has(key)) throw new ValidationError([{
            category: "input", code: "duplicate_input", path: "/", actual: [batchId, caseId, version.id],
            expected: "每个业务标识仅一条记录", message: "duplicate_input: 同一批次、case、版本出现多条记录",
          }]);
        }
        if (row.error) throw row.error;
        const record = row.record!;
        record.source_revision = revision;
        const selected = scopeRows?.get(canonical([version.id, source, index]));
        if (selected && "trace_id" in selected && selected.trace_id !== record.trace_id)
          throw new Error("输入范围与实际 trace_id 不一致");
        const old = previous.get(candidateKey(record));
        if (old) { record.input_id = old.input_id; record.released = old.released; }
        if (key) options.admitted.add(key);
        candidates.push(record);
      } catch (error) {
        issues.push({
          source, line: index, batch_id: batchId, case_id: caseId, version: version.id,
          identity: key ? JSON.parse(key) : null,
          reason: errorText(error),
          errors: error instanceof ValidationError ? error.issues : [{
            category: "input", code: error instanceof SyntaxError ? "input_json_invalid" : "input_invalid",
            path: "/", actual: null, expected: "有效输入记录", message: errorText(error),
          }],
        });
      }
    }
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code) throw error;
    issues.push(fileIssue(source, error));
  }
  return { source, revision, candidates, issues };
}

/**
 * Lazy input body per catalog row. Bodies are read from the source byte coordinates on
 * access and evicted past the session window, so the checkpoint never carries them.
 */
export function createInputBindings(config: EvaluationConfig) {
  const window = config.execution.sessionWindow;
  if (!Number.isSafeInteger(window) || window < 1) throw new Error("输入读取需要有效的 sessionWindow");
  const cache = new Map<string, unknown>();
  return (candidates: readonly Candidate[]): Record<string, unknown> => {
    const inputs: Record<string, unknown> = {};
    for (const candidate of candidates) {
      Object.defineProperty(inputs, candidate.input_id, {
        enumerable: true, configurable: true,
        get: () => {
          if (cache.has(candidate.input_id)) {
            const value = cache.get(candidate.input_id);
            cache.delete(candidate.input_id);
            cache.set(candidate.input_id, value);
            return value;
          }
          const value = inputReader(candidate, config);
          cache.set(candidate.input_id, value);
          if (cache.size > window * 2) cache.delete(cache.keys().next().value!);
          return value;
        },
      });
    }
    return inputs;
  };
}

/** Lazy reader for one catalog row; the body never enters the checkpoint. */
export function inputReader(candidate: Candidate, config: EvaluationConfig): unknown {
  const version = config.inputs.versions.find(item => item.id === candidate.version);
  if (!version) throw new Error("Input version is not registered");
  if (candidate.byte_offset === undefined || candidate.byte_length === undefined || !candidate.source_revision)
    throw new Error("输入缺少字节坐标，请重新扫描：" + candidate.input_id);
  const raw = JSON.parse(fileSourceReader.record(candidate.source, candidate.byte_offset, candidate.byte_length, candidate.source_revision));
  const current = adapt(raw as Record<string, unknown>, version, candidate.source, candidate.line, config.inputs.default_batch_id);
  if (candidateKey(current) !== candidateKey(candidate) || current.question !== candidate.question || current.final_index !== candidate.final_index)
    throw new Error("读取期间输入源记录发生变化，请重试：" + candidate.source);
  return normalizeInput(raw as Record<string, unknown>);
}
