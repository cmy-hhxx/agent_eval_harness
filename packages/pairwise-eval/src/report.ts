import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  JsonObject,
  PlannedTask,
  RunState,
  SubmissionReceipt,
  Usage,
} from "../../contracts/src/index.js";
import {
  atomicWrite,
  appendJsonl,
  canonical,
  exists,
  internalPath,
  readJson,
  writeJson,
  writeJsonl,
} from "../../contracts/src/io.js";
import type { CorrectnessResult, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { annotateFindings } from "./annotations.js";
import { comparisonPair } from "./input.js";
import { outputSchema } from "./index.js";
import { loadRunInputs, readRunState, writeRunState } from "./run-data.js";

function display<T>(value: T, names: Record<string, string>, key = ""): T {
  if (typeof value === "string")
    return (
      key === "quote" ? value : value.replace(
        /【候选([AB])】|候选\s*([AB])(?![A-Za-z0-9_])|(?:中枢\s*A\s*\/\s*B|A\s*\/\s*B\s*\/\s*C|(?:公司|方案|情景|选项|计划|路径|项目|中枢)\s*[AB])|(?<![A-Za-z0-9_])([AB])(?![A-Za-z0-9_]|组|\s*(?:股|[+＋]\s*H|浪|类|级|轮|款|型))/gu,
        (match, bracketed: string | undefined, candidate: string | undefined, bare: string | undefined) =>
          names[bracketed || candidate || bare || ""] || match,
      )
    ) as T;
  if (Array.isArray(value)) return value.map((v) => display(v, names)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, display(v, names, k)])) as T;
  return value;
}
export function comparisonRow(
  inputs: Record<string, unknown>,
  task: PlannedTask,
  result: PairwiseResult,
  receipts: Map<string, SubmissionReceipt>,
  names: Record<string, string>,
): JsonObject {
  const data = task.data as TaskData,
    a = data.candidates.A;
  if (
    canonical(data.pair) !== canonical(comparisonPair(Object.values(data.candidates).map((r) => r.version)))
  )
    throw new Error("任务配对与候选不一致");
  const labels = Object.fromEntries(
    Object.entries(data.candidates).map(([label, c]) => [label, names[c.version] || c.name]),
  );
  const evaluations: Record<string, unknown> = {};
  for (const [label, c] of Object.entries(data.candidates)) {
    const correctness = task.dependencies[label]
      ? (receipts.get(task.dependencies[label])?.evaluation as CorrectnessResult)
      : { is_correct: null, correctness_reason: "" };
    if (!correctness) throw new Error("缺少正确性任务收据");
    const review = display(structuredClone(result.evaluations[label]), labels);
    const raw = inputs[c.input_id] as RawInput;
    const traces = annotateFindings(raw, review.findings);
    review.findings.forEach((finding, i) => {
      finding.stage_trace = traces[i];
    });
    evaluations[c.version] = {
      is_correct: correctness.is_correct,
      correctness_reason: display(correctness.correctness_reason, { A: labels[label] }),
      ...review,
    };
  }
  const winner =
    result.verdict.result === "A_better" ? "A" : result.verdict.result === "B_better" ? "B" : null;
  const first = Object.values(data.candidates).find((c) => c.version === data.pair![0])!;
  const raw = inputs[first.input_id] as RawInput;
  return {
    request_time: raw.request_time ?? null,
    has_standard_answer: data.reference !== null,
    schema_version: "3.6",
    evaluation_type: "pairwise_model_comparison",
    comparison_id: data.comparisonId || "cmp_" + task.id,
    case: { batch_id: a.batch_id, case_id: a.case_id },
    ground_truth: { available: data.reference !== null, value: data.reference },
    models: Object.fromEntries(
      Object.values(data.candidates).map((c) => [
        c.version,
        { version: names[c.version] || c.name, llm: c.llm, trace_id: c.trace_id },
      ]),
    ),
    verdict: {
      result: winner ? "win" : result.verdict.result,
      winner_version: winner ? data.candidates[winner].version : null,
      winner_name: winner ? labels[winner] : null,
      reason: display(result.verdict.reason, labels),
    },
    evaluations,
    task_analysis: display(result.task_analysis, labels),
    decision_basis: {
      tradeoff: display(result.decision_basis.tradeoff, labels),
      ...Object.fromEntries(
        ["decisive_findings", "counterevidence"].map((kind) => [
          kind,
          result.decision_basis[kind as "decisive_findings" | "counterevidence"].map((ref) => ({
            ...ref,
            candidate: data.candidates[ref.candidate].version,
          })),
        ]),
      ),
    },
  };
}
export function createResultWriter(run: string, inputs: Record<string, unknown>): (state: RunState) => Promise<void> {
  const written = new Set<string>();
  const directory = path.join(run, "results");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validateOutput = ajv.compile(outputSchema);
  let initialized = false;
  return async ({ manifest, receipts: accepted }) => {
    try {
      const pending = manifest.tasks.filter((task) => task.stage === "pairwise" && accepted[task.id] && !written.has(task.id));
      if (initialized && !pending.length) return;
      const config = manifest.config as EvalConfig;
      const names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
      const receipts = new Map(Object.entries(accepted));
      const groups: Record<string, JsonObject[]> = {};
      for (const task of pending) {
        const receipt = accepted[task.id], data = task.data as TaskData;
        const result = receipt.evaluation as PairwiseResult;
        const row = receipt.exported?.row || comparisonRow(inputs, task, result, receipts, names);
        const notComparable = result.verdict.result === "not_comparable";
        if (!notComparable && !validateOutput(row))
          throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
        const file = notComparable ? "not_comparable.jsonl" : data.pair!.join("__vs__") + ".jsonl";
        (groups[file] ??= []).push(row);
      }
      if (!initialized) {
        // Recover from the durable receipts, including a crash between checkpoint and append.
        await mkdir(directory, { recursive: true });
        for (const file of await readdir(directory))
          if (file.endsWith(".jsonl") && !groups[file]) await writeJsonl(path.join(directory, file), []);
        for (const [file, rows] of Object.entries(groups)) await writeJsonl(path.join(directory, file), rows);
      } else {
        for (const [file, rows] of Object.entries(groups)) await appendJsonl(path.join(directory, file), rows);
      }
      for (const task of pending) written.add(task.id);
      initialized = true;
    } catch (error) {
      // A failed append may leave a partial line; rebuild before attempting another append.
      written.clear();
      initialized = false;
      throw error;
    }
  };
}

