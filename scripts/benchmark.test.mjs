import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { pairSamples, compareSamples, summarizeSamples, goldTemplate, calibrateSamples } from "./benchmark-analysis.mjs";
import { rejectedEvaluationDrafts } from "./benchmark-fixtures.mjs";
import { processTreePids, sampleProcessTree } from "./process-tree-usage.mjs";
import { summarizeAttemptCosts, countModelRounds, summarizeSubmissionLatency } from "./attribution-throughput.mjs";

test("submission latency counts failures and late acceptance without treating early cancellation as an SLA failure", () => {
  const report = summarizeSubmissionLatency([
    { startedAt: 1000, acceptedAt: 601000, observedUntil: 602000, status: "succeeded" },
    { startedAt: 1000, acceptedAt: 901000, observedUntil: 902000, status: "succeeded" },
    { startedAt: 1000, acceptedAt: 301000, observedUntil: 302000, partial: true, status: "succeeded" },
    { startedAt: 1000, observedUntil: 2000, status: "failed" },
    { startedAt: 1000, observedUntil: 901000, status: "timed_out" },
    { startedAt: 1000, observedUntil: 101000, status: "cancelled" },
    { startedAt: 1000, observedUntil: 701000, status: "cancelled" },
    { observedUntil: 901000, status: "pending" },
  ]);
  assert.equal(report.valid_within_ten_minutes, 1);
  assert.equal(report.ten_minute_observed_tasks, 6);
  assert.equal(report.valid_within_ten_minutes_rate, 1 / 6);
  assert.equal(report.interrupted_or_running_under_ten_minutes, 1);
  assert.equal(report.valid_submission_p95_seconds, 900);
  assert.equal(report.fault_rate, 2 / 5);
});

test("attribution cost includes failed and retry attempts and refuses an incomplete success denominator", () => {
  const metrics = { usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100 }, timings: { modelMs: 1000 } };
  const attempts = [{ attempt: 1, status: "timed_out", metrics, modelRounds: 3, contentSubmissions: 0 },
    { attempt: 2, status: "succeeded", metrics, modelRounds: 4, contentSubmissions: 2 }];
  const report = summarizeAttemptCosts(attempts, 2, 1);
  assert.equal(report.cost_per_complete_result.usage.totalTokens, 200);
  assert.equal(report.cost_per_complete_result.model_seconds, 2);
  assert.equal(report.cost_per_complete_result.model_turns, 7);
  assert.equal(report.unsuccessful.usage.totalTokens, 100);
  assert.equal(report.timed_out.attempts, 1);
  assert.equal(report.retries.attempts, 1);
  assert.equal(report.attempts_with_content_repair.attempts, 1);
  assert.equal(summarizeAttemptCosts(attempts, 3, 1).cost_per_complete_result, null);
  assert.equal(summarizeAttemptCosts(attempts, 2, 0).cost_per_complete_result, null);
  assert.equal(summarizeAttemptCosts([{ metrics: {} }], 1, 1).cost_per_complete_result.usage.totalTokens, null);
});

test("model cost counts SDK turns when archived message starts omit roles", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "model-rounds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "events.jsonl");
  assert.equal(await countModelRounds(file), undefined);
  const events = [
    { type: "model", data: { type: "turn_start" } },
    { type: "model", data: { type: "message_start" } },
    { type: "tool_start", data: { name: "turn_start" } },
    { type: "model", data: { type: "message_end", message: { role: "assistant" } } },
    { type: "model", data: { type: "turn_start" } },
    { type: "model", data: { type: "message_start" } },
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
  await writeFile(file, events);
  assert.equal(await countModelRounds(file), 2);
  await writeFile(file + ".gz", gzipSync(events));
  await rm(file);
  assert.equal(await countModelRounds(file), 2);
});

test("resource sampling selects the complete process tree without task/PID/children", () => {
  assert.deepEqual(processTreePids(10, " 1 0\n 10 1\n 30 20\n 20 10\n 40 10\n 50 1\n"), [10, 20, 40, 30]);
});

test("Linux resource sampling reports nonzero root memory and IO counters", { skip: process.platform !== "linux" }, async () => {
  const sample = await sampleProcessTree(process.pid);
  assert(sample.rss > 0);
  assert(sample.processes >= 1);
  assert(sample.host.rss_bytes > 0);
  assert.equal(sample.rss, sample.host.rss_bytes + sample.workers.rss_bytes);
  assert.equal(sample.workers.count, sample.processes - 1);
  assert(sample.system.cached_bytes >= 0);
  assert(sample.counters.some(row => row.id.startsWith(process.pid + ":") && row.rchar > 0));
  assert.equal(sample.failures, 0);
});

