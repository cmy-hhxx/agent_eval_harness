import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./files.js";

export interface AssistantRunLocation { collectionId: string; runId: string; directory: string; workflow: "comparison" | "attribution" }
/** Only inspect known output categories and their task/run directories, never input or result trees. */
export async function assistantRunLocations(root: string, includeTests = false) {
  if (!(await stat(root)).isDirectory()) throw new Error("评测数据根目录不是目录");
  const runs: AssistantRunLocation[] = [], errors: { collectionId: string; runId: string | null; message: string }[] = [];
  const categories = ["0_daily_eval", "1_task_eval", ...(includeTests ? ["test_eval"] : [])];
  const exists = async (file: string) => { try { await stat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  for (const source of ["0_wencai", "1_aime", "2_ifind"]) for (const category of categories) {
    const categoryRoot = path.join(root, source, "eval_output", category);
    const visit = async (directory: string, depth: number): Promise<void> => {
      const relative = path.relative(categoryRoot, path.dirname(directory));
      const collectionId = [source, category, relative === "." ? "" : relative].filter(Boolean).join("/");
      try {
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
        for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path.join(directory, entry.name), depth + 1);
      } catch (error) {
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        errors.push({ collectionId, runId: depth ? path.basename(directory) : null, message: error instanceof Error ? error.message : "运行目录读取失败" });
      }
    };
    await visit(categoryRoot, 0);
  }
  return { runs, errors };
}
