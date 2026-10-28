import { lstat } from "node:fs/promises";
import path from "node:path";
import type { EvaluationCollection } from "@eval/contracts";

/** Resolve deployment-owned paths once; IDs never determine filesystem locations. */
export function resolveEvaluationCollections(value: unknown, directory: string): EvaluationCollection[] {
  if (!Array.isArray(value) || !value.length) throw new Error("至少配置一个评测产物目录");
  const ids = new Set<string>(), paths = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some(key => !["id", "path", "test"].includes(key)) ||
      typeof entry.id !== "string" || entry.id.includes("\\") || entry.id.includes("\0") ||
      entry.id.split("/").some((part: string) => !part.trim() || part === "." || part === "..") ||
      typeof entry.path !== "string" || !entry.path.trim() ||
      (entry.test !== undefined && typeof entry.test !== "boolean")) throw new Error("评测产物目录配置无效");
    const location = path.resolve(directory, entry.path);
    if (ids.has(entry.id) || paths.has(location)) throw new Error("评测产物目录 ID 或路径重复");
    ids.add(entry.id); paths.add(location);
    return { id: entry.id, path: location, test: entry.test ?? false };
  });
}

/** Configured roots and all referenced descendants must be real paths, not links. */
export async function evaluationCollectionPath(collection: EvaluationCollection, parts: string[] = []) {
  let file = collection.path;
  for (const part of ["", ...parts]) {
    if (part) file = path.join(file, part);
    if ((await lstat(file)).isSymbolicLink()) throw new Error("公开评测产物路径不能为软链接");
  }
  return file;
}
