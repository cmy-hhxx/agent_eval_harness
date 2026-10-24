import { canonical, object, ValidationError } from "@eval/contracts";
import { fileSourceReader, localFiles, readInputCatalog, readInputCatalogRecords, saveInputCatalog } from "@eval/data";
import { adapt } from "./records.js";
import type { EvaluationConfig, RawInput } from "./types.js";

export interface IndexedInputFile {
  version: string;
  adapter: string;
  source: string;
  bytes: number;
  rows: number;
  valid: number;
  invalid: number;
}
export interface InputDatasetIndex {
  id: string;
  name: string;
  default_batch_id: string;
  files: IndexedInputFile[];
  rows: number;
  valid: number;
  invalid: number;
  records_file: string;
}
export interface IndexedInputRecord {
  file: number;
  line: number;
  byte_offset: number;
  byte_length: number;
  status: "valid" | "invalid";
  batch_id?: string;
  case_id?: string;
  error_code?: string;
}

/** Extract only business coordinates and byte locations; raw messages never enter the catalogue. */
export async function indexDataset(
  config: Pick<EvaluationConfig, "inputs">,
  root: string,
  id: string,
  name: string,
): Promise<InputDatasetIndex> {
  if (!/^[a-z][a-z0-9_]*$/.test(id) || !name.trim())
    throw new Error("评测集需要非空名称及小写字母开头的英文 ID");
  if (config.inputs.default_batch_id !== undefined &&
    (typeof config.inputs.default_batch_id !== "string" || !config.inputs.default_batch_id.trim()))
    throw new Error("评测集的默认批次必须是非空字符串");
  const summary: Omit<InputDatasetIndex, "records_file"> = {
    id, name, default_batch_id: config.inputs.default_batch_id ?? id,
    files: [], rows: 0, valid: 0, invalid: 0,
  };
  const seen = new Set<string>();
  async function* records(): AsyncGenerator<IndexedInputRecord> {
    for (const version of config.inputs.versions) {
      const files = await fileSourceReader.files(version.sources);
      if (!files.length) throw new Error(`输入版本 ${version.id} 没有可索引的文件`);
      for (const source of files) {
        const file: IndexedInputFile = {
          version: version.id, adapter: version.adapter, source,
          bytes: 0, rows: 0, valid: 0, invalid: 0,
        };
        const fileIndex = summary.files.push(file) - 1;
        const revision = await fileSourceReader.revision(source);
        for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(source, revision)) {
          if (!line.trim()) continue;
          file.rows++;
          summary.rows++;
          const location = { file: fileIndex, line: index, byte_offset: byteOffset, byte_length: byteLength };
          try {
            const raw = object(JSON.parse(line)) as RawInput;
            const record = adapt(raw, version, source, index, summary.default_batch_id);
            const key = canonical([record.batch_id, record.case_id, version.id]);
            if (seen.has(key))
              throw new ValidationError([{
                category: "input", code: "duplicate_input", path: "/", actual: null,
                message: "同一评测集内批次、case、版本重复",
              }]);
            seen.add(key);
            file.valid++;
            summary.valid++;
            yield { ...location, status: "valid", batch_id: record.batch_id, case_id: record.case_id };
          } catch (error) {
            file.invalid++;
            summary.invalid++;
            yield {
              ...location,
              status: "invalid",
              error_code: error instanceof ValidationError ? error.issues?.[0]?.code || "input_invalid" :
                error instanceof SyntaxError ? "input_json_invalid" : "input_invalid",
            };
          }
        }
        file.bytes = (await localFiles.stat(source)).size;
      }
    }
  }
  return saveInputCatalog(root, id, summary, records());
}

