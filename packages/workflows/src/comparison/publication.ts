import { object, type JsonObject, type PublicationInput, type PublicationResult, type PublicationLabels } from "@eval/contracts";
import type { Checkpoint } from "./checkpoint.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import statisticsLogSchema from "../../../../schemas/workflow/statistics-log.schema.json" with { type: "json" };
import { expandComparisonPairs } from "./input.js";

const logAjv = new Ajv2020({ allErrors: true });
const validateStatisticsLog = logAjv.compile(statisticsLogSchema);

/** Frozen consumer contract: reject drift without coercing, dropping or adding fields. */
export function assertStatisticsLog(record: unknown): asserts record is JsonObject {
  if (!validateStatisticsLog(record))
    throw new Error("Statistics log violates frozen contract: " + logAjv.errorsText(validateStatisticsLog.errors));
}

/** Check the merged JSONL against the exact scope recorded in accepted rewrite receipts. */
export function assertCompleteComparisonRewrite(row: JsonObject, required: readonly string[]): void {
  if (!required.length) throw new Error(`Comparison rewrite scope missing: ${row.comparison_id}`);
  const rewritten = row.rewritten as { rewrites: { id: string; text: string }[] } | undefined;
  const filled = new Set(rewritten?.rewrites.filter((item) => item.text.trim()).map((item) => item.id));
  const missing = required.filter((id) => !filled.has(id));
  if (missing.length) throw new Error(`Comparison rewrite incomplete: ${row.comparison_id}: ${missing.join(", ")}`);
}

/** Mongo's A/B columns follow sorted version IDs, independently of the persisted blind positions. */
export function publicationComparison(row: JsonObject, inputIds: Record<string, string>, inputs: Record<string, Pick<Checkpoint["inputs"][string], "version">>): JsonObject {
  const versions = Object.keys(object(row.models)).sort();
  const candidates = Object.entries(inputIds).map(([label, id]) => [label, inputs[id]?.version] as const);
  if (versions.length !== 2 || candidates.length !== 2 || new Set(candidates.map(([, version]) => version)).size !== 2 ||
      candidates.some(([label, version]) => !["A", "B"].includes(label) || !versions.includes(version)))
    throw new Error("Comparison publication identity mapping invalid: " + row.comparison_id);
  const columns = new Map(candidates.map(([label, version]) => [label, versions.indexOf(version) === 0 ? "A" : "B"]));
  const rewritten = row.rewritten as { evaluator_version: string; rewrites: { id: string; text: string }[] } | undefined;
  if (!rewritten) return { ...row };
  const rewrites = rewritten.rewrites.map(item => ({ ...item,
    id: item.id.replace(/^(assessment|comparison\.\d+)\.([A-Z])\.summary$/u, (_match, slot: string, label: string) => {
      const column = columns.get(label);
      if (!column) throw new Error("Comparison rewrite candidate missing: " + item.id);
      return `${slot}.${column}.summary`;
    }),
  }));
  if (new Set(rewrites.map(item => item.id)).size !== rewrites.length)
    throw new Error("Comparison publication rewrite slots duplicated: " + row.comparison_id);
  return { ...row, rewritten: { ...rewritten, rewrites } };
}