test("Linux benchmark sampler reports the Host from a persistent thread and closes cleanly", { skip: process.platform !== "linux", timeout: 10000 }, async t => {
  const worker = new Worker(new URL("./process-tree-usage.mjs", import.meta.url), { workerData: { processTreeRoot: process.pid } });
  t.after(() => worker.terminate());
  const closed = once(worker, "exit");
  for (let round = 0; round < 2; round++) {
    const [{ sample, error }] = await once(worker, "message");
    assert.equal(error, undefined);
    assert(sample.host.rss_bytes > 0);
    assert(sample.counters.some(row => row.id.startsWith(process.pid + ":")));
  }
  worker.postMessage("stop");
  assert.deepEqual(await closed, [0]);
});

test("draft collection uses loaded JSON for either current submission mode and skips non-evaluation calls", async () => {
  const direct = { summary: "direct" }, file = { summary: "loaded before the path was overwritten" };
  const events = [
    { type: "tool_start", data: { name: "submit_evaluation", args: direct } },
    { type: "submission", data: { content_loaded: true, evaluation: direct } },
    { seq: 3, type: "tool_end", data: { name: "submit_evaluation", result: { isError: true } } },
    { type: "tool_start", data: { name: "submit_evaluation_file", args: { path: "draft.json" } } },
    { type: "submission", data: { content_loaded: true, evaluation: file } },
    { seq: 6, type: "tool_end", data: { name: "submit_evaluation_file", result: { isError: true } } },
    { type: "tool_start", data: { name: "submit_evaluation_file", args: { path: "missing.json" } } },
    { type: "tool_end", data: { name: "submit_evaluation_file", result: { isError: true } } },
    { type: "submission", data: { content_loaded: true, inspection: true, evaluation: { checks: [] } } },
    { type: "tool_end", data: { name: "inspect_material", result: { isError: true } } },
    { type: "tool_start", data: { name: "submit_evaluation_file", args: { path: "accepted.json" } } },
    { type: "submission", data: { content_loaded: true, evaluation: { summary: "accepted" } } },
    { type: "tool_end", data: { name: "submit_evaluation_file", result: {} } },
    { type: "tool_end", data: { name: "submit_evaluation", result: { isError: true }, malformed_arguments: true } },
  ];
  const captured = [];
  for await (const value of rejectedEvaluationDrafts(events)) captured.push(value);
  assert.deepEqual(captured.map(({ event, draft }) => [event.seq, draft]), [[3, direct], [6, file]]);
});

const inputIds = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222", c: "33333333-3333-4333-8333-333333333333" };
const problem = (version) => ({
  problem_id: "p1", component: "模型自身推理", label: "回答结果不完整", definition: "最终回答缺少所求数值。",
  problem_phenomena: "回答没有给出最终数值。", reason: "最终回答缺少结果。",
  evidence: [{ position: "trace_index 0 / message_index 1 / path /content", component: "answer: 终稿生成轮", quote: "4", reason: "证明最终回答。" }],
});
function row(caseId = "one", versions = ["a", "b"], winner = null) {
  const evaluations = Object.fromEntries(versions.map((version) => [version, {
    session_meta: { input_id: inputIds[version], batch_id: "batch", case_id: caseId, session_id: `session-${caseId}-${version}` },
    turns: [{ meta: {}, summary: "完成查询", problem: [problem(version)], is_correct: null, correct_reason: null }],
    session_summary: "完成查询", session_problem: [],
  }]));
  const verdicts = {};
  for (let i = 0; i < versions.length; i++) for (const second of versions.slice(i + 1)) {
    const pair = [versions[i], second], better = winner && pair.includes(winner) ? winner : null;
    verdicts[pair.join("__vs__")] = { result: better ? "win" : "both_good", winner_version: better, winner_name: better, reason: "具体判断" };
  }
  return {
    request_time: null, has_standard_answer: false, evaluator_version: "judge-current",
    evaluation_type: "group_model_comparison", comparison_id: "comparison-" + caseId + "-" + versions.join("-"),
    status: "decided", criteria_task_id: "criteria-" + caseId,
    attribution_task_ids: Object.fromEntries(versions.map((version) => [version, "attribution-" + caseId + "-" + version])),
    case: { batch_id: "batch", case_id: caseId }, ground_truth: { available: false, value: null },
    models: Object.fromEntries(versions.map((version) => [version, { version, llm: "model", trace_id: "trace" }])),
    ranking: winner ? [[winner], versions.filter((version) => version !== winner)] : [versions],
    assessments: Object.fromEntries(versions.map((version) => [version, { meets_core: true, core_failure_refs: [], summary: "核心可用" }])),
    evaluations, verdicts,
    task_analysis: { task_type: "查询", goal: "结果", requirements: [{ id: "answer", text: "结果", applies_to: [], acceptance_rule: "提供准确的结果。" }], scoring_points: [], red_flags: [] },
    decision_basis: {
      tradeoff: "完成查询", decisive_findings: versions.map((candidate) => ({ candidate, finding_index: 0 })),
      comparisons: [{ aspect: "结果", criterion_ids: ["answer"], importance: "high", better_candidates: winner ? [winner] : [],
        assessments: Object.fromEntries(versions.map((version) => [version, { summary: "完成查询", finding_indices: [0], status: "met", evidence_status: "已确认" }])) }],
    },
  };
}
const triad = (caseId, winner) => [["a", "b"], ["a", "c"], ["b", "c"]].map((versions) => row(caseId, versions, winner));

