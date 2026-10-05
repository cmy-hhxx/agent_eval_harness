import type { JsonObject } from "@eval/contracts";
import type { EvalConfig, TaskData } from "./types.js";
import { readRunTasks } from "./run-data.js";

type Outcome = "win" | "both_good" | "both_bad";
type ModelResult = Outcome | "loss";
export interface AnalysisComparisonModel { model: string; modelName: string; comparisonTier: string | null }
export interface AnalysisComparisonScope {
  comparisonTier: string | null;
  case: { batchId: string; caseId: string };
  models: AnalysisComparisonModel[];
  comparisons: { result: Outcome; resultLabel: string; reason: string; winnerModel: string | null; models: (AnalysisComparisonModel & { result: ModelResult })[] }[];
  assessments: { model: string; modelName: string; meetsCore: boolean; summary: string }[];
  tradeoff: string;
}
export interface AnalysisComparisonRecord { reference: { runId: string; taskId: string }; question: string; scope: AnalysisComparisonScope }

/** Business coordinates and outcomes projected from the formal row, never from prose. */
export function analysisComparisonScope(row: JsonObject, config: EvalConfig): AnalysisComparisonScope | null {
  if (row.evaluation_type !== "group_model_comparison" || row.status !== "decided") return null;
  const declared = new Map(config.inputs.versions.map((version) => [version.id, version]));
  const models = Object.entries(row.models as Record<string, { version: string }>).map(([model, value]) => {
    const version = declared.get(model);
    if (!version) throw new Error("正式比较模型未登记：" + model);
    if (typeof value.version !== "string" || !value.version.trim()) throw new Error("正式比较缺少模型展示名：" + model);
    return { model, modelName: value.version, comparisonTier: version.comparison_tier ?? null };
  });
  if (models.length !== 2) throw new Error("每份正式比较需要两个模型");
  const tiers = new Set(models.map((model) => model.comparisonTier));
  if ([...tiers].filter((tier) => tier !== null).length > 1) throw new Error("正式比较包含不同档位的模型");
  const comparisonTier = tiers.size === 1 ? models[0]!.comparisonTier : null;
  const verdicts = row.verdicts as Record<string, { result: Outcome; winner_version: string | null; winner_name: string | null; reason: string }>;
  const [first, second] = models as [AnalysisComparisonModel, AnalysisComparisonModel];
  const forward = first.model + "__vs__" + second.model, reverse = second.model + "__vs__" + first.model;
  const keys = [forward, reverse].filter((key) => Object.hasOwn(verdicts, key));
  if (keys.length !== 1) throw new Error("正式比较的对局引用缺失或重复：" + forward);
  if (Object.keys(verdicts).length !== 1) throw new Error("正式比较包含未登记的对局引用");
  const key = keys[0]!, verdict = verdicts[key]!;
  if (!["win", "both_good", "both_bad"].includes(verdict.result)) throw new Error("正式比较的结果类别无效：" + key);
  const winner = models.find((model) => model.model === verdict.winner_version);
  if (verdict.result === "win" ? !winner || verdict.winner_name !== winner.modelName : verdict.winner_version !== null || verdict.winner_name !== null)
    throw new Error("正式比较的胜者引用与结果不一致：" + key);
  const comparisons: AnalysisComparisonScope["comparisons"] = [{ result: verdict.result,
    resultLabel: verdict.result === "win" ? winner!.modelName + "胜" : verdict.result === "both_good" ? "双方均好" : "双方均差",
    reason: verdict.reason, winnerModel: verdict.winner_version, models: models.map((model) => ({ ...model,
      result: verdict.result === "win" ? model.model === verdict.winner_version ? "win" : "loss" : verdict.result })) }];
  const identity = row.case as { batch_id: string; case_id: string };
  if (typeof identity?.batch_id !== "string" || typeof identity?.case_id !== "string") throw new Error("正式比较缺少题目身份");
  const assessments = row.assessments as Record<string, { meets_core: boolean; summary: string }>;
  return { comparisonTier, case: { batchId: identity.batch_id, caseId: identity.case_id }, models, comparisons,
    assessments: models.map((model) => ({ model: model.model, modelName: model.modelName, meetsCore: assessments[model.model]!.meets_core, summary: assessments[model.model]!.summary })),
    tradeoff: (row.decision_basis as { tradeoff: string }).tradeoff };
}

