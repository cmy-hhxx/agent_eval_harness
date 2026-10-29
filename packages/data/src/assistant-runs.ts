import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCollection } from "@eval/contracts";
import { readJson } from "./files.js";
import { evaluationCollectionPath } from "./evaluation-collections.js";

export interface AssistantRunLocation { collectionId: string; runId: string; directory: string; workflow: "comparison" | "attribution" }
/** Only inspect configured output roots and their task/run directories. */
export async function assistantRunLocations(collections: readonly EvaluationCollection[], includeTests = false) {
  const runs: AssistantRunLocation[] = [], errors: { collectionId: string; runId: string | null; message: string }[] = [];
  const exists = async (file: string) => { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  for (const collection of collections.filter(item => includeTests || !item.test)) {
    const categoryRoot = collection.path;
    const visit = async (directory: string, depth: number): Promise<void> => {
      const relative = path.relative(categoryRoot, path.dirname(directory)).split(path.sep).filter(part => part !== ".runs").join(path.sep);
      const collectionId = [collection.id, relative === "." || depth === 0 ? "" : relative].filter(Boolean).join("/");
      try {
        if (depth === 0) await evaluationCollectionPath(collection);
        if (await exists(path.join(directory, "state.json"))) {
          const runId = path.basename(directory);
          if (await exists(path.join(directory, "overview.json"))) runs.push({ collectionId, runId, directory, workflow: "comparison" });
          else {
            const state = await readJson<{ workflow?: string; kind?: string }>(path.join(directory, "state.json"));
            if (state.kind === "clustering-job") return;
            if (state.workflow !== "attribution") throw new Error("Comparison 运行缺少 overview.json");
            runs.push({ collectionId, runId, directory, workflow: "attribution" });
          }
          return;
        }
        if (depth >= 3) return;
        for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() &&
          (!entry.name.startsWith(".") || entry.name === ".runs")) await visit(path.join(directory, entry.name), depth + 1);
      } catch (error) {
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        errors.push({ collectionId, runId: depth ? path.basename(directory) : null, message: error instanceof Error ? error.message : "运行目录读取失败" });
      }
    };
    await visit(categoryRoot, 0);
  }
  return { runs, errors };
}