/** Publish each comparison when its own text rewrite has an accepted result. */
export function publishableComparisons(state: Checkpoint): Map<string, number> {
  const ready = new Map<string, number>();
  const entries = Object.entries(state.tasks);
  const rewrites = new Map<string, string[]>();
  for (const [id, task] of entries) if (task.data.rewriteOf) {
    const source = task.data.rewriteOf.taskId;
    rewrites.set(source, [...(rewrites.get(source) ?? []), id]);
  }
  for (const [id, task] of entries) {
    if (task.stage !== "comparison" || task.data.verificationAudit || task.receipt?.exported?.file === "comparison-review.jsonl") continue;
    const required = new Set([id, ...Object.values(task.dependencies)]);
    const tasks = [...required].map((taskId) => state.tasks[taskId]);
    if (tasks.some((item) => !item || item.status !== "succeeded" || !item.receipt?.exported)) continue;
    const polishing = (rewrites.get(id) ?? []).map(rewrite => state.tasks[rewrite]);
    const enabled = (state.config as { rewrite?: { comparison?: boolean } })?.rewrite?.comparison;
    if (enabled && !polishing.length) continue;
    if (polishing.some(item => item.status !== "succeeded" || !item.receipt?.exported)) continue;
    const at = Math.max(...[...tasks, ...polishing].flatMap(item => item.receipt ? [item.receipt.acceptedAt] : []));
    if (Number.isFinite(at) && task.data.comparisonId) ready.set(task.data.comparisonId, at);
  }
  return ready;
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
type InputSummary = { caseId: string; date: string | null; batchDate: string | null; id: string; name: string; task: string; difficulty: string; meta: JsonObject };
type Pair = { caseId: string; a: string; b: string; winner: unknown; result: "win" | "both_good" | "both_bad"; correct: Record<string, boolean | null> };
const pairKey = (caseId: string, a: string, b: string) => JSON.stringify([caseId, ...[a, b].sort()]);
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
  private readonly matchups: string[][] = [];
  private readonly batchMatchups = new Map<string, string[][]>();
  private readonly correctness = new Map<string, boolean | null>();
  private readonly core = new Map<string, boolean>();
  constructor(groups: readonly (readonly string[])[]) {
    this.addGroups(groups);
  }
  addGroups(groups: readonly (readonly string[])[], batchId?: string): void {
    if (batchId !== undefined) {
      this.batchMatchups.set(batchId, expandComparisonPairs([...(this.batchMatchups.get(batchId) ?? []), ...groups]));
      return;
    }
    this.matchups.splice(0, this.matchups.length, ...expandComparisonPairs([...this.matchups, ...groups]));
  }
  private pairsForBatch(batchId: unknown): string[][] {
    return this.batchMatchups.get(String(batchId)) ?? this.matchups;
  }
  /** Apply Mongo labels after local inputs, in ascending createdAt / _id order. */
  addLabels({ batchId, caseId, task, difficulty }: PublicationLabels) {
    const key = JSON.stringify([batchId, caseId]), existing = this.labels.get(key) ?? {};
    const value = text(task);
    if (value && value !== "未分类" && value !== "未分层") {
      if (existing.task && existing.task !== value) throw new Error(`Conflicting statistics task labels: ${key}`);
      existing.task = value;
    }
    if (difficulty !== undefined) existing.difficulty = text(difficulty);
    this.labels.set(key, existing);
  }
  addInput({ versionId, trace }: PublicationInput) {
    const meta = object(trace.meta ?? {}), caseId = JSON.stringify([trace.batch_id, trace.case_id]);
    const difficulty = text(meta.difficulty);
    this.addLabels({ batchId: text(trace.batch_id), caseId: text(trace.case_id), task: text(meta.task),
      ...(difficulty ? { difficulty } : {}) });
    this.inputs.set(JSON.stringify([caseId, versionId]), { caseId, date: requestDate(text(trace.request_time)), batchDate: requestDate(text(trace.batch_id)), id: versionId, name: text(trace.version),
      task: text(meta.task) || "未分类", difficulty: levels.some((level) => level[1] === difficulty) ? difficulty : "未分层",
      meta: { first_token_time_cost: meta.first_token_time_cost, finish_answer_time_cost: meta.finish_answer_time_cost, usage: meta.usage },
    });
  }
  addResult({ row }: PublicationResult) {
    if (row.status === "needs_review" || row.evaluation_type === "comparison_review")
      throw new Error("Only decided comparisons can enter publication statistics");
    const ids = Object.keys(object(row.models)).sort(), caseId = JSON.stringify([object(row.case).batch_id, object(row.case).case_id]);
    if (ids.length !== 2 || !this.pairsForBatch(object(row.case).batch_id).some((pair) => pair.every((id) => ids.includes(id))))
      throw new Error("Unexpected statistics pair; publication requires a configured two-candidate result");
    const matching = Object.entries(object(row.verdicts)).filter(([key]) => {
      const pair = key.split("__vs__");
      return pair.length === 2 && ids.every((id) => pair.includes(id));
    });
    if (matching.length !== 1) throw new Error("Unexpected statistics verdict; exactly one configured pair is required");
    const verdict = object(matching[0][1]);
    const result = verdict.result;
    if (result !== "win" && result !== "both_good" && result !== "both_bad") throw new Error("Unexpected statistics verdict result");
    if (result === "win" ? !ids.includes(String(verdict.winner_version)) : verdict.winner_version !== null)
      throw new Error("Statistics verdict result and winner disagree");
    const correct = Object.fromEntries(ids.map((id) => {
      const value = object(object(row.evaluations)[id]).is_correct;
      return [id, row.has_standard_answer === true && typeof value === "boolean" ? value : null];
    }));
    const key = pairKey(caseId, ...ids as [string, string]);
    if (this.pairs.has(key)) throw new Error("Duplicate statistics comparison: " + key);
    for (const id of ids) {
      const answerKey = JSON.stringify([caseId, id]);
      if (this.correctness.has(answerKey) && this.correctness.get(answerKey) !== correct[id])
        throw new Error("Conflicting answer correctness across comparisons: " + answerKey);
      const meetsCore = object(object(row.assessments ?? {})[id] ?? {}).meets_core;
      if (row.status === "decided" && typeof meetsCore !== "boolean")
        throw new Error("Settled comparison is missing a core assessment: " + answerKey);
      if (typeof meetsCore === "boolean" && this.core.has(answerKey) && this.core.get(answerKey) !== meetsCore)
        throw new Error("Conflicting answer core assessments across comparisons: " + answerKey);
    }
    for (const id of ids) {
      const answerKey = JSON.stringify([caseId, id]);
      this.correctness.set(answerKey, correct[id]);
      const meetsCore = object(object(row.assessments ?? {})[id] ?? {}).meets_core;
      if (typeof meetsCore === "boolean") this.core.set(answerKey, meetsCore);
    }
    this.pairs.set(key, { caseId, a: ids[0], b: ids[1], winner: verdict.winner_version, result, correct });
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
      row.difficulty = levels.some((level) => level[1] === labels?.difficulty)
        ? labels!.difficulty! : "未分层";
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
        const expected = this.pairsForBatch((JSON.parse(caseId) as unknown[])[0]).filter((pair) => pair.every((id) => ids.has(id)));
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
        const correct = [...new Map(ps.map((pair) => [pair.caseId, pair.correct[model.id]])).values()]
          .filter((value): value is boolean => typeof value === "boolean");
        const wins = ps.filter((pair) => pair.winner === model.id).length, right = correct.filter(Boolean).length;
        return [{ ...model, wins, both_good: ps.filter((pair) => pair.result === "both_good").length,
          both_bad: ps.filter((pair) => pair.result === "both_bad").length, evaluated: ps.length, winRate: wins / ps.length * 100,
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
          .map((row) => ({ date, id: row.id, wins: row.wins, both_good: row.both_good, both_bad: row.both_bad, evaluated: row.evaluated }))),
      },
    };
  }
}
