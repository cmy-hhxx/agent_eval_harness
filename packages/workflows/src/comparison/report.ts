import { localFiles } from "@eval/data";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonObject, PlannedTask, SubmissionReceipt, Usage } from "@eval/contracts";
import { atomicWrite, exists, internalPath, locateRun, readJson, writeJson, writeJsonl } from "@eval/data";
import { canonical } from "@eval/contracts";
import type { AttributionResult, ComparisonResult, EvalConfig, Finding, TaskData } from "./types.js";
import { toRewrites, type RewriteResult, type Rewrites } from "@eval/agents/rewrite";
import { outputSchema } from "./schema.js";
import { comparisonRow, stageResult } from "./results.js";
import { loadRunInputs, readRunState, writeRunState, createResultWriter } from "./run-data.js";
import { syncProblemLibrary, type ProblemLibraryStats } from "./problem-library.js";
import { polishComparisonRow, type CommentaryLookup } from "./commentary.js";
import { taskCase, taskIdentity } from "./input.js";

interface HeadToHeadStats {
  evaluated: number;
  wins: Record<string, number>;
  both_good: number;
  both_bad: number;
}
interface Standing {
  entered: number;
  meets_core: number;
  first_tier: number;
  tier_sum: number;
  wins: number;
  both_good: number;
  both_bad: number;
}

function summarizeResults(
  tasks: PlannedTask[],
  outcomes: JsonObject[],
  attribution: JsonObject[],
  comparisons: JsonObject[],
  skipped: JsonObject[],
  issues: JsonObject[],
) {
  const cases = new Set([
    ...tasks
      .filter((task) => task.stage === "attribution" || task.stage === "comparison")
      .map((task) => {
        const c = taskCase(task.data as TaskData);
        return canonical([c.batch_id, c.case_id]);
      }),
    ...skipped.map((item) => canonical([item.batch_id, item.case_id])),
  ]);
  const statuses: Record<string, number> = {};
  for (const outcome of outcomes) {
    const status = String(outcome.status);
    statuses[status] = (statuses[status] || 0) + 1;
  }
  const headToHead: Record<string, HeadToHeadStats> = {};
  const standings: Record<string, Standing> = {};
  const standing = (version: string) =>
    (standings[version] ??= {
      entered: 0,
      meets_core: 0,
      first_tier: 0,
      tier_sum: 0,
      wins: 0,
      both_good: 0,
      both_bad: 0,
    });
  for (const row of comparisons) {
    for (const version of Object.keys((row.models as JsonObject) || {})) {
      const stats = standing(version);
      stats.entered++;
      const assessment = (row.assessments as Record<string, { meets_core: boolean } | undefined>)[
        version
      ];
      if (assessment) {
        if (assessment.meets_core) stats.meets_core++;
        stats.first_tier += Number(
          (row.ranking as string[][]).some((tier, index) => index === 0 && tier.includes(version)),
        );
        const tier = (row.ranking as string[][]).findIndex((tier) => tier.includes(version));
        if (tier >= 0) stats.tier_sum += tier;
      }
    }
    for (const [name, verdict] of Object.entries((row.verdicts as Record<string, JsonObject>) || {})) {
      const stats = (headToHead[name] ??= {
        evaluated: 0,
        wins: Object.fromEntries(name.split("__vs__").map((v) => [v, 0])),
        both_good: 0,
        both_bad: 0,
      });
      stats.evaluated++;
      const result = String(verdict.result);
      if (result === "win") {
        const winner = String(verdict.winner_version);
        stats.wins[winner] = (stats.wins[winner] || 0) + 1;
        standing(winner).wins++;
        const loser = name.split("__vs__").find((v) => v !== winner);
        if (loser) standing(loser);
      } else {
        stats[result as "both_good" | "both_bad"]++;
        for (const version of name.split("__vs__")) standing(version)[result as "both_good" | "both_bad"]++;
      }
    }
  }
  const perVersion: Record<
    string,
    {
      correct: number;
      incorrect: number;
      undetermined: number;
      evaluated?: number;
      decidable_coverage?: number | null;
      accuracy_among_decidable?: number | null;
    }
  > = {};
  for (const row of attribution) {
    const stats = (perVersion[String(row.version)] ??= {
      correct: 0,
      incorrect: 0,
      undetermined: 0,
    });
    stats[row.is_correct === true ? "correct" : row.is_correct === false ? "incorrect" : "undetermined"]++;
  }
  for (const stats of Object.values(perVersion)) {
    const total = stats.correct + stats.incorrect + stats.undetermined,
      decided = stats.correct + stats.incorrect;
    stats.evaluated = total;
    stats.decidable_coverage = total ? decided / total : null;
    stats.accuracy_among_decidable = decided ? stats.correct / decided : null;
  }
  const rounded = Object.fromEntries(
    Object.entries(standings).map(([version, stats]) => [
      version,
      {
        ...stats,
        meets_core_rate: stats.entered ? stats.meets_core / stats.entered : null,
        average_tier: stats.entered ? Math.round((stats.tier_sum / stats.entered) * 1e6) / 1e6 : null,
      },
    ]),
  );
  return {
    planned: {
      cases: cases.size,
      tasks: tasks.length,
      skipped_groups: skipped.length,
      input_issues: issues.length,
    },
    task_statuses: statuses,
    completed_comparisons: comparisons.length,
    head_to_head: headToHead,
    standings: rounded,
    ...(Object.values(perVersion).some((stats) => stats.evaluated) ? { per_version: perVersion } : {}),
  };
}

