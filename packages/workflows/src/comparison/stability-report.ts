import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, type PlannedTask, type RunState } from "@eval/contracts";
import { atomicWrite, readJson, writeJson, writeJsonl } from "@eval/data";
import type { ComparisonResult, TaskData } from "./types.js";
import { comparisonRepository } from "./run-data.js";
import { stabilityRepository } from "./stability-storage.js";
import { stabilityCaseKey, type StabilityConfig, type StabilityTaskData } from "./stability.js";
import { caseBootstrap, exactSignTest, outcomeDistribution } from "./stability-statistics.js";
import { decideVerdict, tierOf } from "./verdicts.js";
import { modelBehavior, modelBehaviorDetails, modelBehaviorOverview } from "./model-behavior.js";
import { semanticReviewRecords, semanticReviewSummary, validateSemanticReviews } from "./stability-semantic-review.js";
import schema from "../../../../schemas/workflow/stability.schema.json" with { type: "json" };

function judgment(task: PlannedTask, state: RunState) {
  const receipt = state.receipts[task.id];
  if (!receipt) return null;
  const result = receipt.evaluation as ComparisonResult;
  if (result.status !== "decided") return null;
  const data = task.data as TaskData, tiers = tierOf(result.ranking);
  const decision = decideVerdict(result.assessments.A.meets_core!, result.assessments.B.meets_core!, tiers.get("A")!, tiers.get("B")!);
  // Accepted Host submissions are already decoded and schema-validated objects. Never infer an old/missing submission from prose.
  const submitted = receipt.submitted;
  const selected = submitted && typeof submitted === "object" && !Array.isArray(submitted) &&
    Object.hasOwn(submitted, "relative_preference") ? (submitted as { relative_preference?: unknown }).relative_preference : undefined;
  const preference = selected === null ? { status: "available", version: null } :
    typeof selected === "string" && Object.hasOwn(data.candidates, selected) ? { status: "available", version: data.candidates[selected].version } :
      { status: "unavailable", version: null };
  return {
    outcome: decision.winner ? "winner:" + data.candidates[decision.winner === "first" ? "A" : "B"].version : decision.outcome,
    core: Object.fromEntries(Object.entries(result.assessments).map(([label, assessment]) => [data.candidates[label].version, assessment.meets_core])),
    ranking: result.ranking.map(tier => tier.map(label => data.candidates[label].version).sort()),
    preference,
  };
}

