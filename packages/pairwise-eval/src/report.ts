import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  JsonObject,
  PlannedTask,
  RunManifest,
  SubmissionReceipt,
  Usage,
} from "../../contracts/src/index.js";
import { emptyUsage } from "../../contracts/src/index.js";
import {
  atomicWrite,
  canonical,
  digest,
  exists,
  readJson,
  readInputs,
  writeJson,
  writeJsonl,
} from "../../contracts/src/io.js";
import type { CorrectnessResult, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { annotateFindings } from "./annotations.js";
import { comparisonPair } from "./input.js";
import { validateEvaluation } from "./index.js";

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
export async function reportRun(run: string): Promise<JsonObject> {
  const manifest = await readJson<RunManifest>(path.join(run, "manifest.json"));
  if (manifest.format !== "dual-agent-eval/1")
    throw new Error("不支持此运行格式；请使用当前版本新建 run。");
  const config = manifest.config as EvalConfig,
    names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const receipts = new Map<string, SubmissionReceipt>();
  const inputs = await readInputs(run);
  for (const task of manifest.tasks) {
    const file = path.join(run, "tasks", task.id, "result.json");
    if (await exists(file)) {
      const receipt = await readJson<SubmissionReceipt>(file);
      if (
        receipt.status !== "succeeded" ||
        receipt.taskId !== task.id ||
        receipt.submissionId !== digest([receipt.attemptId, receipt.evaluation])
      )
        throw new Error(`Invalid receipt: ${task.id}`);
      receipts.set(task.id, receipt);
    }
  }
  for (const task of manifest.tasks) {
    const receipt = receipts.get(task.id);
    if (receipt) validateEvaluation(task, inputs, receipt.evaluation, receipt.audit,
      Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)])),
    );
  }
  const groups: Record<string, JsonObject[]> = {},
    outcomes: JsonObject[] = [],
    correctness: JsonObject[] = [],
    summaries: JsonObject[] = [];
  const statuses: Record<string, number> = {},
    usage = emptyUsage(),
    subjective = new Set<string>(),
    markdown: string[] = [];
  const savedSchema = await readJson(path.join(run, "output_schema.json"));
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
    if (!receipt) continue;
    if (!receipt.cached)
      for (const key of Object.keys(usage) as (keyof Usage)[]) usage[key] += receipt.usage[key] || 0;
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
      row = comparisonRow(inputs, task, result, receipts, names);
    if (status !== "not_comparable") {
      if (!validateOutput(row)) throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
      (groups[data.pair!.join("__vs__")] ??= []).push(row);
    }
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
    if (old.endsWith(".jsonl") && !groups[old.slice(0, -6)]) await rm(path.join(results, old));
  for (const [pair, rows] of Object.entries(groups))
    await writeJsonl(path.join(results, `${pair}.jsonl`), rows);
  await writeJsonl(path.join(run, "correctness.jsonl"), correctness);
  await writeJsonl(path.join(run, "task_outcomes.jsonl"), outcomes);
  await writeJsonl(path.join(run, "task_summaries.jsonl"), summaries);
  await atomicWrite(path.join(run, "task_summaries.md"), markdown.join("\n"));
  await writeJsonl(
    path.join(run, "failures.jsonl"),
    outcomes.filter((v) => ["failed", "blocked", "cancelled", "timed_out"].includes(String(v.status))),
  );
  await writeJsonl(
    path.join(run, "not_comparable.jsonl"),
    outcomes.filter((v) => v.status === "not_comparable"),
  );
  await writeJsonl(path.join(run, "skipped.jsonl"), (manifest.preflight.skipped as unknown[]) || []);
  const pairs = Object.fromEntries(
    Object.entries(groups).map(([pair, rows]) => {
      const wins = Object.fromEntries(pair.split("__vs__").map((v) => [v, 0]));
      const counts = { both_good: 0, both_bad: 0 };
      for (const row of rows) {
        const v = row.verdict as { result: "win" | "both_good" | "both_bad"; winner_version: string };
        if (v.result === "win") wins[v.winner_version]++;
        else counts[v.result]++;
      }
      return [pair, { evaluated: rows.length, wins, ...counts, case_ids: rows.map((r) => r.case) }];
    }),
  );
  const attemptUsage = emptyUsage();
  let missingMetrics = 0;
  for (const task of manifest.tasks)
    for (let i = 1; i <= (manifest.states[task.id]?.attempts || 0); i++) {
      const file = path.join(run, "tasks", task.id, `attempt-${String(i).padStart(3, "0")}`, "metrics.json");
      if (!(await exists(file))) {
        missingMetrics++;
        continue;
      }
      const metrics = await readJson<{ usage: Usage }>(file);
      for (const key of Object.keys(attemptUsage) as (keyof Usage)[])
        attemptUsage[key] += metrics.usage[key] || 0;
    }
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
  const summary = {
    run_id: manifest.runId,
    status: manifest.status,
    planned: manifest.preflight,
    task_statuses: statuses,
    completed_comparisons: Object.values(groups).reduce((n, rows) => n + rows.length, 0),
    result_files: Object.keys(groups).map((pair) => `results/${pair}.jsonl`),
    pairs,
    per_version: perVersion,
    usage_accepted_uncached: usage,
    usage_all_recorded_attempts: attemptUsage,
    attempts_without_final_metrics: missingMetrics,
    wall_seconds: ((manifest.finishedAt || Date.now()) - manifest.startedAt) / 1000,
  };
  await writeJson(path.join(run, "summary.json"), summary);
  await atomicWrite(
    path.join(run, "report.md"),
    `# 评测运行 ${manifest.runId}\n\n状态：${manifest.status}；完成比较：${summary.completed_comparisons}。\n\n| 配对 | 有效比较 | 胜出数量 | 都好 | 都差 |\n|---|---:|---|---:|---:|\n` +
      Object.entries(pairs)
        .map(([name, v]) => `| ${name} | ${v.evaluated} | ${JSON.stringify(v.wins)} | ${v.both_good} | ${v.both_bad} |`)
        .join("\n") +
      "\n\n[逐题总结](task_summaries.md) · 失败见 failures.jsonl，缺失配对见 skipped.jsonl。\n",
  );
  return summary;
}
