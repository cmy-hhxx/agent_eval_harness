import { object, type JsonObject, type PublicationInput, type PublicationResult, type PublicationLabels } from "@eval/contracts";
import type { Checkpoint } from "./codec.js";
import type { EvalConfig } from "./types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import statisticsLogSchema from "../../../../schemas/workflow/statistics-log.schema.json" with { type: "json" };

const logAjv = new Ajv2020({ allErrors: true });
const validateStatisticsLog = logAjv.compile(statisticsLogSchema);

/** Frozen consumer contract: reject drift without coercing, dropping or adding fields. */
export function assertStatisticsLog(record: unknown): asserts record is JsonObject {
  if (!validateStatisticsLog(record))
    throw new Error("Statistics log violates frozen contract: " + logAjv.errorsText(validateStatisticsLog.errors));
}

/** Clustering writes a separate artifact; it cannot delay an already polished comparison.jsonl row. */
export function publishableComparisons(state: Checkpoint): Map<string, number> {
  return comparisonReceipts(state, false);
}

/** Full-stage completion still includes clustering and its rewrite. */
export function completedComparisons(state: Checkpoint): Map<string, number> {
  return comparisonReceipts(state, true);
}

function comparisonReceipts(state: Checkpoint, includeClustering: boolean): Map<string, number> {
  const ready = new Map<string, number>();
  const entries = Object.entries(state.tasks);
  const rewrites = new Map<string, string[]>();
  const clustering = new Map<string, string[]>();
  for (const [id, task] of entries) if (task.stage === "clustering")
    for (const attribution of Object.values(task.dependencies))
      clustering.set(attribution, [...(clustering.get(attribution) ?? []), id]);
  for (const [id, task] of entries) if (task.data.rewriteOf) {
    const source = task.data.rewriteOf.taskId;
    rewrites.set(source, [...(rewrites.get(source) ?? []), id]);
  }
  const config = state.config as EvalConfig;
  for (const [id, task] of entries) {
    if (task.stage !== "comparison") continue;
    const required = new Set([id, ...Object.values(task.dependencies)]);
    let missing = false;
    for (const attribution of includeClustering ? Object.values(task.dependencies) : []) {
      const planned = clustering.get(attribution) ?? [];
      if (config.clustering.enabled && !planned.length) missing = true;
      planned.forEach((cluster) => required.add(cluster));
    }
    for (const sourceId of [...required]) {
      const source = state.tasks[sourceId];
      if (!source) { missing = true; continue; }
      const planned = rewrites.get(sourceId) ?? [];
      if (config.rewrite[source.stage as keyof EvalConfig["rewrite"]] && !planned.length) missing = true;
      planned.forEach((rewrite) => required.add(rewrite));
    }
    if (missing || !rewrites.get(id)?.length) continue;
    const tasks = [...required].map((taskId) => state.tasks[taskId]);
    if (tasks.some((item) => !item || item.status !== "succeeded" || !item.receipt?.exported)) continue;
    const at = Math.max(...tasks.map((item) => item.receipt!.acceptedAt));
    if (Number.isFinite(at) && task.data.comparisonId) ready.set(task.data.comparisonId, at);
  }
  return ready;
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
type InputSummary = { caseId: string; date: string | null; batchDate: string | null; id: string; name: string; task: string; difficulty: string; meta: JsonObject };
type Pair = { caseId: string; a: string; b: string; winner: unknown; correct: Record<string, boolean | null> };
const pairKey = (caseId: string, a: string, b: string) => JSON.stringify([caseId, ...[a, b].sort()]);
const modes = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
const levels = [
  ["L1", "简单", "事实查询与直接计算"], ["L2", "中等", "多条件组合与研判"],
  ["L3", "复杂", "深度分析与开放推理"], ["L4", "长程任务", "多步骤长链任务"],
  ["unclassified", "未分层", "待确认任务难度"],
];
function metric(values: unknown[]) {
  const sorted = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p, lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  };
  return { p50: percentile(.5), p90: percentile(.9), count: sorted.length };
}