/** Pure aggregation; no experiment verdict is substituted for its source result. */
export function stabilityReport(state: RunState, source?: RunState, reviewRecords: unknown = []) {
  const config = state.manifest.config as StabilityConfig, cases = config.stability.cases;
  const semanticReviews = validateSemanticReviews(state, reviewRecords);
  const semanticSummary = semanticReviewSummary(state.manifest.tasks, state.receipts, semanticReviews);
  const conditions = new Map<string, { evaluator_version: string; judge: string; stage: string; accepted: number;
    parameters: StabilityTaskData["stability"]["condition"] | null }>();
  const materialConditions = new Map<string, Set<string>>();
  for (const task of state.manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (!receipt) continue;
    const entry = { evaluator_version: receipt.evaluatorVersion, judge: receipt.judge, stage: task.stage,
      parameters: (task.data as StabilityTaskData).stability.condition ?? null };
    const key = canonical(entry), prior = conditions.get(key);
    conditions.set(key, { ...entry, accepted: (prior?.accepted ?? 0) + 1 });
    for (const [source, revision] of Object.entries((task.data as StabilityTaskData).stability.materials ?? {}))
      (materialConditions.get(source) ?? materialConditions.set(source, new Set()).get(source)!).add(revision);
  }
  const materialChanges = [...materialConditions].filter(([, revisions]) => revisions.size > 1)
    .map(([source, revisions]) => ({ source, revisions: [...revisions] }));
  const mixed = materialChanges.length > 0 || ["criteria", "attribution-component", "attribution-trace", "attribution-session", "comparison", "rewrite"].some(stage => [...conditions.values()].filter(item => item.stage === stage).length > 1);
  const caseRates: number[] = [], directionDifferences: number[] = [];
  const distribution = (tasks: PlannedTask[]) => {
    const unresolved: Record<string, number> = {};
    for (const task of tasks) {
      if (judgment(task, state)) continue;
      const receipt = state.receipts[task.id], status = receipt && (receipt.evaluation as ComparisonResult).status === "needs_review"
        ? "needs_review" : state.manifest.states[task.id].status;
      unresolved[status] = (unresolved[status] ?? 0) + 1;
    }
    return { ...outcomeDistribution(tasks.map(task => judgment(task, state)?.outcome ?? null)), unresolved_by_status: unresolved };
  };
  const samples = cases.map(item => {
    const key = stabilityCaseKey(item), tasks = state.manifest.tasks.filter(task => (task.data as StabilityTaskData).stability.case_key === key);
    const baselineTask = source ? source.manifest.tasks.find(task => task.id === item.source_task_id) :
      tasks.find(task => task.stage === "comparison" && (task.data as StabilityTaskData).stability.purpose === "baseline");
    const baseline = baselineTask && judgment(baselineTask, source ?? state);
    const repeats = tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison")
      .sort((a, b) => (a.data as StabilityTaskData).stability.order! - (b.data as StabilityTaskData).stability.order!);
    const ab = repeats.filter(task => (task.data as StabilityTaskData).stability.orientation === "AB");
    const ba = repeats.filter(task => (task.data as StabilityTaskData).stability.orientation === "BA");
    const original = ab.map(task => judgment(task, state)), swapped = ba.map(task => judgment(task, state));
    const completePairs = original.flatMap((value, index) => value && swapped[index] ? [[value, swapped[index]!] as const] : []);
    const agreeing = completePairs.filter(([a, b]) => a.outcome === b.outcome).length;
    const sameCore = completePairs.filter(([a, b]) => canonical(a.core) === canonical(b.core)).length;
    const sameRanking = completePairs.filter(([a, b]) => canonical(a.ranking) === canonical(b.ranking)).length;
    const transitions = new Map<string, { from: string; to: string; count: number }>();
    for (const [a, b] of completePairs) {
      const key = canonical([a.outcome, b.outcome]), previous = transitions.get(key);
      transitions.set(key, { from: a.outcome, to: b.outcome, count: (previous?.count ?? 0) + 1 });
    }
    const fixedVersion = item.answers[0].version;
    let winsAtA = 0, winsAtB = 0;
    for (let index = 0; index < original.length; index++) {
      const originalResult = original[index], swappedResult = swapped[index];
      if (!originalResult || !swappedResult) continue;
      const originallyAtA = (ab[index].data as TaskData).candidates.A.version === fixedVersion;
      const atA = originallyAtA ? originalResult : swappedResult, atB = originallyAtA ? swappedResult : originalResult;
      winsAtA += Number(atA.outcome === "winner:" + fixedVersion);
      winsAtB += Number(atB.outcome === "winner:" + fixedVersion);
    }
    const winRateAtA = completePairs.length ? winsAtA / completePairs.length : null;
    const winRateAtB = completePairs.length ? winsAtB / completePairs.length : null;
    const positionDifference = winRateAtA === null || winRateAtB === null ? null : winRateAtA - winRateAtB;
    const complete = completePairs.length === 5;
    const preferenceValue = (value: ReturnType<typeof judgment>) => value?.preference.status === "available"
      ? value.preference.version === null ? "no_preference" : "prefer:" + value.preference.version : null;
    const preferencePairs = completePairs.filter(([a, b]) => a.preference.status === "available" && b.preference.status === "available");
    if (complete) {
      caseRates.push(agreeing / 5);
      directionDifferences.push(positionDifference!);
    }
    const rewriteTasks = tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "rewrite");
    const full = tasks.filter(task => task.stage === "comparison" && (task.data as StabilityTaskData).stability.purpose === "end_to_end");
    const rewritten = rewriteTasks.filter(task => state.receipts[task.id]);
    return { batch_id: item.batch_id, case_id: item.case_id, risks: item.risks,
      source: item.answers.map(answer => ({ version: answer.version, file: answer.source, line: answer.line })),
      baseline_task_id: baselineTask?.id ?? null, baseline: baseline?.outcome ?? null,
      original: distribution(ab), swapped: distribution(ba),
      relative_preference: { original: outcomeDistribution(original.map(preferenceValue)), swapped: outcomeDistribution(swapped.map(preferenceValue)),
        complete_pairs: preferencePairs.length, agreements: preferencePairs.filter(([a, b]) => a.preference.version === b.preference.version).length },
      paired: { complete_pairs: completePairs.length, outcome_agreements: agreeing, core_agreements: sameCore, ranking_agreements: sameRanking,
        transitions: [...transitions.values()], position: { version: fixedVersion, win_rate_at_A: winRateAtA,
          win_rate_at_B: winRateAtB, difference_A_minus_B: positionDifference } },
      source_agreements: baseline ? original.filter(value => value?.outcome === baseline.outcome).length : null,
      semantic_review: semanticReviewSummary(tasks, state.receipts, semanticReviews),
      rewrite: { planned: rewriteTasks.length, accepted: rewritten.length, decision_storage_unchanged: true,
        semantic_review: semanticReviewSummary(rewriteTasks, state.receipts, semanticReviews).status, task_ids: rewriteTasks.map(task => task.id) },
      end_to_end: { ...distribution(full),
        planned: full.length, task_ids: tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "end_to_end").map(task => task.id) },
      trials: repeats.map(task => { const trial = (task.data as StabilityTaskData).stability;
        return { task_id: task.id, repeat: trial.repeat, orientation: trial.orientation,
          state: state.manifest.states[task.id].status, attempts: state.manifest.states[task.id].attempts, result: judgment(task, state),
          review_status: (state.receipts[task.id]?.evaluation as ComparisonResult | undefined)?.status ?? null,
          candidate_slots: Object.fromEntries(Object.entries((task.data as TaskData).candidates).map(([label, candidate]) => [label, candidate.version])),
          material_revisions: trial.materials ?? {},
          evaluator_version: state.receipts[task.id]?.evaluatorVersion ?? null, judge: state.receipts[task.id]?.judge ?? null };
      }), complete,
    };
  });
  const attempts = state.manifest.cumulativeAttempts ?? Object.values(state.manifest.states).reduce((sum, task) => sum + task.attempts, 0);
  const statuses: Record<string, number> = {};
  for (const task of Object.values(state.manifest.states)) statuses[task.status] = (statuses[task.status] ?? 0) + 1;
  const maxAttempts = state.manifest.executionLimits?.maxAttempts ?? config.stability.maxAttempts;
  const stopStartingAt = state.manifest.executionLimits?.stopStartingAt ?? config.stability.stopStartingAt;
  const complete = state.manifest.tasks.every(task => !!state.receipts[task.id]);
  const acceptedNeedsReview = state.manifest.tasks.filter(task => task.stage === "comparison" &&
    (state.receipts[task.id]?.evaluation as ComparisonResult | undefined)?.status === "needs_review").length;
  const execution = {
    status: state.manifest.status, stop_reason: state.manifest.executionStopReason ?? null,
    paused_stages: structuredClone(state.manifest.pausedStages ?? []),
    tasks: state.manifest.tasks.map(task => {
      const current = state.manifest.states[task.id], receipt = state.receipts[task.id];
      const reason = current.reason ?? current.failure?.errors[0]?.message ?? null;
      return { task_id: task.id, case_key: (task.data as StabilityTaskData).stability.case_key,
        purpose: (task.data as StabilityTaskData).stability.purpose, stage: task.stage,
        status: current.status, attempts: current.attempts, in_execution_scope: !state.manifest.executionScope || state.manifest.executionScope.includes(task.id),
        attempt_id: current.attemptId ?? receipt?.attemptId ?? current.failure?.attemptId ?? null,
        submission_id: receipt?.submissionId ?? null, current_reason: reason && reason.length > 500 ? reason.slice(0, 499) + "…" : reason,
        current_failure_codes: (current.failure?.errors ?? []).map(({ category, code, path }) => ({ category, code, path })),
        waiting_for_task_ids: receipt ? [] : Object.values(task.dependencies).filter(id => !state.receipts[id]),
      };
    }),
    history: { file: "log/runtime.log", relative_to: "repository_root", lookup_keys: ["run_id", "task_id", "attempt_id"],
      note: "Task rows describe the current checkpoint, not all previous attempts. Successful recovery clears current failure details; historical failures remain in the unified runtime log. Reasons are limited to 500 characters; full current details are in state.json." },
  };
  const inferenceStatus = mixed ? "mixed_conditions" : "exploratory_pilot";
  return { run_id: state.manifest.runId, status: complete ? "completed" : "incomplete", experiment: "validate-stability",
    source_run: config.stability.sourceRun ?? null, seed: config.stability.seed,
    quality: { accepted_needs_review: acceptedNeedsReview, incomplete_comparison_cases: samples.filter(item => !item.complete).length,
      rewrite_semantic_review: semanticSummary.status },
    semantic_review: { summary: semanticSummary, records: semanticReviews },
    scope: { selected_cases: cases.length, complete_comparison_cases: samples.filter(item => item.complete).length,
      selection: config.stability.selection, independent_unit: "case", repetitions_per_orientation: 5,
      limits: ["Stability does not establish correctness or population fairness.",
        "Cases were selected for risk coverage; uncertainty is descriptive and exploratory.",
        "Repeated calls on the same case are not independent samples.",
        "Rewrite text requires semantic review; immutable stored decisions do not prove faithful wording."] },
    budget: { planned_stage_attempts: state.manifest.tasks.length, attempted: attempts, limit: maxAttempts,
      remaining: Math.max(0, maxAttempts - attempts), stop_starting_at: stopStartingAt === undefined ? null : new Date(stopStartingAt).toISOString(),
      stop_reason: state.manifest.executionStopReason ?? null, statuses, accepted_needs_review: acceptedNeedsReview },
    execution, conditions: [...conditions.values()], material_changes: materialChanges, samples,
    statistics: { status: inferenceStatus,
      swap_agreement: mixed ? { status: "mixed_conditions", n: caseRates.length, mean: null, interval_95: null } : caseBootstrap(caseRates, config.stability.seed),
      direction_sign_test: mixed ? { status: "mixed_conditions", p_value: null } : exactSignTest(directionDifferences),
      position_definition: "For each case, one fixed answer's win rate in slot A minus its win rate in slot B. Ties are not wins. Only complete paired cases enter the sign test.",
      t_test: { status: "not_applicable", reason: "The evaluator returns categorical verdicts, not a continuous score." },
      decision_rule: "No significance threshold or majority vote changes a source verdict; no base-model ranking is produced." },
  };
}

