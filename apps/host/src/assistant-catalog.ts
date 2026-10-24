import path from "node:path";
import { assistantRunLocations, readRunOverviews, type AssistantRunLocation } from "@eval/data";
import { readAnswerReviewAnalysis } from "@eval/workflows/answer-review";
import type { AnalysisRunOverview } from "@eval/workflows/comparison";
import type { AnalysisDataSource, AnalysisQuery, AnalysisReference, AnalysisCaseLookup, AnalysisReadOptions, JsonObject } from "@eval/contracts";
import { LocalAnalysisData } from "./assistant-data.js";
import { AnswerReviewAnalysisData } from "./assistant-answer-review.js";

/** Namespace only navigation projections; formal result and original source fields remain untouched. */
function navigation(value: unknown, collectionId: string): unknown {
  if (Array.isArray(value)) return value.map(row => navigation(row, collectionId));
  if (!value || typeof value !== "object") return value;
  const row = value as JsonObject;
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key,
    key === "result" || key === "evidence" ? child : navigation(child, collectionId)]).concat(typeof row.runId === "string" ? [["collectionId", collectionId]] : []));
}
export class CatalogAnalysisData implements AnalysisDataSource {
  constructor(private root: string, private publication?: { stateFile: string; logFile: string; deliveryFile: string }) {}
  private data(location: AssistantRunLocation) {
    return location.workflow === "answer-review" ? new AnswerReviewAnalysisData(path.dirname(location.directory)) : new LocalAnalysisData(path.dirname(location.directory), this.publication);
  }
  private async locate(reference: { collectionId?: string; runId: string }) {
    if (!reference.collectionId) throw new Error("缺少 collectionId；请沿用运行目录的完整引用");
    const { runs } = await assistantRunLocations(this.root, reference.collectionId.split("/")[1] === "test_eval");
    const found = runs.filter(run => run.collectionId === reference.collectionId && run.runId === reference.runId);
    if (found.length !== 1) throw new Error("运行引用不存在或不唯一");
    return found[0];
  }
  async list(query: AnalysisQuery): Promise<JsonObject> {
    if (query.runId) {
      const location = await this.locate({ collectionId: query.collectionId, runId: query.runId });
      return navigation(await this.data(location).list(query), location.collectionId) as JsonObject;
    }
    const inventory = await assistantRunLocations(this.root, query.includeTests), items: {collectionId: string; runId: string; workflow: string; evaluatorVersion: string; status: string; startedAt: number; inputCount: number; caseCount: number; finishedAt?: unknown}[] = [];
    const summaries = new Map<string, JsonObject>();
    for (const location of inventory.runs) {
      if (query.collectionId && query.collectionId !== location.collectionId) continue;
      try {
        let summary: JsonObject, evaluatorVersion: string;
        if (location.workflow === "answer-review") {
          const view = await readAnswerReviewAnalysis(location.directory);
          if (view.state.manifest.runId !== location.runId) throw new Error("运行目录与状态身份不一致");
          summary = view.summary; evaluatorVersion = view.state.manifest.evaluatorVersion;
        } else {
          const entry = (await readRunOverviews<AnalysisRunOverview>(path.dirname(location.directory))).find(row => row.runId === location.runId);
          if (!entry?.value || entry.error || entry.value.runId !== location.runId) throw new Error(entry?.error ?? "运行索引无效");
          summary = entry.value.summary; evaluatorVersion = entry.value.evaluatorVersion;
        }
        if (typeof summary.status !== "string" || !["running", "finished", "interrupted"].includes(summary.status) || typeof evaluatorVersion !== "string" || !evaluatorVersion) throw new Error("运行概要状态无效");
        for (const field of ["startedAt", "inputCount", "caseCount"]) {
          const value = summary[field];
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`运行概要 ${field} 无效`);
        }
        summaries.set(JSON.stringify([location.collectionId, location.runId]), summary);
        items.push({ collectionId: location.collectionId, runId: location.runId, workflow: location.workflow, evaluatorVersion,
          status: String(summary.status), startedAt: Number(summary.startedAt), inputCount: Number(summary.inputCount), caseCount: Number(summary.caseCount),
          ...(summary.finishedAt === undefined ? {} : { finishedAt: summary.finishedAt }) });
      } catch (error) { inventory.errors.push({ collectionId: location.collectionId, runId: location.runId, message: error instanceof Error ? error.message : "运行读取失败" }); }
    }
    items.sort((a, b) => b.startedAt - a.startedAt || a.collectionId.localeCompare(b.collectionId) || a.runId.localeCompare(b.runId));
    const available = items.filter(item => item.inputCount > 0), selected = available.find(item => item.status === "running") ?? available[0];
    const runDirectory = { complete: inventory.errors.length === 0, errors: inventory.errors };
    if (query.view === "statistics") {
      const { readPublishedStatistics } = await import("./assistant-statistics.js");
      let history: unknown;
      try { if (!this.publication) throw new Error("累计统计发布来源未配置"); history = await readPublishedStatistics(this.publication); }
      catch (error) { history = { status: "unavailable", error: error instanceof Error ? error.message : "统计读取失败", retryable: false }; }
      const currentRuns = await Promise.all(items.filter(item => item.status === "running").map(async item => ({ ...item,
        ...(await this.list({ collectionId: item.collectionId, runId: item.runId, view: "inputs", limit: 1 })) })));
      return { kind: "statistics", history, currentRuns, runDirectory, additive: false };
    }
    if (query.view === "inputs" || query.view === "comparisons") {
      if (!selected) throw new Error("没有含输入的可读运行");
      return { ...await this.list({ ...query, collectionId: selected.collectionId, runId: selected.runId }), runDirectory };
    }
    const filtered = query.query ? items.filter(item => JSON.stringify(item).includes(query.query!)) : items;
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 30, 100), end = Math.min(filtered.length, offset + limit);
    const summary = selected && summaries.get(JSON.stringify([selected.collectionId, selected.runId]));
    return { kind: "runs", items: filtered.slice(offset, end), total: filtered.length, offset, limit, hasMore: end < filtered.length,
      nextOffset: end < filtered.length ? end : null, currentRun: selected ? { ...selected, summary } : null,
      runCounts: { total: items.length, scope: runDirectory.complete ? "all_registered_runs" : "readable_registered_runs",
        states: Object.fromEntries(["running", "finished", "interrupted"].map(state => [state, items.filter(item => item.status === state).length])) }, runDirectory };
  }
  async read(reference: AnalysisReference | AnalysisCaseLookup, options?: AnalysisReadOptions) {
    const location = await this.locate(reference);
    return navigation(await this.data(location).read(reference, options), location.collectionId) as JsonObject;
  }
  async search(reference: AnalysisReference, query: string | string[], options?: { offset?: number; limit?: number; scope?: "evidence" | "all" }) {
    const location = await this.locate(reference);
    return navigation(await this.data(location).search(reference, query, options), location.collectionId) as JsonObject;
  }
  async image(reference: AnalysisReference) { const location = await this.locate(reference); return this.data(location).image(reference); }
}