/** Source timestamps without a zone are Beijing time, as in the comparison dashboard. */
function requestDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) value += " 00:00:00";
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(value);
  if (!local && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const at = Date.parse(local ? `${local[1]}T${local[2]}${local[3] ?? ""}+08:00` : value);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return local && date !== local[1] ? null : date;
}

/** Keep only statistics fields in memory while reading input and result streams. */
export class PublicationStatistics {
  private readonly inputs = new Map<string, InputSummary>();
  private readonly pairs = new Map<string, Pair>();
  private readonly labels = new Map<string, Pick<PublicationLabels, "task" | "difficulty">>();
  addLabels({ batchId, caseId, task, difficulty }: PublicationLabels) {
    const key = JSON.stringify([batchId, caseId]), existing = this.labels.get(key) ?? {};
    const values = { task: text(task), difficulty: text(difficulty) };
    for (const field of ["task", "difficulty"] as const) {
      const value = values[field];
      if (!value || value === "未分类" || value === "未分层") continue;
      if (existing[field] && existing[field] !== value) throw new Error(`Conflicting statistics ${field} labels: ${key}`);
      existing[field] = value;
    }
    this.labels.set(key, existing);
  }
  addInput({ versionId, trace }: PublicationInput) {
    const meta = object(trace.meta ?? {}), caseId = JSON.stringify([trace.batch_id, trace.case_id]);
    this.addLabels({ batchId: text(trace.batch_id), caseId: text(trace.case_id), task: text(meta.task), difficulty: text(meta.difficulty) });
    const difficulty = text(meta.difficulty);
    this.inputs.set(JSON.stringify([caseId, versionId]), { caseId, date: requestDate(text(trace.request_time)), batchDate: requestDate(text(trace.batch_id)), id: versionId, name: text(trace.version),
      task: text(meta.task) || "未分类", difficulty: levels.some((level) => level[1] === difficulty) ? difficulty : "未分层",
      meta: { first_token_time_cost: meta.first_token_time_cost, finish_answer_time_cost: meta.finish_answer_time_cost, usage: meta.usage },
    });
  }
  addResult({ row }: PublicationResult) {
    const ids = Object.keys(object(row.models)).sort(), caseId = JSON.stringify([object(row.case).batch_id, object(row.case).case_id]);
    if (ids.length !== 2 || !modes.some((pair) => pair.every((id) => ids.includes(id)))) throw new Error("Unexpected statistics pair");
    const verdict = object(object(row.verdicts)[ids.join("__vs__")]);
    const correct = Object.fromEntries(ids.map((id) => {
      const value = object(object(row.evaluations)[id]).is_correct;
      return [id, row.has_standard_answer === true && typeof value === "boolean" ? value : null];
    }));
    const key = pairKey(caseId, ...ids as [string, string]);
    if (this.pairs.has(key)) throw new Error("Duplicate statistics comparison: " + key);
    this.pairs.set(key, { caseId, a: ids[0], b: ids[1], winner: verdict.winner_version, correct });
  }
  record(traceId: string, at: number, throughDate?: string): JsonObject {
    let rows = [...this.inputs.values()].map((row) => ({ ...row }));
    const pairs = [...this.pairs.values()];
    const dates = new Map<string, string>();
    for (const row of rows) if (row.date && !dates.has(row.caseId)) dates.set(row.caseId, row.date);
    for (const row of rows) {
      row.date = dates.get(row.caseId) ?? row.batchDate;
      const labels = this.labels.get(row.caseId);
      row.task = labels?.task || "未分类";
      row.difficulty = levels.some((level) => level[1] === labels?.difficulty) ? labels!.difficulty! : "未分层";
    }
    if (throughDate) rows = rows.filter((row) => row.date && row.date <= throughDate);
    const models = [...new Map(rows.map((row) => [row.id, { id: row.id, name: row.name }])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const within = (subset: InputSummary[]) => {
      const ids = new Set(subset.map((row) => JSON.stringify([row.caseId, row.id])));
      return pairs.filter((pair) => [pair.a, pair.b].every((id) => ids.has(JSON.stringify([pair.caseId, id]))));
    };
    const caseCount = (subset: InputSummary[]) => new Set(subset.map((row) => row.caseId)).size;
    const evaluatedCount = (subset: InputSummary[]) => new Set(within(subset).map((pair) => pair.caseId)).size;
    const progress = (subset: InputSummary[]) => {
      const versions = new Map<string, Set<string>>();
      subset.forEach((row) => { if (!versions.has(row.caseId)) versions.set(row.caseId, new Set()); versions.get(row.caseId)!.add(row.id); });
      let expectedBattleCount = 0, completedBattleCount = 0, completedCaseCount = 0;
      for (const [caseId, ids] of versions) {
        const expected = modes.filter((pair) => pair.every((id) => ids.has(id)));
        const completed = expected.filter(([a, b]) => this.pairs.has(pairKey(caseId, a, b))).length;
        expectedBattleCount += expected.length; completedBattleCount += completed;
        if (expected.length && expected.length === completed) completedCaseCount++;
      }
      return { expectedBattleCount, completedBattleCount, completedCaseCount };
    };
    const stats = (subset: InputSummary[]) => {
      const completed = within(subset);
      return models.flatMap((model) => {
        const ps = completed.filter((pair) => pair.a === model.id || pair.b === model.id);
        if (!ps.length) return [];
        const cases = new Set(ps.map((pair) => pair.caseId));
        const answers = subset.filter((row) => row.id === model.id && cases.has(row.caseId));
        const correct = ps.map((pair) => pair.correct[model.id]).filter((value): value is boolean => typeof value === "boolean");
        const wins = ps.filter((pair) => pair.winner === model.id).length, right = correct.filter(Boolean).length;
        return [{ ...model, wins, evaluated: ps.length, winRate: wins / ps.length * 100,
          accuracy: { correct: right, count: correct.length, rate: correct.length ? right / correct.length * 100 : null },
          first: metric(answers.map((row) => row.meta.first_token_time_cost)),
          total: metric(answers.map((row) => row.meta.finish_answer_time_cost)),
          input: metric(answers.map((row) => object(row.meta.usage ?? {}).input_tokens)),
          output: metric(answers.map((row) => object(row.meta.usage ?? {}).output_tokens)),
        }];
      });
    };
    const tasks = (subset: InputSummary[]) => [...new Set(subset.map((row) => row.task))].sort().map((name) => {
      const selected = subset.filter((row) => row.task === name);
      return { id: name, name, count: caseCount(selected), stats: stats(selected), progress: progress(selected), evaluatedCount: evaluatedCount(selected) };
    });
    const overview = (subset: InputSummary[]) => ({
      caseCount: evaluatedCount(subset), totalCaseCount: caseCount(subset), models,
      stats: stats(subset), tasks: tasks(subset), progress: progress(subset),
      difficultyLevels: levels.map(([id, name, description]) => {
        const selected = subset.filter((row) => row.difficulty === name);
        return { id, name, description, count: caseCount(selected), stats: stats(selected), progress: progress(selected),
          evaluatedCount: evaluatedCount(selected), tasks: tasks(selected), difficulty: name };
      }),
    });
    const days = [...new Set(rows.flatMap((row) => row.date ? [row.date] : []))].sort();
    return {
      logtime: new Date(at + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").replace("Z", ""),
      level: "INFO", traceId, threadName: "comparison-snapshot", busi_instance_id: "agent-eval-bench",
      module: "comparison-dashboard", content: "COMPARISON_STATISTICS_SNAPSHOT", stackTrace: "",
      "t-cluster": "prod", "t-comp": "aime-fin-eval", "t-release": "aime-fin-eval", "t-app": "aime-fin-eval-ops-prod",
      data: {
        source: "/api/version-comparisons?matchup=same-mode",
        scope: { matchup: "same-mode" }, ...overview(rows),
        requestDates: [...days].reverse().map((date) => {
          const selected = rows.filter((row) => row.date === date);
          return { date, count: caseCount(selected), ...overview(selected) };
        }),
        winRateTrend: days.flatMap((date) => stats(rows.filter((row) => row.date === date))
          .map((row) => ({ date, id: row.id, wins: row.wins, evaluated: row.evaluated }))),
      },
    };
  }
}