export async function reportRun(run: string, options: { details?: boolean } = {}): Promise<JsonObject> {
  const layout = locateRun(run);
  const state = await readRunState(run),
    manifest = state.manifest;
  if (options.details && !manifest.debug) throw new Error("--details 需要启用 --debug 的运行");
  const config = manifest.config as EvalConfig,
    names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const receipts = new Map<string, SubmissionReceipt>();
  const needsInputs = manifest.tasks.some(
    (task) => task.stage === "comparison" && state.receipts[task.id] && !state.receipts[task.id].exported,
  );
  const inputs = needsInputs ? await loadRunInputs(manifest) : {};
  for (const task of manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (receipt) {
      if (receipt.status !== "succeeded" || receipt.taskId !== task.id)
        throw new Error(`Invalid receipt: ${task.id}`);
      receipts.set(task.id, receipt);
    }
  }
  // Accepted rewrites are presentation-only; reports prefer them, formal JSONL keeps the judge wording alongside rewritten.
  const commentaryBySource = new Map<string, Rewrites>();
  for (const task of manifest.tasks) {
    if (task.stage !== "rewrite") continue;
    const source = (task.data as TaskData).rewriteOf!;
    const receipt = receipts.get(task.id);
    const exported = receipt?.exported ?? receipts.get(source.taskId)?.exported;
    const stored = exported ? stageResult(source.stage, exported.row).rewritten as RewriteResult | undefined : undefined;
    const evaluation = receipt?.evaluation as RewriteResult | undefined;
    if (stored || evaluation)
      commentaryBySource.set(source.taskId, toRewrites({ rewrites: [...(stored?.rewrites ?? []), ...(evaluation?.rewrites ?? [])] }));
  }
  const commentary: CommentaryLookup = { of: (sourceTaskId) => commentaryBySource.get(sourceTaskId || "") };
  // Persist both stages before compacting the ledger, including checkpoint-only recovery.
  await createResultWriter(run, inputs)(state);
  const problemLibrary = await syncProblemLibrary(state);
  const comparisons: JsonObject[] = [],
    outcomes: JsonObject[] = [],
    attribution: JsonObject[] = [],
    summaries: JsonObject[] = [];
  const markdown: string[] = [];
  const savedSchema = manifest.debug ? await readJson(internalPath(run, "output_schema.json")) : outputSchema;
  const ajv = new Ajv2020({ strict: false, allErrors: true }),
    validateOutput = ajv.compile(savedSchema);
  for (const task of manifest.tasks) {
    const data = task.data as TaskData,
      receipt = receipts.get(task.id);
    const status: string = receipt ? "succeeded" : manifest.states[task.id]?.status || "pending";
    outcomes.push({
      task_id: task.id,
      stage: task.stage,
      status,
      case: taskIdentity(data),
      candidates: data.candidates,
      reason: manifest.states[task.id]?.reason || null,
    });
    // Rewrite and clustering receipts feed the report view, not the per-case result sections.
    if (task.stage === "rewrite" || task.stage === "clustering") continue;
    if (!receipt) {
      markdown.push(
        `# ${data.candidates.A.batch_id} / ${data.candidates.A.case_id}`,
        "",
        `**状态**：${status}（${task.stage}）`,
        "",
        `**原因**：${manifest.states[task.id]?.reason || "尚未完成"}`,
        "",
        `**问题**：${data.candidates.A.question}`,
        "",
        "---",
        "",
      );
      continue;
    }
    if (data.stage === "attribution") {
      attribution.push({
        ...data.candidates.A,
        ...(receipt.evaluation as AttributionResult),
        task_id: task.id,
      });
      continue;
    }
    const result = receipt.evaluation as ComparisonResult,
      row = receipt.exported?.row || comparisonRow(inputs, task, result, receipts, names, receipt.evaluatorVersion);
    if (!validateOutput(row)) throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
    comparisons.push(row);
    receipt.exported = { id: String(row.comparison_id), row };
    const view = polishComparisonRow(row, task, names, commentary);
    const analysis = view.task_analysis as ComparisonResult["task_analysis"];
    const reviews = view.evaluations as Record<
      string,
      { summary: string; findings: Finding[]; is_correct: boolean | null; correctness_reason: string }
    >;
    const verdicts = view.verdicts as Record<string, JsonObject>;
    const candidates = Object.fromEntries(
      Object.entries(reviews).map(([id, review]) => [
        id,
        {
          model: (view.models as JsonObject)[id],
          assessment: (view.assessments as JsonObject)[id],
          is_correct: review.is_correct,
          summary: review.summary,
          strengths: review.findings.filter((f) => f.type === "strength"),
          weaknesses: review.findings.filter((f) => f.type === "problem"),
        },
      ]),
    );
    summaries.push({
      request_time: view.request_time,
      has_standard_answer: view.has_standard_answer,
      evaluator_version: view.evaluator_version,

      comparison_id: view.comparison_id,
      case: view.case,
      question: data.candidates[Object.keys(data.candidates)[0]!]!.question,
      task_type: analysis.task_type,
      goal: analysis.goal,
      requirements: analysis.requirements,
      ranking: view.ranking,
      assessments: view.assessments,
      decision_basis: view.decision_basis,
      verdicts,
      candidates,
      scoring_points: analysis.scoring_points,
      red_flags: analysis.red_flags,
    });
    const first = data.candidates[Object.keys(data.candidates)[0]!]!;
    markdown.push(
      `# ${first.batch_id} / ${first.case_id}`,
      "",
      `**排名**：${(view.ranking as string[][])
        .map((tier, index) => `${index + 1}. ${tier.map((v) => names[v] || v).join("、")}`)
        .join("；")}`,
      "",
      "**两两结论**",
      "",
      ...Object.entries(verdicts).map(
        ([pair, verdict]) =>
          `- ${pair.split("__vs__").map((v) => names[v] || v).join(" vs ")}：${verdict.reason}`,
      ),
      "",
      "## 问题",
      "",
      first.question,
      "",
      analysis.goal,
      "",
      "## 要求",
      "",
      ...analysis.requirements.map((v) => `- ${v}`),
      "",
    );
    const basis = view.decision_basis as ComparisonResult["decision_basis"];
    const versions = Object.keys(view.assessments as JsonObject);
    const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
    const importance = { high: "高", medium: "中", low: "低" };
    markdown.push("## 裁决短评", "", basis.tradeoff, "", "## 同项对比", "",
      `| 比较点 | 重要性 | ${versions.map((version) => cell(names[version] || version)).join(" | ")} |`,
      `| --- | --- | ${versions.map(() => "---").join(" | ")} |`,
      ...basis.comparisons.map((item) => `| ${cell(item.aspect)} | ${importance[item.importance]} | ${versions.map((version) =>
        cell((item.better_candidates.includes(version) ? "本项更好：" : "") + item.assessments[version]!.summary),
      ).join(" | ")} |`), "");
    const timingLines = Object.values(data.candidates)
      .filter((c) => c.answer_timing.finish_seconds !== null)
      .map((c) => `${names[c.version]}：${c.answer_timing.finish_seconds!.toFixed(3)} 秒`);
    if (timingLines.length) markdown.push("**原始回答耗时**：" + timingLines.join("；"), "");
    for (const [id, review] of Object.entries(reviews)) {
      const assessment = (view.assessments as JsonObject)[id] as { meets_core: boolean; summary: string };
      markdown.push(
        `## ${names[id] || id}（${assessment.meets_core ? "完成核心要求" : "未完成核心要求"}）`,
        "",
        assessment.summary,
        "",
      );
      for (const finding of review.findings) {
        markdown.push(
          `- **${finding.type === "strength" ? "优势" : "不足"}｜${finding.text}**：${finding.reason}`,
          "",
          `影响：${finding.assessment.impact}`,
          "",
        );
        const trace = finding.stage_trace as { tools: string[]; confidence: string } | undefined;
        if (trace?.tools.length)
          markdown.push(`工具回溯：${trace.tools.join("、")}（${trace.confidence}）`, "");
        for (const evidence of finding.evidence)
          markdown.push(`> 原始消息 #${evidence.message_index}：${evidence.quote.replaceAll("\n", " ")}`, "");
      }
    }
    markdown.push(
      "## 得分点",
      "",
      ...analysis.scoring_points.map((v) => `- ${v}`),
      "",
      "## Red flags",
      "",
      ...analysis.red_flags.map((v) => `- ${v}`),
      "",
      "---",
      "",
    );
  }
  const results = layout.results;
  await localFiles.mkdir(results, { recursive: true });
  for (const old of await localFiles.list(results))
    if (
      old.endsWith(".jsonl") &&
      !["attribution.jsonl", "comparison.jsonl", "clustering.jsonl"].includes(
        old,
      )
    )
      await localFiles.remove(path.join(results, old));
  if (comparisons.length) await writeJsonl(path.join(results, "comparison.jsonl"), comparisons);
  else await localFiles.remove(path.join(results, "comparison.jsonl"), { force: true });
  const exports = internalPath(run, "exports");
  if (manifest.debug && (options.details || (await exists(exports)))) {
    await writeJsonl(path.join(exports, "task_outcomes.jsonl"), outcomes);
    await writeJsonl(path.join(exports, "task_summaries.jsonl"), summaries);
  }
  async function writeDetail(name: string, rows: unknown[]) {
    if (!manifest.debug) return;
    const file = internalPath(run, "diagnostics", name + ".jsonl");
    if (rows.length) await writeJsonl(file, rows);
    else await localFiles.remove(file, { force: true });
  }
  const skipped = (manifest.preflight.skipped as JsonObject[] | undefined) || [];
  const issues = (manifest.preflight.issues as JsonObject[] | undefined) || [];
  if (skipped.length)
    markdown.push(
      "# 跳过的输入",
      "",
      ...skipped.map(
        (item) =>
          `- ${item.batch_id} / ${item.case_id}：${item.reason}（${(item.versions as string[]).join("、")}）` +
          ((item.sources as { source: string; line: number }[] | undefined)
            ?.map((source) => ` ${source.source}:${source.line}`)
            .join("；") || ""),
      ),
      "",
    );
  if (issues.length)
    markdown.push(
      "# 输入异常",
      "",
      ...issues.map(
        (item) =>
          `- ${item.batch_id || "批次未知"} / ${item.case_id || "case 未知"}：${item.reason}` +
          (item.source ? `（${item.source}${item.line ? `:${item.line}` : ""}）` : ""),
      ),
      "",
    );
  await atomicWrite(layout.summaries, markdown.join("\n"));
  await writeDetail(
    "failures",
    outcomes.filter((v) => ["failed", "blocked", "cancelled", "timed_out"].includes(String(v.status))),
  );
  await writeDetail("skipped", (manifest.preflight.skipped as unknown[]) || []);
  const attemptUsage = state.usage;
  const missingMetrics = Math.max(
    0,
    Object.values(manifest.states).reduce((n, task) => n + task.attempts, 0) - state.recordedAttempts,
  );
  const inputTokens = attemptUsage.input + attemptUsage.cacheRead + attemptUsage.cacheWrite;
  const totals = summarizeResults(manifest.tasks, outcomes, attribution, comparisons, skipped, issues);
  const measured = manifest.tasks.flatMap((task) => {
    const receipt = receipts.get(task.id),
      failure = manifest.states[task.id].failure;
    const submissions = receipt?.submissionStats?.contentSubmissions ?? failure?.contentSubmissions;
    return submissions ? [{ submissions, accepted: !!receipt }] : [];
  });
  const durations = Object.values(manifest.states)
    .flatMap((state) => (state.durationMs ? [state.durationMs / 1000] : []))
    .sort((a, b) => a - b);
  const quality = {
    submission_metrics_tasks: measured.length,
    first_submission_pass_rate: measured.length
      ? measured.filter((r) => r.accepted && r.submissions === 1).length / measured.length
      : null,
    content_repairs: measured.reduce((sum, r) => sum + r.submissions - 1, 0),
    repeated_error_tasks: Object.values(manifest.states).filter(
      (s) => (s.repeatedErrors ?? s.failure?.repeatedErrors ?? 0) >= 2,
    ).length,
    repeated_error_rate: measured.length
      ? Object.values(manifest.states).filter(
          (s) => (s.repeatedErrors ?? s.failure?.repeatedErrors ?? 0) >= 2,
        ).length / measured.length
      : null,
    attempts_per_accepted_task: receipts.size
      ? Object.values(manifest.states).reduce((n, s) => n + s.attempts, 0) / receipts.size
      : null,
    tokens_per_accepted_task: receipts.size ? attemptUsage.totalTokens / receipts.size : null,
    p50_seconds: durations.length ? durations[Math.floor((durations.length - 1) * 0.5)] : null,
    p95_seconds: durations.length ? durations[Math.floor((durations.length - 1) * 0.95)] : null,
  };
  const batches = new Set([
    ...manifest.tasks.map((task) => taskIdentity(task.data as TaskData).batch_id),
    ...skipped.map((item) => String(item.batch_id)),
    ...issues.flatMap((item) => (item.batch_id ? [String(item.batch_id)] : [])),
  ]);
  const byBatch = Object.fromEntries(
    [...batches].sort().map((batch) => {
      // Per-batch standings duplicate the run-level table; keep only counts here.
      const { standings: _standings, ...stats } = summarizeResults(
        manifest.tasks.filter((task) => taskIdentity(task.data as TaskData).batch_id === batch),
        outcomes.filter((outcome) => (outcome.case as { batch_id: string }).batch_id === batch),
        attribution.filter((row) => row.batch_id === batch),
        comparisons.filter((row) => (row.case as JsonObject).batch_id === batch),
        skipped.filter((item) => item.batch_id === batch),
        issues.filter((item) => item.batch_id === batch),
      );
      return [batch, stats];
    }),
  );
  const resultArtifacts = ["results/attribution.jsonl"];
  if (comparisons.length) resultArtifacts.push("results/comparison.jsonl");
  if (manifest.tasks.some((task) => task.stage === "clustering" && receipts.has(task.id)))
    resultArtifacts.push("results/clustering.jsonl");
  const evaluatorVersions = [...new Set([...receipts.values()].map((receipt) => receipt.evaluatorVersion))].sort();
  const judgeModels: Record<string, string[]> = {};
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (!receipt) continue;
    const models = (judgeModels[task.stage] ??= []);
    if (!models.includes(receipt.judge)) models.push(receipt.judge);
  }
  for (const models of Object.values(judgeModels)) models.sort();
  const executionStatuses: Record<string, number> = {};
  const executionScope = manifest.executionScope && new Set(manifest.executionScope);
  for (const task of manifest.tasks) if (!executionScope || executionScope.has(task.id)) {
    const status = manifest.states[task.id].status;
    executionStatuses[status] = (executionStatuses[status] ?? 0) + 1;
  }
  const summary = {
    debug: manifest.debug,
    run_id: manifest.runId,
    status: manifest.status,
    evaluator_versions: evaluatorVersions,
    judge_models: judgeModels,
    ...totals,
    execution_task_statuses: executionStatuses,
    paused_stages: manifest.pausedStages ?? [],
    quality,
    by_batch: byBatch,
    ...(Object.keys(problemLibrary).length ? { problem_library: problemLibrary } : {}),
    artifacts: {
      authoritative: "results/",
      results: resultArtifacts,
      report: "report.md",
      summaries: "task_summaries.md",
      state: "state.json",
    },
    tokens: attemptUsage,
    attempts_without_final_metrics: missingMetrics,
    cache: {
      model_input: {
        hit_rate: inputTokens ? attemptUsage.cacheRead / inputTokens : null,
      },
    },
    wall_seconds: ((manifest.finishedAt || Date.now()) - manifest.startedAt) / 1000,
  };
  // Replace statistics so rebuilt exports cannot retain an old validation result.
  await writeJson(layout.stats, summary);
  await writeOverview(run, summary);
  await writeRunState(run, state);
  return summary;
}

