import { randomUUID } from "node:crypto";
import path from "node:path";
import { safeId } from "@eval/contracts";
import { exists, readJson, readJsonl, writeJson, writeJsonl } from "./files.js";

/** A local catalogue of source locations, separate from raw inputs and run results. */
function inputCatalogDirectory(root: string, datasetId: string): string {
  return path.join(root, safeId(datasetId));
}

export async function saveInputCatalog<T extends object>(
  root: string,
  datasetId: string,
  summary: T,
  records: AsyncIterable<unknown>,
): Promise<T & { records_file: string }> {
  const directory = inputCatalogDirectory(root, datasetId);
  const recordsFile = `records-${randomUUID()}.jsonl`;
  // Publish the pointer last: an interrupted scan never replaces the active catalogue.
  await writeJsonl(path.join(directory, recordsFile), records);
  const published = { ...summary, records_file: recordsFile };
  await writeJson(path.join(directory, "index.json"), published);
  return published;
}

export async function readInputCatalog<T extends { id: string; records_file: string }>(
  root: string,
  datasetId: string,
): Promise<T> {
  const directory = inputCatalogDirectory(root, datasetId);
  const value = await readJson<T>(path.join(directory, "index.json"));
  if (!value || value.id !== datasetId || !/^records-[0-9a-f-]+\.jsonl$/.test(value.records_file) ||
    !(await exists(path.join(directory, value.records_file))))
    throw new Error("输入索引缺失或身份不一致：" + datasetId);
  return value;
}

export async function* readInputCatalogRecords(root: string, datasetId: string, recordsFile: string) {
  if (!/^records-[0-9a-f-]+\.jsonl$/.test(recordsFile)) throw new Error("无效的输入索引记录文件");
  yield* readJsonl(path.join(inputCatalogDirectory(root, datasetId), recordsFile));
}
