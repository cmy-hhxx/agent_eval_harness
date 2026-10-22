import path from "node:path";
import { readFile } from "node:fs/promises";
import type { JsonObject } from "@eval/contracts";
import { atomicWrite, runLock } from "./files.js";

export async function readStatisticsLog(file: string, traceId: string): Promise<JsonObject | undefined> {
  const found = (await records(file)).rows.filter((row) => row.traceId === traceId);
  if (found.length > 1) throw new Error("Duplicate statistics traceId: " + traceId);
  return found[0];
}

export async function readStatisticsLogs(file: string): Promise<JsonObject[]> {
  const rows = (await records(file)).rows;
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.traceId !== "string" || !row.traceId) throw new Error("Statistics log record requires traceId");
    if (ids.has(row.traceId)) throw new Error("Duplicate statistics traceId: " + row.traceId);
    ids.add(row.traceId);
  }
  return rows;
}

async function records(file: string) {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
  const rows = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as JsonObject);
  return { text, rows };
}

/** Preserve historical bytes and atomically add one complete snapshot. The caller keeps its receipt in state.json. */
export async function appendStatisticsLog(file: string, record: JsonObject): Promise<JsonObject> {
  if (typeof record.traceId !== "string" || !record.traceId) throw new Error("Statistics log requires traceId");
  const release = await runLock(path.join(path.dirname(file), "." + path.basename(file) + "-lock"));
  try {
    const { text, rows } = await records(file);
    const found = rows.filter((row) => row.traceId === record.traceId);
    if (found.length > 1) throw new Error("Duplicate statistics traceId: " + record.traceId);
    if (found.length) return found[0];
    await atomicWrite(file, text + (text && !text.endsWith("\n") ? "\n" : "") + JSON.stringify(record) + "\n");
    return record;
  } finally { await release(); }
}
