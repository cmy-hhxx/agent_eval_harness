import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  JsonObject,
  PlannedTask,
  SubmissionReceipt,
  Usage,
} from "../../contracts/src/index.js";
import {
  atomicWrite,
  canonical,
  digest,
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
    const raw = inputs[c.input_hash] as RawInput;
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
  return {
    schema_version: "3.5",
    evaluation_type: "pairwise_model_comparison",
    comparison_id: "cmp_" + digest({ batch: a.batch_id, case: a.case_id, pair: data.pair }).slice(0, 32),
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
        receipt.taskId !== task.id ||
        (!receipt.exported && receipt.submissionId !== digest([receipt.attemptId, receipt.evaluation]))
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
  const statuses: Record<string, number> = {},
    subjective = new Set<string>(),
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
    statuses[status] = (statuses[status] || 0) + 1;
    outcomes.push({
      task_id: task.id,
      stage: task.stage,
      status,
      candidates: data.candidates,
      cached: receipt?.cached || false,
      reason:
        status === "not_comparable"
          ? (receipt!.evaluation as PairwiseResult).verdict.reason
          : manifest.states[task.id]?.reason || null,
    });
    if (!receipt) {
      markdown.push(
        `# ${data.candidates.A.case_id}`, "",
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
    receipt.exported = { comparisonId: String(row.comparison_id), digest: digest(row), row,
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
      `# ${data.candidates.A.case_id}`,
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
  if (skipped.length) markdown.push("# 跳过的输入", "", ...skipped.map((item) =>
    `- ${item.batch_id} / ${item.case_id}：${item.reason}（${(item.versions as string[]).join("、")}）`), "");
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
  const attemptUsage = state.usage;
  const missingMetrics = Math.max(0,
    Object.values(manifest.states).reduce((n, task) => n + task.attempts, 0) - state.recordedAttempts,
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
  const cacheHits = [...receipts.values()].filter((receipt) => receipt.cached).length;
  const inputTokens = attemptUsage.input + attemptUsage.cacheRead + attemptUsage.cacheWrite;
  const summary = {
    debug: manifest.debug,
    run_id: manifest.runId,
    status: manifest.status,
    planned: {
      cases: manifest.preflight.cases,
      tasks: manifest.tasks.length,
      skipped_pairs: skipped.length,
      input_issues: (manifest.preflight.issues as unknown[] | undefined)?.length || 0,
    },
    task_statuses: statuses,
    completed_comparisons: Object.values(groups).reduce((n, rows) => n + rows.length, 0),
    pairs,
    ...(Object.values(perVersion).some((stats) => stats.evaluated) ? { per_version: perVersion } : {}),
    tokens: attemptUsage,
    attempts_without_final_metrics: missingMetrics,
    cache: {
      task_results: {
        hits: cacheHits,
        accepted_receipts: receipts.size,
        hit_rate: receipts.size ? cacheHits / receipts.size : null,
      },
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
  validation?: { valid: boolean; errors: string[]; artifacts_checked: boolean },
): Promise<void> {
  const statuses = summary.task_statuses as Record<string, number>;
  const failures = ["failed", "blocked", "cancelled", "timed_out"].reduce((n, key) => n + (statuses[key] || 0), 0);
  const skipped = (summary.planned as JsonObject).skipped_pairs;
  const pairs = summary.pairs as Record<string, { evaluated: number; wins: Record<string, number>; both_good: number; both_bad: number }>;
  const links = ["[逐题总结](task_summaries.md)", "[正式结果](results/)"];
  for (const [name, label] of [["failures", "失败明细"], ["skipped", "跳过明细"], ["not_comparable", "不可比较明细"], ["correctness", "独立正确性"]])
    if (summary.debug && await exists(internalPath(run, "diagnostics", name + ".jsonl")))
      links.push(`[${label}](_internal/diagnostics/${name}.jsonl)`);
  await atomicWrite(
    path.join(run, "report.md"),
    `# 评测运行 ${summary.run_id}\n\n状态：${summary.status}；完成比较：${summary.completed_comparisons}。\n\n` +
      `执行失败：${failures}；输入跳过配对：${skipped}；不可比较：${statuses.not_comparable || 0}。\n\n` +
      `离线校验：${validation ? validation.valid ? "通过" : `未通过（${validation.errors.length} 项错误）` : "尚未校验"}。` +
      (validation ? `[校验记录](stats.json)${validation.artifacts_checked ? "" : "（未保留 debug 产物，未校验附件字节）"}` : "") +
      `\n\n累计 Token：${(summary.tokens as Usage).totalTokens}；缺少最终用量的尝试：${summary.attempts_without_final_metrics}。[统计与缓存命中](stats.json)\n\n` +
      "| 配对 | 有效比较 | 胜出数量 | 都好 | 都差 |\n|---|---:|---|---:|---:|\n" +
      Object.entries(pairs)
        .map(([name, v]) => `| ${name} | ${v.evaluated} | ${JSON.stringify(v.wins)} | ${v.both_good} | ${v.both_bad} |`)
        .join("\n") +
      "\n\n" + links.join(" · ") + "\n",
  );
}