export async function writeOverview(
  run: string,
  summary: JsonObject,
  validation?: {
    valid: boolean;
    errors: string[];
    artifacts_checked: boolean;
    artifacts?: { status: string };
  },
): Promise<void> {
  const statuses = summary.task_statuses as Record<string, number>;
  const failures = ["failed", "blocked", "cancelled", "timed_out"].reduce(
    (n, key) => n + (statuses[key] || 0),
    0,
  );
  const skipped = (summary.planned as JsonObject).skipped_groups;
  const headToHead = summary.head_to_head as Record<string, HeadToHeadStats>;
  const standings = summary.standings as Record<string, Standing & { meets_core_rate: number | null; average_tier: number | null }>;
  const problemLibrary = (summary.problem_library || {}) as Record<string, ProblemLibraryStats>;
  const batches = Object.entries(
    (summary.by_batch || {}) as Record<
      string,
      Omit<ReturnType<typeof summarizeResults>, "standings">
    >,
  );
  const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
  const links = ["[逐题总结](task_summaries.md)", "[正式结果](results/)"];
  for (const [name, label] of [
    ["failures", "失败明细"],
    ["skipped", "跳过明细"],
  ])
    if (summary.debug && (await exists(internalPath(run, "diagnostics", name + ".jsonl"))))
      links.push(`[${label}](_internal/diagnostics/${name}.jsonl)`);
  const summaryVersions = (summary.evaluator_versions as string[]).join("、") || "无已接受结果";
  await atomicWrite(
    locateRun(run).report,
    `# 评测运行 ${summary.run_id}\n\n状态：${summary.status}；评测器：${summaryVersions}；完成比较：${summary.completed_comparisons}。\n\n` +
      `执行失败：${failures}；输入跳过对比组：${skipped}。\n\n` +
      `离线校验：${validation ? (validation.valid ? "通过" : `未通过（${validation.errors.length} 项错误）`) : "尚未校验"}。` +
      (validation
        ? `[校验记录](stats.json)；附件：${validation.artifacts?.status === "missing" ? "缺失（不影响正式结果状态）" : validation.artifacts_checked ? "已检查" : "未保留"}。`
        : "") +
      `\n\n累计 Token：${(summary.tokens as Usage).totalTokens}；缺少最终用量的尝试：${summary.attempts_without_final_metrics}。[统计与缓存命中](stats.json)\n\n` +
      "## 模型总览\n\n" +
      "| 版本 | 参赛 | 完成核心要求 | 首位 | 平均层 | 胜出 | 都好 | 都差 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n" +
      Object.entries(standings)
        .map(
          ([version, s]) =>
            `| ${cell(version)} | ${s.entered} | ${s.meets_core} | ${s.first_tier} | ${s.average_tier ?? "-"} | ${s.wins} | ${s.both_good} | ${s.both_bad} |`,
        )
        .join("\n") +
      (Object.keys(problemLibrary).length
        ? "\n\n## 问题库\n\n" +
          "| 模型 | 组件 | 活跃问题类 | 出现样本 | 本次归类 | 提议新类 | 合并决定 |\n|---|---:|---:|---:|---:|---:|---:|\n" +
          Object.entries(problemLibrary)
            .map(
              ([model, s]) =>
                `| ${cell(model)} | ${s.components} | ${s.classes} | ${s.occurrences} | ${s.assigned} | ${s.proposed_new_classes} | ${s.merged_classes} |`,
            )
            .join("\n")
        : "") +
      "\n\n## 对局矩阵\n\n" +
      "| 对局 | 有效比较 | 胜出数量 | 都好 | 都差 |\n|---|---:|---|---:|---:|\n" +
      Object.entries(headToHead)
        .map(
          ([name, v]) =>
            `| ${name} | ${v.evaluated} | ${JSON.stringify(v.wins)} | ${v.both_good} | ${v.both_bad} |`,
        )
        .join("\n") +
      "\n\n## 批次汇总\n\n" +
      "| 批次 | 样本 | 计划任务 | 有效比较 | 失败 | 待完成 | 跳过对比组 | 输入异常 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n" +
      batches
        .map(([batch, stats]) => {
          const statuses = stats.task_statuses;
          const failed = ["failed", "blocked", "cancelled", "timed_out"].reduce(
            (n, status) => n + (statuses[status] || 0),
            0,
          );
          const pending = (statuses.pending || 0) + (statuses.running || 0);
          return `| ${cell(batch)} | ${stats.planned.cases} | ${stats.planned.tasks} | ${stats.completed_comparisons} | ${failed} | ${pending} | ${stats.planned.skipped_groups} | ${stats.planned.input_issues} |`;
        })
        .join("\n") +
      "\n\n" +
      links.join(" · ") +
      "\n",
  );
}
