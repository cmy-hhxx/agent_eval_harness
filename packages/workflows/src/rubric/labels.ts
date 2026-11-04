import { readFileSync } from "node:fs";
import type { RubricStandard } from "./catalog.js";

/** Labels are supplied from outside the stage; the rubric judge never classifies a trace. */
export type RubricLabelSource = {mode: "file"; path: string} | {mode: "inline"; paths: string[]};

interface Row { case_id?: unknown; category_id?: unknown; trace_index?: unknown }

export interface RubricLabels {
  byTrace: Map<string, string>;
  byCase: Map<string, string>;
  rows: number;
}

function rows(path: string): Row[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text) as Row[];
  return text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Row);
}

/**
 * The supplied value may be the standard's category id or its exact name; anything else is
 * rejected rather than guessed, so a misaligned label never silently picks another checklist.
 */
export function resolveCategory(standard: RubricStandard, value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const label = value.trim();
  if (/^FIN-L2-[0-9]{3}$/u.test(label)) return standard.categories.has(label) ? label : undefined;
  for (const category of standard.categories.values()) if (category.name === label || category.id === label) return category.id;
  return undefined;
}

/** File form is either a JSON array or JSONL; a row may target one trace or every trace of a case. */
export function readRubricLabels(path: string, standard: RubricStandard): RubricLabels {
  const byTrace = new Map<string, string>(), byCase = new Map<string, string>();
  let count = 0;
  for (const [index, row] of rows(path).entries()) {
    const caseId = row.case_id;
    if (typeof caseId !== "string" || !caseId) throw new Error(`rubric 标签第 ${index + 1} 行缺少 case_id`);
    const category = resolveCategory(standard, row.category_id);
    if (!category) throw new Error(`rubric 标签第 ${index + 1} 行的二级分类不在标准中：${String(row.category_id)}`);
    if (row.trace_index === undefined || row.trace_index === null) {
      if (byCase.has(caseId)) throw new Error(`rubric 标签对 case ${caseId} 重复给出分类`);
      byCase.set(caseId, category);
    } else {
      if (!Number.isSafeInteger(row.trace_index) || (row.trace_index as number) < 0)
        throw new Error(`rubric 标签第 ${index + 1} 行的 trace_index 无效`);
      const key = `${caseId}#${String(row.trace_index)}`;
      if (byTrace.has(key)) throw new Error(`rubric 标签对 ${key} 重复给出分类`);
      byTrace.set(key, category);
    }
    count += 1;
  }
  return {byTrace, byCase, rows: count};
}

export function labelFor(labels: RubricLabels, caseId: string, traceIndex: number): string | undefined {
  return labels.byTrace.get(`${caseId}#${traceIndex}`) ?? labels.byCase.get(caseId);
}

function pick(value: unknown, segments: string[], traceIndex: number): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    const index = segment === "[]" ? traceIndex : segment;
    current = (current as Record<string, unknown>)[String(index)];
  }
  return current;
}

/**
 * Inline labels read the session record the run already materialized. `traces[].meta.subtask`
 * addresses one trace; `meta.subtask` applies to every trace of the case.
 */
export function inlineCategory(standard: RubricStandard, raw: unknown, traceIndex: number, paths: string[]): string | undefined {
  const record = raw as {turns?: unknown[]};
  const source = record.turns ? {...record, traces: record.turns} : raw;
  for (const path of paths) {
    const category = resolveCategory(standard, pick(source, path.replaceAll("[]", ".[]").split("."), traceIndex));
    if (category) return category;
  }
  return undefined;
}