test("current pair exports drive stable/change/missing comparisons and reject invalid references", () => {
  const before = row(), samples = pairSamples([before]);
  assert.equal(samples.size, 1);
  const changed = structuredClone(before);
  changed.evaluations.a.turns[0].problem[0].problem_phenomena = "另一种问题描述";
  const report = compareSamples(samples, pairSamples([changed]));
  assert.equal(report.stable, 1);
  assert.equal(report.samples[0].decisive_basis_changed, true);
  assert.equal(compareSamples(samples, new Map()).missing, 1);

  const cases = [
    ["duplicate pair", () => pairSamples([before, { ...structuredClone(before), comparison_id: "other" }]), /duplicate case\/model pair/],
    ["missing verdict", () => { const value = structuredClone(before); delete value.verdicts.a__vs__b; return pairSamples([value]); }, /Missing or duplicate verdict/],
    ["orphan finding", () => { const value = structuredClone(before); value.decision_basis.decisive_findings[0].finding_index = 9; return pairSamples([value]); }, /reference does not exist/],
    ["invalid correctness", () => { const value = structuredClone(before); value.evaluations.a.turns[0].is_correct = 1; return pairSamples([value]); }, /Correctness requires/],
    ["invalid envelope", () => pairSamples([{ case: before.case, verdict: before.verdicts.a__vs__b }]), /current comparison.jsonl envelope/],
  ];
  for (const [, invoke, expected] of cases) assert.throws(invoke, expected);
});

test("summary counts answers once by case, separates correctness, and keeps contradictory evidence visible", () => {
  const objective = triad("objective", "a"), subjective = row("subjective");
  for (const value of objective) {
    value.has_standard_answer = true;
    value.ground_truth = { available: true, value: "4" };
    for (const version of Object.keys(value.evaluations)) {
      value.evaluations[version].turns[0].is_correct = version === "b" ? 0 : version === "c" ? null : 1;
      value.evaluations[version].turns[0].correct_reason = "按给定标准核对。";
    }
  }
  const summary = summarizeSamples(pairSamples([...objective, subjective]), { rounds: 100 });
  const a = summary.models.find((model) => model.version === "a"), c = summary.models.find((model) => model.version === "c");
  assert.equal(a.pair_cases, 3);
  assert.equal(a.answer_cases, 2, "one answer facing two opponents remains one quality sample");
  assert.equal(a.core.count, 2);
  assert.equal(a.standard_agreement.correct, 1);
  assert.equal(a.standard_agreement.rate, 1);
  assert.equal(c.coverage_of_formal_cases, 0.5);
  assert.equal(c.standard_agreement.rate, null, "an undecidable objective answer is not incorrect");

  const [ab, ac] = triad("conflict", "b");
  ab.assessments.a.meets_core = false;
  ac.assessments.a.meets_core = true;
  const conflict = summarizeSamples(pairSamples([ab, ac]), { rounds: 100, planned: { pair_cases: 4, needs_review: 1 } });
  const conflictA = conflict.models.find((model) => model.version === "a");
  assert.equal(conflictA.core.conflicted, 1);
  assert.equal(conflictA.core.completion_rate, null);
  assert.deepEqual(conflict.coverage, { scope: "run_plan", planned_pair_cases: 4, decided_pair_cases: 2,
    needs_review_pair_cases: 1, incomplete_pair_cases: 1, decided_coverage: 0.5 });
});