export async function reportStability(run: string): Promise<Record<string, unknown>> {
  const state = await stabilityRepository.readRun(run), config = state.manifest.config as StabilityConfig;
  const source = config.stability.sourceRun ? await comparisonRepository.readRun(config.stability.sourceRun) : undefined;
  let reviews: unknown = [];
  try { reviews = semanticReviewRecords(await readJson(path.join(run, "semantic-review.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const report = stabilityReport(state, source, reviews), validate = new Ajv2020({ strict: false }).compile(schema);
  if (!validate(report)) throw new Error("Invalid stability report: " + JSON.stringify(validate.errors));
  await writeJson(path.join(run, "validation.json"), report);
  const selectedSourceIds = new Set(config.stability.sourceReceipts.map(reference => reference.task_id));
  const baselineTasks = source ? source.manifest.tasks.filter(task => selectedSourceIds.has(task.id)) :
    state.manifest.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "baseline");
  const behavior = modelBehavior(baselineTasks, source?.receipts ?? state.receipts);
  await writeJsonl(path.join(run, "model-behavior.jsonl"), behavior.rows);
  await atomicWrite(path.join(run, "task_summaries.md"), modelBehaviorDetails(behavior.rows).join("\n") + "\n");
  const semanticSummary = report.semantic_review.summary;
  const rows = report.samples.map(sample => `| ${sample.batch_id} / ${sample.case_id} | ${sample.original.completed}/5 | ${sample.swapped.completed}/5 | ${sample.paired.outcome_agreements}/${sample.paired.complete_pairs} | ${sample.relative_preference.agreements}/${sample.relative_preference.complete_pairs} | ${sample.rewrite.accepted}/${sample.rewrite.planned} | ${sample.end_to_end.completed}/${sample.end_to_end.planned} | ${sample.semantic_review.reviewed}/${sample.semantic_review.accepted} · ${sample.semantic_review.status} |`);
  await atomicWrite(path.join(run, "validation.md"), [
    `# 稳定性实验：${report.run_id}`, "", `运行状态：${report.execution.status}。计划收据覆盖：${report.status}。覆盖 ${report.scope.selected_cases} 题，完整换位实验 ${report.scope.complete_comparison_cases} 题。`, "",
    `阶段尝试：${report.budget.attempted}/${report.budget.limit}；停止原因：${report.budget.stop_reason ?? "无"}。失败和重试均计入，续跑不清零。`, "",
    `当前阶段暂停：${report.execution.paused_stages.map(pause => `${pause.stage}: ${pause.category}/${pause.code} ${pause.path}`).join("；") || "无"}。validation.json 的 execution.tasks 保留全部 ${report.execution.tasks.length} 个原计划任务，包括未派发改写与整链各阶段；状态、尝试数、当前原因和等待依赖均来自当前检查点。`, "",
    "当前原因最多展示 500 字符，完整上下文见 state.json。成功恢复后的历史失败不会伪造为当前失败；按 run_id、task_id、attempt_id 查询仓库根目录 log/runtime.log。", "",
    `已接受并停止排名、等待复核的对比：${report.quality.accepted_needs_review}。待核单列为未裁决，不算执行失败、平局或胜负；改写语义审查：${report.quality.rewrite_semantic_review}。`, "",
    "验收按影响分层：身份串位、捏造证据或改写反意必须阻断；关键口径冲突未解决时应停止排名；独立充分胜因仍成立的局部措辞或次要理由缺陷可带缺陷通过，在审阅理由中保留。", "",
    "正确识别关键冲突并待核可以通过机制验收，裁决仍待复核；仅有 needs_review 状态不证明冲突识别正确。未审改写保持未审，语义失败不会被执行成功或其他样本通过抵消。", "",
    `语义审阅覆盖全部改写（含整链）：计划 ${semanticSummary.planned}，已接受 ${semanticSummary.accepted}，已审 ${semanticSummary.reviewed}，失败 ${semanticSummary.failed}，未审 ${semanticSummary.unreviewed}。未审数只计已接受但尚未审阅的文本。`, "",
    "| 样本 | 原位已裁决 | 换位已裁决 | 配对结论一致 | 相对偏好一致 | 改写完成 | 整链裁决完成 | 语义已审/已接受 |", "| --- | --- | --- | --- | --- | --- | --- | --- |", ...rows, "",
    `探索性统计：${report.statistics.status}；换位方向 sign test p=${report.statistics.direction_sign_test.p_value ?? "不适用"}。`, "",
    "T 检验不适用：当前输出为类别判决，没有连续分数。每题是一个统计单位，5 次重复不算 5 题。", "",
    "这份报告说明选定样本上的重复与换位稳定性，不能证明结论正确、总体公平或某个底座模型更好。改写文本仍须按验收清单审查语义；程序只保证正式判决未被改写。", "",
    "完整任务 ID、失败状态、条件和原始来源坐标见 validation.json；实验结果保存在 results/stability-results.jsonl，不写入生产统计。", "",
    ...(report.semantic_review.records.length ? ["审阅来源、理由和精确提交 ID 见 [semantic-review.json](semantic-review.json) 及 validation.json；代理审阅不等同人工金标。", ""] : []),
    modelBehaviorOverview(behavior.summary), "",
  ].join("\n"));
  return report;
}
