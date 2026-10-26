import type { RunState, TaskState } from "@eval/contracts";
import type { Checkpoint } from "./checkpoint.js";
import type { EvalConfig } from "./types.js";
import { analysisComparisonRecords, analysisComparisonStats } from "./analysis-comparison.js";

type SavedTask = Checkpoint["tasks"][string];
type AnalysisCheckpoint = Pick<Checkpoint, "runId" | "status" | "startedAt" | "finishedAt" | "config" | "inputs" | "tasks">;
export type AnalysisTaskPurpose = "criteria" | "attribution" | "instruction-review" |
  "rewrite" | "clustering" | "comparison_verification" | "comparison_formal";
export interface AnalysisTaskCounts { total: number; states: Record<TaskState["status"], number> }

function registeredInput(taskId: string, tasks: AnalysisCheckpoint["tasks"], seen = new Set<string>()): string | undefined {
  if (seen.has(taskId)) return undefined;
  seen.add(taskId);
  const task = tasks[taskId];
  if (!task) return undefined;
  return task.inputIds.answer ?? Object.values(task.dependencies)
    .map(dependency => registeredInput(dependency, tasks, seen)).find(Boolean);
}

function counts(): AnalysisTaskCounts {
  return { total: 0, states: { pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, cancelled: 0, timed_out: 0 } };
}

/** The execution purpose differs from whether the task produced a formal result. */
export function analysisTaskPurpose(task: Pick<SavedTask, "stage" | "data">): AnalysisTaskPurpose {
  if (task.stage.startsWith("attribution-")) return "attribution";
  if (task.stage !== "comparison") return task.stage as Exclude<AnalysisTaskPurpose, "comparison_verification" | "comparison_formal">;
  return task.data.verificationOf ? "comparison_verification" : "comparison_formal";
}

/** Checkpoint receipts identify accepted output files without reading verdicts. */
function analysisComparisonResult(task: SavedTask): "accepted" | "pending_review" | null {
  if (task.stage !== "comparison" || task.data.verificationAudit || task.status !== "succeeded") return null;
  const exported = task.receipt?.exported;
  if (!exported) return null;
  // The current codec omits a stage's default filename; comparison-review keeps it explicitly.
  const file = exported.file ?? "comparison.jsonl";
  if (file === "comparison-review.jsonl") return "pending_review";
  return file === "comparison.jsonl" ? "accepted" : null;
}

/** Whole-run progress from registered identities and task states; no material or result IO. */
export function analysisProgress(saved: AnalysisCheckpoint) {
  const config = saved.config as EvalConfig;
  const versions = new Map(config.inputs.versions.map((version) => [version.id, version]));
  const modelCoverage = new Map(config.inputs.versions.map((version) => [version.id, { inputs: 0, cases: new Set<string>() }]));
  const cases = new Set<string>(), batches = new Set<string>();
  for (const input of Object.values(saved.inputs)) {
    const coverage = modelCoverage.get(input.version);
    if (!coverage) throw new Error("输入版本未登记：" + input.version);
    const identity = JSON.stringify([input.batch_id, input.case_id]);
    cases.add(identity);
    batches.add(input.batch_id);
    coverage.inputs++;
    coverage.cases.add(identity);
  }
  const total = counts();
  const byPurpose: Record<AnalysisTaskPurpose, AnalysisTaskCounts> = {
    "instruction-review": counts(), criteria: counts(), attribution: counts(), comparison_verification: counts(),
    comparison_formal: counts(), rewrite: counts(), clustering: counts(),
  };
  const formalComparisonReferences: { runId: string; taskId: string }[] = [];
  const comparisonReviewReferences: { runId: string; taskId: string }[] = [];
  const evaluatedInputs = new Set<string>();
  let acceptedFrom: number | undefined, acceptedThrough: number | undefined;
  for (const [taskId, task] of Object.entries(saved.tasks)) {
    const purpose = byPurpose[analysisTaskPurpose(task)];
    for (const group of [total, purpose]) { group.total++; group.states[task.status]++; }
    const result = analysisComparisonResult(task);
    if (result === "accepted") {
      formalComparisonReferences.push({ runId: saved.runId, taskId });
      const at = task.receipt?.acceptedAt;
      if (typeof at === "number" && Number.isFinite(at)) {
        acceptedFrom = Math.min(acceptedFrom ?? at, at);
        acceptedThrough = Math.max(acceptedThrough ?? at, at);
      }
    }
    if (result === "pending_review") comparisonReviewReferences.push({ runId: saved.runId, taskId });
    if (task.stage === "attribution-session" && task.status === "succeeded" && task.receipt) {
      const inputId = registeredInput(taskId, saved.tasks);
      if (!inputId || !saved.inputs[inputId]) throw new Error("归因任务缺少登记的回答输入：" + taskId);
      evaluatedInputs.add(inputId);
    }
  }
  const date = (value: number | undefined) => value === undefined ? null
    : new Date(value + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00");
  return {
    status: saved.status, startedAt: saved.startedAt, ...(saved.finishedAt !== undefined ? { finishedAt: saved.finishedAt } : {}),
    timeScope: { timeZone: "Asia/Shanghai", evaluation: { from: date(saved.startedAt), to: date(saved.finishedAt) },
      acceptedResults: { from: date(acceptedFrom), through: date(acceptedThrough) }, sampleTimeRange: null },
    inputCount: Object.keys(saved.inputs).length, evaluatedInputCount: evaluatedInputs.size, caseCount: cases.size, batchCount: batches.size, batches: [...batches].sort(),
    models: [...modelCoverage].map(([model, coverage]) => {
      const version = versions.get(model)!;
      return { model, modelName: version.display_name ?? version.name, comparisonTier: version.comparison_tier ?? null,
        inputCount: coverage.inputs, caseCount: coverage.cases.size };
    }),
    tasks: { ...total, byPurpose },
    formalComparisonsAccepted: formalComparisonReferences.length, formalComparisonReferences,
    comparisonsPendingReview: comparisonReviewReferences.length, comparisonReviewReferences,
  };
}

/** Persist counts, percentages and result coordinates, without copying questions, answers or judgments. */
export function analysisRunOverview(saved: Checkpoint, state: RunState) {
  if (saved.format !== "evaluation-run") throw new Error("运行统计索引只支持 evaluation-run。");
  const { formalComparisonReferences, comparisonReviewReferences: _review, ...summary } = analysisProgress(saved);
  const formalComparisonStats = analysisComparisonStats(
    analysisComparisonRecords(state, formalComparisonReferences.map(item => item.taskId)));
  const percent = (count: number, total: number) => total ? Number((count / total * 100).toFixed(2)) : null;
  return { runId: saved.runId, evaluatorVersion: saved.evaluatorVersion, summary: { ...summary,
    attributionCompletionRate: percent(summary.evaluatedInputCount, summary.inputCount),
    battleCompletionRate: percent(formalComparisonStats.comparisonCount, summary.tasks.byPurpose.comparison_formal.total),
    formalComparisonStats,
  } };
}
export type AnalysisRunOverview = ReturnType<typeof analysisRunOverview>;