async function verifyIndex(root: string, index: InputDatasetIndex): Promise<void> {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (typeof index.name !== "string" || !index.name.trim() ||
    typeof index.default_batch_id !== "string" || !index.default_batch_id.trim() ||
    !Array.isArray(index.files) || !index.files.length ||
    ![index.rows, index.valid, index.invalid].every(count) || index.rows !== index.valid + index.invalid ||
    index.files.some((file) =>
      typeof file.version !== "string" || !file.version || typeof file.adapter !== "string" ||
      typeof file.source !== "string" || !file.source ||
      ![file.bytes, file.rows, file.valid, file.invalid].every(count) ||
      file.rows !== file.valid + file.invalid,
    ) ||
    index.rows !== index.files.reduce((sum, file) => sum + file.rows, 0) ||
    index.valid !== index.files.reduce((sum, file) => sum + file.valid, 0) ||
    index.invalid !== index.files.reduce((sum, file) => sum + file.invalid, 0))
    throw new Error("评测集索引汇总无效：" + index.id);
  const counters = index.files.map(() => ({ rows: 0, valid: 0, invalid: 0, line: 0, end: 0 }));
  const seen = new Set<string>();
  let lastFile = 0;
  for await (const value of readInputCatalogRecords(root, index.id, index.records_file)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("评测集索引行无效：" + index.id);
    const row = value as IndexedInputRecord;
    const file = index.files[row.file], current = counters[row.file];
    if (!file || !current || !count(row.file) || row.file < lastFile ||
      !count(row.line) || !row.line || row.line <= current.line ||
      !count(row.byte_offset) || row.byte_offset < current.end ||
      !count(row.byte_length) || !row.byte_length || row.byte_offset + row.byte_length > file.bytes)
      throw new Error("评测集索引行位置无效：" + index.id);
    lastFile = row.file;
    current.rows++;
    current.line = row.line;
    current.end = row.byte_offset + row.byte_length;
    if (row.status === "valid") {
      if (typeof row.batch_id !== "string" || !row.batch_id.trim() ||
        typeof row.case_id !== "string" || !row.case_id.trim())
        throw new Error("评测集索引缺少业务标识：" + index.id);
      const key = canonical([row.batch_id, row.case_id, file.version]);
      if (seen.has(key)) throw new Error("评测集索引业务标识重复：" + index.id);
      seen.add(key);
      current.valid++;
    } else if (row.status === "invalid" && typeof row.error_code === "string" && row.error_code) {
      current.invalid++;
    } else throw new Error("评测集索引行状态无效：" + index.id);
  }
  if (counters.some((actual, i) =>
    actual.rows !== index.files[i]!.rows || actual.valid !== index.files[i]!.valid ||
    actual.invalid !== index.files[i]!.invalid))
    throw new Error("评测集索引记录缺行或计数不一致：" + index.id);
}

/** Check coordinates against the current files, not just the index's own counters. */
async function verifySources(root: string, index: InputDatasetIndex, config: Pick<EvaluationConfig, "inputs">): Promise<void> {
  const rows = readInputCatalogRecords(root, index.id, index.records_file)[Symbol.asyncIterator]();
  try {
    for (const [fileNumber, file] of index.files.entries()) {
      const version = config.inputs.versions.find((item) => item.id === file.version);
      if (!version || version.adapter !== file.adapter)
        throw new Error(`评测集 ${index.id} 的 ${file.version} 未登记或输入适配器与当前配置不一致`);
      try {
        const revision = await fileSourceReader.revision(file.source);
        if ((await localFiles.stat(file.source)).size !== file.bytes) throw new Error("文件字节数变化");
        for await (const { line, index: lineNumber, byteOffset, byteLength } of fileSourceReader.lines(file.source, revision)) {
          if (!line.trim()) continue;
          const { value } = await rows.next();
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("记录行位置或数量变化");
          const row = value as IndexedInputRecord;
          if (row.file !== fileNumber || row.line !== lineNumber ||
            row.byte_offset !== byteOffset || row.byte_length !== byteLength || row.status !== "valid")
            throw new Error("记录行位置或数量变化");
          const candidate = adapt(object(JSON.parse(line)) as RawInput, version, file.source, lineNumber, index.default_batch_id);
          if (candidate.batch_id !== row.batch_id || candidate.case_id !== row.case_id)
            throw new Error("记录业务标识变化");
        }
      } catch (error) {
        throw new Error(`评测集 ${index.id} 的来源已变更或不可用，请重新索引：${file.source}`, { cause: error });
      }
    }
    if (!(await rows.next()).done) throw new Error(`评测集 ${index.id} 的来源缺少索引记录，请重新索引`);
  } finally {
    await rows.return?.();
  }
}

/** Select exact indexed source files, never fall back to the broader model directory. */
export async function selectDatasetInputs<T extends Pick<EvaluationConfig, "inputs">>(config: T, root: string, id: string): Promise<T> {
  const index = await readInputCatalog<InputDatasetIndex>(root, id);
  await verifyIndex(root, index);
  if (index.invalid) throw new Error(`评测集 ${id} 有 ${index.invalid} 条无效输入，请修正后重新索引`);
  if (config.inputs.default_batch_id && config.inputs.default_batch_id !== index.default_batch_id)
    throw new Error(`评测集 ${id} 的默认批次已变更，请重新索引`);
  const versions = config.inputs.versions.flatMap((version) => {
    const files = index.files.filter((file) => file.version === version.id);
    if (!files.length) return [];
    return [{ ...version, sources: files.map((file) => ({ kind: "file" as const, path: file.source })) }];
  });
  await verifySources(root, index, config);
  return {
    ...config,
    inputs: { ...config.inputs, dataset_id: id, default_batch_id: index.default_batch_id, versions },
  };
}