test("interval and provenance summarize independent cases without hiding mixed judges", () => {
  const rows = [row("one"), row("two")];
  const traces = new Map(rows.map((item, index) => [item.comparison_id, { evaluator_version: "judge-current", judge: "judge-" + index,
    attributions: Object.keys(item.models).map((version) => ({ version, evaluator_version: "attribution", judge: "judge-" + index })) }]));
  const report = summarizeSamples(pairSamples(rows, traces), { rounds: 100 });
  assert.equal(report.cases, 2);
  assert.equal(report.pair_cases, 2);
  assert.equal(report.matrix[0].interval_status, "no_observed_variation");
  assert.equal(report.matrix[0].score_interval, null);
  assert.equal(report.mixed_evaluator_judges, true);
  assert.equal(report.trace_cohorts.length, 2);
});

test("gold template stays unreviewed and calibration separates pair from core agreement", () => {
  const samples = pairSamples(triad("one", "a")), gold = goldTemplate(samples);
  const pending = calibrateSamples(samples, gold);
  assert.equal(pending.reviewed, 0);
  assert.equal(pending.pending, 3);
  assert.equal(pending.pair_agreement, null);
  for (const annotation of gold.annotations) Object.assign(annotation, {
    reviewed: true, reviewer: "expert", rationale: "核查完成",
    assessments: Object.fromEntries(annotation.versions.map((version) => [version, { meets_core: true }])),
    outcome: "both_good", winner_version: null,
  });
  const report = calibrateSamples(samples, gold);
  assert.equal(report.reviewed, 3);
  assert.equal(report.core_judgments, 3);
  assert.equal(report.core_agreement, 1);
  assert.equal(report.pair_agreement, 1 / 3);
  gold.annotations[0].reviewer = null;
  assert.throws(() => calibrateSamples(samples, gold), /reviewer and rationale/);
});

test("CLI compare and summarize read current exports and verify receipt identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-current-cli-"));
  try {
    const runs = [path.join(directory, "left"), path.join(directory, "right")];
    for (const [index, run] of runs.entries()) {
      const comparison = row("same-case", ["a", "b"], "a");
      await mkdir(path.join(run, "results"), { recursive: true });
      await writeFile(path.join(run, "results", "comparison.jsonl"), JSON.stringify(comparison) + "\n");
      await writeFile(path.join(run, "state.json"), JSON.stringify({ inputs: {}, tasks: {
        comparison: { stage: "comparison", status: "succeeded", dependencies: {}, receipt: { evaluatorVersion: "judge-current", judge: "resolved-judge",
          submissionId: "submission", exported: { comparisonId: comparison.comparison_id } } },
      } }));
    }
    const compare = spawnSync(process.execPath, ["scripts/benchmark.mjs", "compare", "--run", runs[0], "--run", runs[1]], { encoding: "utf8" });
    assert.equal(compare.status, 0, compare.stderr);
    assert.equal(JSON.parse(compare.stdout).stable, 1);
    const summarize = spawnSync(process.execPath, ["scripts/benchmark.mjs", "summarize", "--run", runs[0], "--bootstrap-rounds", "100"], { encoding: "utf8" });
    assert.equal(summarize.status, 0, summarize.stderr);
    const report = JSON.parse(summarize.stdout);
    assert.equal(report.models.length, 2);
    assert.equal(report.models.find((model) => model.version === "a").answer_cases, 1);
    assert.equal(report.coverage.decided_pair_cases, 1);

    const state = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(runs[0], "state.json"), "utf8"));
    state.tasks.comparison.receipt.exported.comparisonId = "missing";
    await writeFile(path.join(runs[0], "state.json"), JSON.stringify(state));
    assert.notEqual(spawnSync(process.execPath, ["scripts/benchmark.mjs", "summarize", "--run", runs[0], "--bootstrap-rounds", "100"], { encoding: "utf8" }).status, 0);
    await rm(path.join(runs[0], "state.json"));
    const absent = spawnSync(process.execPath, ["scripts/benchmark.mjs", "summarize", "--run", runs[0], "--bootstrap-rounds", "100"], { encoding: "utf8" });
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(JSON.parse(absent.stdout).coverage.decided_coverage, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
