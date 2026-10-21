import { isDeepStrictEqual } from "node:util";
import { rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { object } from "@eval/contracts";
import { readJsonl, writeJsonl } from "./files.js";
import { fileSourceReader } from "./sources.js";

export type CaseMetadata = ReadonlyMap<string, Record<string, unknown>>;

/** A source-owned supplement; case IDs bind labels without matching question text. */
export async function readCaseMetadata(file: string): Promise<CaseMetadata> {
  const entries = new Map<string, Record<string, unknown>>();
  try {
    for await (const value of readJsonl(file)) {
      const row = object(value), meta = object(row.meta);
      if (typeof row.case_id !== "string" || !row.case_id ||
          typeof meta._testset_name !== "string" || typeof meta._original_case_id !== "string" ||
          row.case_id !== `${meta._testset_name}_${meta._original_case_id}`)
        throw new Error("Case metadata identity is invalid");
      if (entries.has(row.case_id)) throw new Error("Duplicate case metadata: " + row.case_id);
      entries.set(row.case_id, meta);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entries;
}

function fillMissing(existing: Record<string, unknown>, supplied: Record<string, unknown>, location: string) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(supplied)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe metadata key");
    if (!Object.hasOwn(existing, key)) merged[key] = value;
    else if (existing[key] && value && typeof existing[key] === "object" && typeof value === "object" &&
        !Array.isArray(existing[key]) && !Array.isArray(value))
      merged[key] = fillMissing(object(existing[key]), object(value), `${location}.${key}`);
    else if (!isDeepStrictEqual(existing[key], value)) throw new Error("Metadata conflict: " + `${location}.${key}`);
  }
  return merged;
}

/** Retain every existing metadata value; the supplement belongs under meta.info. */
export function completeCaseMetadata<T extends Record<string, unknown>>(row: T, entries: CaseMetadata): T {
  const meta = object(row.meta ?? {}), caseId = row.case_id ?? meta.case_id;
  const supplied = entries.get(String(caseId));
  if (!supplied) return row;
  if (row.case_id && meta.case_id && row.case_id !== meta.case_id)
    throw new Error("Input case metadata identity conflict");
  for (const key of ["item_id", "testset_name"]) {
    const expected = supplied[key === "testset_name" ? "_testset_name" : key];
    if (meta[key] !== undefined && expected !== undefined && meta[key] !== expected)
      throw new Error("Input metadata identity conflict: " + key);
  }
  if (Object.hasOwn(meta, "info") && (!meta.info || typeof meta.info !== "object" || Array.isArray(meta.info)))
    throw new Error("Metadata conflict: " + `${caseId}.meta.info`);
  const info = fillMissing(object(meta.info ?? {}), supplied, `${caseId}.meta.info`);
  if (isDeepStrictEqual(meta.info, info)) return row;
  return { ...row, meta: { ...meta, info } };
}

/** Call only for staging files or while the source has no active readers. */
export async function completeInputMetadata(file: string, entries: CaseMetadata, signal: AbortSignal) {
  const result = { rows: 0, matched: 0, changed: 0 };
  if (!entries.size) return result;
  const revision = await fileSourceReader.revision(file), temporary = `${file}.metadata-${randomUUID()}`;
  try {
    await writeJsonl(temporary, (async function* () {
      for await (const { line } of fileSourceReader.lines(file, revision)) {
        signal.throwIfAborted();
        if (!line.trim()) continue;
        const row = object(JSON.parse(line)), meta = object(row.meta ?? {});
        result.rows++;
        if (entries.has(String(row.case_id ?? meta.case_id))) result.matched++;
        const completed = completeCaseMetadata(row, entries);
        if (completed !== row) result.changed++;
        yield completed;
      }
    })());
    signal.throwIfAborted();
    if (await fileSourceReader.revision(file) !== revision) throw new Error("Input changed during metadata completion");
    if (result.changed) await rename(temporary, file);
    return result;
  } finally { await rm(temporary, { force: true }); }
}