function summarizeResults(
  tasks: PlannedTask[],
  outcomes: JsonObject[],
  correctness: JsonObject[],
  groups: Record<string, JsonObject[]>,
  skipped: JsonObject[],
  issues: JsonObject[],
) {
  const cases = new Set([
    ...tasks.map((task) => {
      const candidate = (task.data as TaskData).candidates.A;
      return canonical([candidate.batch_id, candidate.case_id]);
    }),
    ...skipped.map((item) => canonical([item.batch_id, item.case_id])),
  ]);
  const statuses: Record<string, number> = {};
  for (const outcome of outcomes) {
    const status = String(outcome.status);
    statuses[status] = (statuses[status] || 0) + 1;
  }
  const pairs = Object.fromEntries(
    Object.entries(groups).map(([pair, rows]) => {
      const wins = Object.fromEntries(pair.split("__vs__").map((v) => [v, 0]));
      const counts = { both_good: 0, both_bad: 0 };
      for (const row of rows) {
        const v = row.verdict as { result: "win" | "both_good" | "both_bad"; winner_version: string };
        if (v.result === "win") wins[v.winner_version]++;
        else counts[v.result]++;
      }
      return [pair, { evaluated: rows.length, wins, ...counts }];
    }),
  );
  const perVersion: Record<
    string,
    {
      correct: number;
      incorrect: number;
      undetermined: number;
      subjective_not_assessed: number;
      evaluated?: number;
      decidable_coverage?: number | null;
      accuracy_among_decidable?: number | null;
    }
  > = {};
  for (const row of correctness) {
    const stats = (perVersion[String(row.version)] ??= {
      correct: 0,
      incorrect: 0,
      undetermined: 0,
      subjective_not_assessed: 0,
    });
    stats[
      row.assessment_status === "subjective_not_assessed"
        ? "subjective_not_assessed"
        : row.is_correct === true
          ? "correct"
          : row.is_correct === false
            ? "incorrect"
            : "undetermined"
    ]++;
  }
  for (const stats of Object.values(perVersion)) {
    const total = stats.correct + stats.incorrect + stats.undetermined,
      decided = stats.correct + stats.incorrect;
    stats.evaluated = total;
    stats.decidable_coverage = total ? decided / total : null;
    stats.accuracy_among_decidable = decided ? stats.correct / decided : null;
  }
  return {
    planned: { cases: cases.size, tasks: tasks.length, skipped_pairs: skipped.length, input_issues: issues.length },
    task_statuses: statuses,
    completed_comparisons: Object.values(groups).reduce((n, rows) => n + rows.length, 0),
    pairs,
    ...(Object.values(perVersion).some((stats) => stats.evaluated) ? { per_version: perVersion } : {}),
  };
}

