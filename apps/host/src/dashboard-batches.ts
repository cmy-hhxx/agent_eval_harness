import path from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "@eval/contracts";
import { localFiles, readJson, writeJson, exists } from "@eval/data";
import { dashboardSettings } from "./config.js";
import type { EvalConfig } from "@eval/workflows/comparison";

type Scope = NonNullable<EvalConfig["inputs"]["workbench"]>;
export interface BatchRun {
  runId: string; createdAt: number; outputDir: string; scope: Omit<Scope, "records">; models: string[];
  engine: string; settings: Record<string, unknown>; status: string; archivedAt?: number; pid?: number; error?: string;
}
interface SourceScope extends Scope { models: string[]; comparisons: string[][]; output_dir: string }

/** Persistent launch associations survive dashboard restarts, without copying source answers. */
export class DashboardBatches {
  constructor(readonly directory: string, readonly sourceUrl: string) {}
  file(id: string) { return path.join(this.directory, id, "launch.json"); }
  config(id: string) { return path.join(this.directory, id, "inputs.json"); }
  async get(id: string): Promise<BatchRun | undefined> {
    return await exists(this.file(id)) ? readJson<BatchRun>(this.file(id)) : undefined;
  }
  async list() {
    if (!await exists(this.directory)) return [];
    const entries = await localFiles.list(this.directory, { withFileTypes: true });
    const runs = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      // inputs.json is published first; a concurrent or interrupted preview has no launch yet.
      try { return await readJson<BatchRun>(this.file(entry.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return runs.filter((run): run is BatchRun => run !== undefined);
  }
  save(run: BatchRun) { return writeJson(this.file(run.runId), run); }
  async prepare(value: Record<string, unknown>) {
    if (Object.keys(value).some(key => !["batch_ids", "engine", "settings"].includes(key))) throw new HttpError(400, "Unknown batch launch field");
    const requested = dashboardSettings(value.settings ?? {});
    if (requested.versions || requested.clustering) throw new HttpError(400, "批次运行固定被评范围，聚类另行启动");
    const ids = value.batch_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
      throw new HttpError(400, "选择 1–200 个不同批次");
    const engine = value.engine ?? "pi";
    if (engine !== "pi" && engine !== "prime") throw new HttpError(400, "Invalid engine");
    const response = await fetch(this.sourceUrl + "/data/workbench/evaluation-scope", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch_ids: ids }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json() as SourceScope & { error?: string };
    if (!response.ok) throw new HttpError(response.status, body.error || "读取清洗范围失败");
    if (!body.records?.length || !body.models?.length || !path.isAbsolute(body.output_dir)) throw new HttpError(409, "清洗范围无效");
    const scope: Scope = { task: body.task, batch_ids: body.batch_ids, records: body.records };
    const versions = body.models.filter(model => scope.records.some(row => row.model === model)).map(id => ({
      id, name: id, adapter: id.startsWith("b_") ? "b" : "a",
      sources: [...new Set(scope.records.filter(row => row.model === id).map(row => row.input_file))].map(file => ({ kind: "file", path: file })),
    }));
    const run: BatchRun = { runId: randomUUID(), createdAt: Date.now(), outputDir: body.output_dir, scope: { task:scope.task,batch_ids:scope.batch_ids }, models:versions.map(version => version.id),
      engine, settings: requested, status: "draft" };
    // Profiles and secrets are resolved from the current Host configuration at execution time.
    await writeJson(this.config(run.runId), { inputs: { versions, workbench: scope, batches: [], case_ids: [] },
      comparisons: body.comparisons.filter(group => group.every(id => versions.some(version => version.id === id))), clustering: { enabled: false }, output: { kind: "directory", path: run.outputDir } });
    await this.save(run);
    return run;
  }
}