/** Count independently accepted pair results separately by declared tier. */
export function analysisComparisonStats(records: readonly AnalysisComparisonRecord[]) {
  type ModelCounts = AnalysisComparisonModel & { comparisonCount: number; wins: number; losses: number; both_good: number; both_bad: number };
  const tiers = new Map<string | null, { formalResultCount: number; comparisonCount: number; cases: Set<string>; outcomes: Record<Outcome, number>;
    models: Map<string, ModelCounts>; references: AnalysisComparisonRecord["reference"][] }>();
  const references = new Set<string>();
  let comparisonCount = 0;
  for (const { reference, scope } of records) {
    const identity = JSON.stringify([reference.runId, reference.taskId]);
    if (references.has(identity)) throw new Error("正式比较引用重复：" + reference.taskId);
    references.add(identity);
    let tier = tiers.get(scope.comparisonTier);
    if (!tier) tiers.set(scope.comparisonTier, tier = { formalResultCount: 0, comparisonCount: 0, cases: new Set(),
      outcomes: { win: 0, both_good: 0, both_bad: 0 }, models: new Map(), references: [] });
    tier.formalResultCount++;
    tier.cases.add(JSON.stringify([scope.case.batchId, scope.case.caseId]));
    tier.references.push(reference);
    for (const comparison of scope.comparisons) {
      tier.comparisonCount++;
      comparisonCount++;
      tier.outcomes[comparison.result]++;
      for (const model of comparison.models) {
        let count = tier.models.get(model.model);
        if (!count) tier.models.set(model.model, count = { model: model.model, modelName: model.modelName, comparisonTier: model.comparisonTier,
          comparisonCount: 0, wins: 0, losses: 0, both_good: 0, both_bad: 0 });
        count.comparisonCount++;
        if (model.result === "win") count.wins++;
        else if (model.result === "loss") count.losses++;
        else count[model.result]++;
      }
    }
  }
  const order = (tier: string | null) => tier === "Fast" ? 0 : tier === "Expert" ? 1 : 2;
  return { formalResultCount: records.length, comparisonCount, records,
    tiers: [...tiers].sort(([a], [b]) => order(a) - order(b) || String(a).localeCompare(String(b))).map(([comparisonTier, tier]) => ({
      comparisonTier, formalResultCount: tier.formalResultCount, comparisonCount: tier.comparisonCount, caseCount: tier.cases.size,
      outcomes: tier.outcomes, models: [...tier.models.values()], references: tier.references,
    })) };
}

/** Read only the selected run's already accepted formal rows through the existing result repository. */
export async function readAnalysisComparisonStats(run: string, taskIds: readonly string[]) {
  const ids = [...new Set(taskIds)];
  if (ids.length !== taskIds.length) throw new Error("正式比较任务引用重复");
  if (!ids.length) return analysisComparisonStats([]);
  const state = await readRunTasks(run, ids), config = state.manifest.config as EvalConfig;
  return analysisComparisonStats(ids.map((taskId) => {
    const task = state.manifest.tasks.find((item) => item.id === taskId), receipt = state.receipts[taskId];
    const data = task?.data as TaskData | undefined;
    if (!task || task.stage !== "comparison" || data?.verificationAudit || data?.supersededBy || state.manifest.states[taskId]?.status !== "succeeded" ||
      !receipt?.exported || (receipt.exported.file ?? "comparison.jsonl") !== "comparison.jsonl") throw new Error("比较引用不是当前正式结果：" + taskId);
    const scope = analysisComparisonScope(receipt.exported.row, config);
    if (!scope) throw new Error("比较引用缺少正式比较内容：" + taskId);
    const candidate = Object.values(data!.candidates).find((item) => item.batch_id === scope.case.batchId && item.case_id === scope.case.caseId);
    if (!candidate) throw new Error("正式比较缺少登记的原问：" + taskId);
    return { reference: { runId: state.manifest.runId, taskId }, question: candidate.question, scope };
  }));
}