export async function reportRun(run: string, options: { details?: boolean } = {}): Promise<JsonObject> {
  const state = await readRunState(run), manifest = state.manifest;
  if (options.details && !manifest.debug) throw new Error("--details 需要启用 --debug 的运行");
  const config = manifest.config as EvalConfig,
    names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const receipts = new Map<string, SubmissionReceipt>();
  const inputs = await loadRunInputs(run, manifest);
  for (const task of manifest.tasks) {
    const receipt = state.receipts[task.id];
    if (receipt) {
      if (
        receipt.status !== "succeeded" ||
        receipt.taskId !== task.id
      )
        throw new Error(`Invalid receipt: ${task.id}`);
      receipts.set(task.id, receipt);
    }
  }
  const groups: Record<string, JsonObject[]> = {},
    notComparable: JsonObject[] = [],
    outcomes: JsonObject[] = [],
    correctness: JsonObject[] = [],
    summaries: JsonObject[] = [];
  const subjective = new Set<string>(),
    markdown: string[] = [];
  const savedSchema = manifest.debug ? await readJson(internalPath(run, "output_schema.json")) : outputSchema;
  const ajv = new Ajv2020({ strict: false, allErrors: true }),
    validateOutput = ajv.compile(savedSchema);
  for (const task of manifest.tasks) {
    const data = task.data as TaskData,
      receipt = receipts.get(task.id);
    if (data.stage === "pairwise" && data.reference === null)
      for (const c of Object.values(data.candidates)) {
        const key = canonical([c.batch_id, c.case_id, c.version]);
        if (subjective.has(key)) continue;
        subjective.add(key);
        correctness.push({
          ...c,
          is_correct: null,
          correctness_reason: "",
          evidence: [],
          assessment_status: "subjective_not_assessed",
        });
      }
    let status: string = receipt ? "succeeded" : manifest.states[task.id]?.status || "pending";
    if (
      receipt &&
      data.stage === "pairwise" &&
      (receipt.evaluation as PairwiseResult).verdict.result === "not_comparable"
    )
      status = "not_comparable";
    outcomes.push({
      task_id: task.id,
      stage: task.stage,
      status,
      candidates: data.candidates,

      reason:
        status === "not_comparable"
          ? (receipt!.evaluation as PairwiseResult).verdict.reason
          : manifest.states[task.id]?.reason || null,
    });
    if (!receipt) {
      markdown.push(
        `# ${data.candidates.A.batch_id} / ${data.candidates.A.case_id}`, "",
        `**状态**：${status}（${task.stage}）`, "",
        `**原因**：${manifest.states[task.id]?.reason || "尚未完成"}`, "",
        `**问题**：${data.candidates.A.question}`, "", "---", "",
      );
      continue;
    }
    if (data.stage === "correctness") {
      correctness.push({
        ...data.candidates.A,
        ...display(receipt.evaluation as CorrectnessResult, { A: names[data.candidates.A.version] || data.candidates.A.name }),
        task_id: task.id,
        assessment_status: "assessed",
      });
      continue;
    }
    const result = receipt.evaluation as PairwiseResult,
      row = receipt.exported?.row || comparisonRow(inputs, task, result, receipts, names);
    if (status !== "not_comparable") {
      if (!validateOutput(row)) throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
      (groups[data.pair!.join("__vs__")] ??= []).push(row);
    } else notComparable.push(row);
    receipt.exported = { comparisonId: String(row.comparison_id), row,
      ...(status === "not_comparable" ? { file: "not_comparable.jsonl" } : {}),
    };
    const analysis = row.task_analysis as PairwiseResult["task_analysis"];
    const measurements = Object.fromEntries(
      Object.values(data.candidates).map((c) => [c.version, c.answer_timing]),
    );
    const a = data.candidates.A.answer_timing.finish_seconds,
      b = data.candidates.B.answer_timing.finish_seconds;
    const reviews = row.evaluations as Record<string, PairwiseResult["evaluations"][string]>;
    const candidates = Object.fromEntries(
      Object.entries(reviews).map(([id, r]) => [
        id,
        {
          model: (row.models as JsonObject)[id],
          summary: r.summary,
          strengths: r.findings.filter((f) => f.type === "strength"),
          weaknesses: r.findings.filter((f) => f.type === "problem"),
        },
      ]),
    );
    summaries.push({
      request_time: row.request_time,
      has_standard_answer: row.has_standard_answer,
      summary_version: "1.2",
      comparison_id: row.comparison_id,
      case: row.case,
      question: data.candidates.A.question,
      task_type: analysis.task_type,
      goal: analysis.goal,
      requirements: analysis.requirements,
      conclusion: row.verdict,
      candidates,
      timing: {
        measurements,
        comparison: {
          finish_comparable: a !== null && b !== null,
          faster_version:
            a !== null && b !== null && a !== b ? data.candidates[a < b ? "A" : "B"].version : null,
          finish_difference_seconds:
            a !== null && b !== null ? Math.round(Math.abs(a - b) * 1e6) / 1e6 : null,
        },
        analysis: analysis.timing_analysis,
      },
      scoring_points: analysis.scoring_points,
      red_flags: analysis.red_flags,
    });
    const verdict = row.verdict as JsonObject;
    const verdictLabel = verdict.winner_name
      ? `${verdict.winner_name}更好`
      : ({ both_good: "都好", both_bad: "都差", not_comparable: "不可比较" } as Record<string, string>)[String(verdict.result)];
    markdown.push(
      `# ${data.candidates.A.batch_id} / ${data.candidates.A.case_id}`,
      "",
      `**结论（${verdictLabel}）**：${verdict.reason}`,
      "",
      "## 问题",
      "",
      data.candidates.A.question,
      "",
      analysis.goal,
      "",
      "## 要求",
      "",
      ...analysis.requirements.map((v) => `- ${v}`),
      "",
    );
    const timingLines = Object.values(data.candidates)
      .filter((c) => c.answer_timing.finish_seconds !== null)
      .map((c) => `${names[c.version]}：${c.answer_timing.finish_seconds!.toFixed(3)} 秒`);
    if (timingLines.length) markdown.push("**原始回答耗时**：" + timingLines.join("；"), "");
    if (analysis.timing_analysis) markdown.push(analysis.timing_analysis, "");
    for (const [id, review] of Object.entries(reviews)) {
      markdown.push(`## ${names[id]}`, "", review.summary, "");
      for (const finding of review.findings) {
        markdown.push(
          `- **${finding.type === "strength" ? "优势" : "不足"}｜${finding.text}**：${finding.reason}`,
          "",
          `影响：${finding.assessment.impact}`,
          "",
        );
        const trace = finding.stage_trace as { tools: string[]; confidence: string };
        if (trace.tools.length)
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
  const results = path.join(run, "results");
  await mkdir(results, { recursive: true });
  for (const old of await readdir(results))
    if (old.endsWith(".jsonl") && !groups[old.slice(0, -6)] && !(old === "not_comparable.jsonl" && notComparable.length))
      await rm(path.join(results, old));
  for (const [pair, rows] of Object.entries(groups))
    await writeJsonl(path.join(results, `${pair}.jsonl`), rows);
  if (notComparable.length) await writeJsonl(path.join(results, "not_comparable.jsonl"), notComparable);
  const exports = internalPath(run, "exports");
  if (manifest.debug && (options.details || await exists(exports))) {
    await writeJsonl(path.join(exports, "task_outcomes.jsonl"), outcomes);
    await writeJsonl(path.join(exports, "task_summaries.jsonl"), summaries);
  }
  async function writeDetail(name: string, rows: unknown[]) {
    if (!manifest.debug) return;
    const file = internalPath(run, "diagnostics", name + ".jsonl");
    if (rows.length) await writeJsonl(file, rows);
    else await rm(file, { force: true });
  }
  await writeDetail("correctness", correctness.filter((row) => row.assessment_status === "assessed"));
  const skipped = (manifest.preflight.skipped as JsonObject[] | undefined) || [];
  const issues = (manifest.preflight.issues as JsonObject[] | undefined) || [];
  if (skipped.length) markdown.push("# 跳过的输入", "", ...skipped.map((item) =>
    `- ${item.batch_id} / ${item.case_id}：${item.reason}（${(item.versions as string[]).join("、")}）` +
    ((item.sources as { source: string; line: number }[] | undefined)?.map((source) =>
      ` ${source.source}:${source.line}`).join("；") || "")), "");
  if (issues.length) markdown.push("# 输入异常", "", ...issues.map((item) =>
    `- ${item.batch_id || "批次未知"} / ${item.case_id || "case 未知"}：${item.reason}` +
    (item.source ? `（${item.source}${item.line ? `:${item.line}` : ""}）` : "")), "");
  await atomicWrite(path.join(run, "task_summaries.md"), markdown.join("\n"));
  await writeDetail(
    "failures",
    outcomes.filter((v) => ["failed", "blocked", "cancelled", "timed_out"].includes(String(v.status))),
  );
  await writeDetail(
    "not_comparable",
    outcomes.filter((v) => v.status === "not_comparable"),
  );
  await writeDetail("skipped", (manifest.preflight.skipped as unknown[]) || []);
  const attemptUsage = state.usage;
  const missingMetrics = Math.max(0,
    Object.values(manifest.states).reduce((n, task) => n + task.attempts, 0) - state.recordedAttempts,
  );
  const inputTokens = attemptUsage.input + attemptUsage.cacheRead + attemptUsage.cacheWrite;
  const totals = summarizeResults(manifest.tasks, outcomes, correctness, groups, skipped, issues);
  const measured = manifest.tasks.flatMap((task) => {
    const receipt = receipts.get(task.id), failure = manifest.states[task.id].failure;
    const submissions = receipt?.submissionStats?.contentSubmissions ?? failure?.contentSubmissions;
    return submissions ? [{ submissions, accepted: !!receipt }] : [];
  });
  const durations = Object.values(manifest.states).flatMap((state) => state.durationMs ? [state.durationMs / 1000] : []).sort((a, b) => a - b);
  const quality = {
    submission_metrics_tasks: measured.length,
    first_submission_pass_rate: measured.length ? measured.filter((r) => r.accepted && r.submissions === 1).length / measured.length : null,
    content_repairs: measured.reduce((sum, r) => sum + r.submissions - 1, 0),
    repeated_error_tasks: Object.values(manifest.states).filter((s) => (s.failure?.repeatedErrors || 0) >= 2).length,
    repeated_error_rate: measured.length ? Object.values(manifest.states).filter((s) => (s.failure?.repeatedErrors || 0) >= 2).length / measured.length : null,
    attempts_per_accepted_task: receipts.size ? Object.values(manifest.states).reduce((n, s) => n + s.attempts, 0) / receipts.size : null,
    tokens_per_accepted_task: receipts.size ? attemptUsage.totalTokens / receipts.size : null,
    p50_seconds: durations.length ? durations[Math.floor((durations.length - 1) * 0.5)] : null,
    p95_seconds: durations.length ? durations[Math.floor((durations.length - 1) * 0.95)] : null,
  };
  const batches = new Set([
    ...manifest.tasks.map((task) => (task.data as TaskData).candidates.A.batch_id),
    ...skipped.map((item) => String(item.batch_id)),
    ...issues.flatMap((item) => item.batch_id ? [String(item.batch_id)] : []),
  ]);
  const byBatch = Object.fromEntries([...batches].sort().map((batch) => [batch, summarizeResults(
    manifest.tasks.filter((task) => (task.data as TaskData).candidates.A.batch_id === batch),
    outcomes.filter((outcome) => (outcome.candidates as TaskData["candidates"]).A.batch_id === batch),
    correctness.filter((row) => row.batch_id === batch),
    Object.fromEntries(Object.entries(groups).map(([pair, rows]) =>
      [pair, rows.filter((row) => (row.case as JsonObject).batch_id === batch)] as const,
    ).filter(([, rows]) => rows.length)),
    skipped.filter((item) => item.batch_id === batch),
    issues.filter((item) => item.batch_id === batch),
  )]));
  const summary = {
    debug: manifest.debug,
    run_id: manifest.runId,
    status: manifest.status,
    ...totals,
    quality,
    by_batch: byBatch,
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
  await writeJson(path.join(run, "stats.json"), summary);
  await writeOverview(run, summary);
  await writeRunState(run, state);
  return summary;
}

export async function writeOverview(
  run: string,
  summary: JsonObject,
  validation?: { valid: boolean; errors: string[]; artifacts_checked: boolean; artifacts?: { status: string } },
): Promise<void> {
  const statuses = summary.task_statuses as Record<string, number>;
  const failures = ["failed", "blocked", "cancelled", "timed_out"].reduce((n, key) => n + (statuses[key] || 0), 0);
  const skipped = (summary.planned as JsonObject).skipped_pairs;
  const pairs = summary.pairs as Record<string, { evaluated: number; wins: Record<string, number>; both_good: number; both_bad: number }>;
  const batches = Object.entries((summary.by_batch || {}) as Record<string, ReturnType<typeof summarizeResults>>);
  const cell = (value: string) => value.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
  const links = ["[逐题总结](task_summaries.md)", "[正式结果](results/)"];
  for (const [name, label] of [["failures", "失败明细"], ["skipped", "跳过明细"], ["not_comparable", "不可比较明细"], ["correctness", "独立正确性"]])
    if (summary.debug && await exists(internalPath(run, "diagnostics", name + ".jsonl")))
      links.push(`[${label}](_internal/diagnostics/${name}.jsonl)`);
  await atomicWrite(
    path.join(run, "report.md"),
    `# 评测运行 ${summary.run_id}\n\n状态：${summary.status}；完成比较：${summary.completed_comparisons}。\n\n` +
      `执行失败：${failures}；输入跳过配对：${skipped}；不可比较：${statuses.not_comparable || 0}。\n\n` +
      `离线校验：${validation ? validation.valid ? "通过" : `未通过（${validation.errors.length} 项错误）` : "尚未校验"}。` +
      (validation ? `[校验记录](stats.json)；附件：${validation.artifacts?.status === "missing" ? "缺失（不影响正式结果状态）" : validation.artifacts_checked ? "已检查" : "未保留"}。` : "") +
      `\n\n累计 Token：${(summary.tokens as Usage).totalTokens}；缺少最终用量的尝试：${summary.attempts_without_final_metrics}。[统计与缓存命中](stats.json)\n\n` +
      "| 配对 | 有效比较 | 胜出数量 | 都好 | 都差 |\n|---|---:|---|---:|---:|\n" +
      Object.entries(pairs)
        .map(([name, v]) => `| ${name} | ${v.evaluated} | ${JSON.stringify(v.wins)} | ${v.both_good} | ${v.both_bad} |`)
        .join("\n") +
      "\n\n## 批次汇总\n\n" +
      "| 批次 | 样本 | 计划任务 | 有效比较 | 失败 | 待完成 | 不可比较 | 跳过配对 | 输入异常 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n" +
      batches.map(([batch, stats]) => {
        const statuses = stats.task_statuses;
        const failed = ["failed", "blocked", "cancelled", "timed_out"].reduce((n, status) => n + (statuses[status] || 0), 0);
        const pending = (statuses.pending || 0) + (statuses.running || 0);
        return `| ${cell(batch)} | ${stats.planned.cases} | ${stats.planned.tasks} | ${stats.completed_comparisons} | ${failed} | ${pending} | ${statuses.not_comparable || 0} | ${stats.planned.skipped_pairs} | ${stats.planned.input_issues} |`;
      }).join("\n") +
      "\n\n| 批次 | 配对 | 有效比较 | 胜出数量 | 都好 | 都差 |\n|---|---|---:|---|---:|---:|\n" +
      batches.flatMap(([batch, stats]) => Object.entries(stats.pairs).map(([pair, counts]) =>
        `| ${cell(batch)} | ${pair} | ${counts.evaluated} | ${JSON.stringify(counts.wins)} | ${counts.both_good} | ${counts.both_bad} |`,
      )).join("\n") +
      "\n\n" + links.join(" · ") + "\n",
  );
}
