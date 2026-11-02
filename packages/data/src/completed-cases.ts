import path from "node:path";
import { readdir } from "node:fs/promises";
import { safeId, type JsonObject } from "@eval/contracts";
import { readJsonl } from "./files.js";

export const completedCaseKey = (stage: string, models: string[], date: string, caseId: string) =>
  JSON.stringify([stage, [...models].sort(), date, caseId]);

/** Final output rows alone decide completion. No receipts, source reads, versions or fingerprints. */
export async function readCompletedCases(root: string, models: string[], pairs: string[][]) {
  const completed = new Set<string>();
  const read = async (directory: string, prefix: string, stage: string, versions: string[]) => {
    const files = await readdir(directory).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    for (const name of files) {
      if (!name.startsWith(prefix) || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name.slice(prefix.length))) continue;
      const date = name.slice(prefix.length, -6);
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
  return completed;
}
