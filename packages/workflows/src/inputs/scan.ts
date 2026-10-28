import { fileSourceReader } from "@eval/data";
import { isDeepStrictEqual } from "node:util";
import { canonical, errorText, object, ValidationError } from "@eval/contracts";
import { adapt, candidateKey, scanInputFile } from "./records.js";
import { normalizeInput } from "./normalize.js";
import type { Candidate, EvaluationConfig, RawInput } from "./types.js";

export interface InputScanOptions {
  materializeInputs?: boolean;
  selectRecord?(batch: string | null, caseId: string | null, version: string): boolean;
  prepareRecord?(record: Candidate): void;
}

/** Collect source identities without constructing any workflow tasks. */
export async function collectInputs(config: Pick<EvaluationConfig, "inputs">,
  previous?: { catalog?: Candidate[]; inputs: Record<string, unknown> }, options: InputScanOptions = {}) {
  const oldRecords = new Map((previous?.catalog ?? []).map(record => [candidateKey(record), record]));
  const records = new Map<string, Candidate>(),
    freshRecords = new Set<Candidate>(),
    sourceRevisions = new Map<string, string>(),
    inputs: Record<string, unknown> = {},
    cases = new Map<string, [string, string]>(),
    locations = new Map<string, { version: string; source: string; line: number }[]>(),
    resolvedSources: Record<string, string[]> = {};
  const issues: { batch_id?: string | null; [key: string]: unknown }[] = [],
    seen = new Set<string>(),
    invalid = new Set<string>();
  const scope = config.inputs.records;
  if(scope && new Set(scope.map(row=>canonical([row.model,row.input_file,row.input_index]))).size!==scope.length)throw new Error('输入范围包含重复坐标');
  const scopeRows = scope && new Map(scope.map(row => [canonical([row.model, row.input_file, row.input_index + 1]), row]));
  const foundScope = new Set<string>();
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
        for await (const row of scanInputFile(source, version, config.inputs.default_batch_id, revision)) {
          scanned = true;
          if (!row) continue;
          const { index, batchId, caseId, raw } = row;
          if (scopeRows) {
            const coordinate = canonical([version.id, source, index]), selectedRow = scopeRows.get(coordinate);
            if (!selectedRow) continue;
            if (selectedRow.batch_id !== batchId || selectedRow.case_id !== caseId)
              throw new Error("输入范围与记录身份不一致：" + source + ":" + index);
            foundScope.add(coordinate);
          }
          let key: string | undefined;
          try {
            if (
              (batchId && config.inputs.batches?.length && !config.inputs.batches.includes(batchId)) ||
              (caseId && config.inputs.case_ids?.length && !config.inputs.case_ids.includes(caseId))
            )
              continue;
            if (options.selectRecord && !options.selectRecord(batchId, caseId, version.id)) continue;
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
            const selectedRecord=scopeRows?.get(canonical([version.id,source,index]));
            if(selectedRecord&&'trace_id' in selectedRecord&&selectedRecord.trace_id!==record.trace_id)throw new Error('输入范围与实际trace_id不一致');
            options.prepareRecord?.(record);
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
  if (scopeRows && foundScope.size !== scopeRows.size)
    throw new Error("输入范围存在缺失或已变动的记录，请检查输入文件");
  for (const [key, record] of oldRecords)
    if (!records.has(key)) {
      records.set(key, record);
      if (Object.hasOwn(previous!.inputs, record.input_id))
        inputs[record.input_id] = previous!.inputs[record.input_id];
      cases.set(canonical([record.batch_id, record.case_id]), [record.batch_id, record.case_id]);
    }
  const selected = [...cases.values()]
    .sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1))
    .slice(0, scope ? undefined : config.inputs.limit);
  const selectedKeys = new Set(selected.map(entry => canonical(entry)));
  const catalog = [...records.values()].filter((record) =>
    selectedKeys.has(canonical([record.batch_id, record.case_id])),
  );
  const used = new Set(catalog.map((record) => record.input_id));
  // Retain byte coordinates only; the Host reads a record when preparing an active task.
  const materialize = async () => {
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
              return normalizeInput(raw);
            },
          });
        }
        found.add(index);
      }
      if (found.size !== lines.size) throw new Error("读取期间输入源记录缺失，请重试：" + source);
    }
  };
  for (const id of Object.keys(inputs)) if (!used.has(id)) delete inputs[id];
  return { catalog, inputs, cases: selected, issues, locations, sources: resolvedSources, materialize };
}
