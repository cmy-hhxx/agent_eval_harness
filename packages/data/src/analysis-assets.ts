import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createGunzip } from "node:zlib";
import type { AnalysisAssetQuery, AnalysisAssetReference, AnalysisAssetSource, EvaluationCollection } from "@eval/contracts";
import { evaluationCollectionPath, resolveEvaluationCollections } from "./evaluation-collections.js";
import { businessBatch } from "./business-results.js";

const reports = new Set(["report.md", "task_summaries.md"]);
const summaries = new Set(["stats.json", "publication-statistics.json", "attribution-tree.json", "sample-summaries.json", "problem-publication.json"]);
function publicAsset(name: string, parent: string, grandparent = "") {
  const partitioned = (prefix: string) => {
    if (!prefix || !name.startsWith(prefix + "-") || !name.endsWith(".jsonl")) return false;
    try { businessBatch(name.slice(prefix.length + 1, -6)); return true; } catch { return false; }
  };
  return reports.has(name) || summaries.has(name) ||
    partitioned(parent) || partitioned(grandparent) && ["clustering", "rewrite", "instruction-review", "model-behavior"].includes(parent) ||
    /^(?:model-behavior|cluster_tree)\.jsonl(?:\.gz)?$/.test(name) ||
    parent === "results" && /^[\w.-]+\.jsonl(?:\.gz)?$/.test(name) ||
    parent === "problems" && /^[\w.-]+\.json$/.test(name);
}

/** Read-only output catalog: includes archives and standalone trees without inventing run IDs. */
export class EvaluationAssets implements AnalysisAssetSource {
  private collections: EvaluationCollection[];
  constructor(collections: readonly EvaluationCollection[]) {
    this.collections = resolveEvaluationCollections(collections, process.cwd());
  }
  private async inventory(includeTests = false) {
    const items: { reference: AnalysisAssetReference; name: string; format: string; bytes: number; modifiedAt: number; archived: boolean }[] = [];
    const errors: { collectionId: string; assetId: string; message: string }[] = [];
    for (const collection of this.collections.filter(item => includeTests || !item.test)) {
      const collectionId = collection.id;
      let directory: string;
      try { directory = await evaluationCollectionPath(collection); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push({ collectionId, assetId: "", message: String(error) });
        continue;
      }
      const visit = async (folder: string, depth: number): Promise<void> => {
        try {
          for (const entry of await readdir(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name), assetId = path.relative(directory, file).split(path.sep).join("/");
            if (entry.isDirectory() && entry.name !== "_internal" && (!entry.name.startsWith(".") || entry.name === ".archive")) {
              if (depth >= 10) errors.push({ collectionId, assetId, message: "目录超过已扫描深度" });
              else await visit(file, depth + 1);
            } else if (entry.isFile() && publicAsset(entry.name, path.basename(folder), path.basename(path.dirname(folder)))) {
              const info = await stat(file);
              items.push({ reference: { collectionId, assetId }, name: entry.name, bytes: info.size, modifiedAt: info.mtimeMs,
                format: /\.jsonl(?:\.gz)?$/.test(entry.name) ? "jsonl" : entry.name.endsWith(".md") ? "markdown" : "json",
                archived: assetId.split("/").includes(".archive") });
            }
          }
        } catch (error) {
          if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
          errors.push({ collectionId, assetId: path.relative(directory, folder), message: String(error) });
        }
      };
      await visit(directory, 0);
    }
    items.sort((a, b) => b.modifiedAt - a.modifiedAt || a.reference.collectionId.localeCompare(b.reference.collectionId) || a.reference.assetId.localeCompare(b.reference.assetId));
    return { items, errors };
  }
  async list(query: AnalysisAssetQuery) {
    const { items, errors } = await this.inventory(query.includeTests);
    const filtered = items.filter(item => (!query.collectionId || item.reference.collectionId === query.collectionId) &&
      (!query.query || JSON.stringify([item.name, item.reference]).includes(query.query)));
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 30, 100), end = Math.min(filtered.length, offset + limit);
    const scopedErrors = errors.filter(error => !query.collectionId || error.collectionId === query.collectionId);
    return { kind: "assets", complete: scopedErrors.length === 0, errors: scopedErrors,
      summary: { assetCount: filtered.length, archivedCount: filtered.filter(item => item.archived).length,
        byName: Object.fromEntries([...new Set(filtered.map(item => item.name))].sort().map(name => [name, filtered.filter(item => item.name === name).length])),
        byCollection: Object.fromEntries([...new Set(filtered.map(item => item.reference.collectionId))].map(id => [id, filtered.filter(item => item.reference.collectionId === id).length])) },
      total: filtered.length, offset, limit, hasMore: end < filtered.length, nextOffset: end < filtered.length ? end : null,
      items: filtered.slice(offset, end) };
  }
  async read(reference: AnalysisAssetReference, options: { offset?: number; limit?: number } = {}) {
    const collection = this.collections.find(item => item.id === reference.collectionId), parts = reference.assetId.split("/");
    const invalid = () => new Error("资产不存在或不在公开评测产物范围；沿用 list_assets 返回的引用。");
    if (!collection ||
      parts.some(part => !part || part === ".." || part === "_internal" || part.startsWith(".") && part !== ".archive") ||
      !publicAsset(parts.at(-1)!, parts.at(-2) ?? "", parts.at(-3) ?? "")) throw invalid();
    const file = await evaluationCollectionPath(collection, parts);
    const before = await stat(file);
    if (!before.isFile()) throw invalid();
    const source = createReadStream(file), stream = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
    if (stream !== source) source.on("error", error => stream.destroy(error));
    stream.setEncoding("utf8");
    const offset = options.offset ?? 0, limit = Math.min(options.limit ?? 8000, 16000), text: string[] = [];
    let position = 0, hasMore = false;
    try {
      read: for await (const chunk of stream) for (const character of String(chunk)) {
        if (position >= offset + limit) { hasMore = true; break read; }
        if (position++ >= offset) text.push(character);
      }
    } finally { stream.destroy(); source.destroy(); }
    const after = await stat(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("资产读取期间发生变化，请重新读取。");
    return { kind: "asset", reference, name: parts.at(-1), format: /\.jsonl(?:\.gz)?$/.test(file) ? "jsonl" : file.endsWith(".md") ? "markdown" : "json",
      bytes: before.size, modifiedAt: before.mtimeMs, archived: parts.includes(".archive"), offset, limit, unit: "unicode_code_points", text: text.join(""), hasMore,
      nextOffset: hasMore ? offset + text.length : null, total: hasMore ? null : position };
  }
}
