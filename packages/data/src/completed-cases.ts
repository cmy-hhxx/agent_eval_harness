import path from "node:path";
import { readdir } from "node:fs/promises";
import { safeId, type JsonObject } from "@eval/contracts";
import { readJsonl } from "./files.js";
import { businessBatch } from "./business-results.js";

export const completedCaseKey = (stage: string, models: string[], date: string, caseId: string) =>
  JSON.stringify([stage, [...models].sort(), date, caseId]);

/** Final output rows alone decide completion. No receipts, source reads, versions or fingerprints. */
export async function readCompletedCases(root: string, models: string[], pairs: string[][], rubric = false) {
  const completed = new Set<string>();
  const read = async (directory: string, prefix: string, stage: string, versions: string[]) => {
    const files = await readdir(directory).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    for (const name of files) {
      if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
      const date = businessBatch(name.slice(prefix.length, -6));
      for await (const value of readJsonl(path.join(directory, name))) {
        const row = value as JsonObject;
        const meta = (stage === "comparison" ? row.case : row.session_meta) as JsonObject | undefined;
        if (!meta) continue;
        const aliases = [meta.case_id, meta.session_id, meta.trace_id];
        for (const id of aliases) if (typeof id === "string" && id) completed.add(completedCaseKey(stage, versions, date, id));
      }
    }
  };
  for (const model of models) {
    safeId(model);
    await read(path.join(root, model), model + "_attribution-", "attribution-session", [model]);
  }
  for (const models of pairs) {
    models.forEach(safeId);
    const pair = [...models].sort().join("_vs_");
    await read(path.join(root, "comparison", pair), pair + "-", "comparison", models);
  }
  if (rubric) {
    try {
      for await (const value of readJsonl(path.join(root, "rubric.jsonl"))) {
        const row = value as JsonObject;
        if (![row.version, row.batch_id, row.case_id].every(value => typeof value === "string" && value))
          throw new Error("rubric 正式结果缺少模型、批次或 case 身份");
        const key = completedCaseKey("rubric-case", [row.version as string], row.batch_id as string, row.case_id as string);
        if (completed.has(key)) throw new Error("rubric 正式结果重复业务身份：" + key);
        completed.add(key);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return completed;
}
