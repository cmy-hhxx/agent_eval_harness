import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pairSamples, compareSamples, summarizeSamples, goldTemplate, calibrateSamples } from "./benchmark-analysis.mjs";
import { rejectedEvaluationDrafts } from "./benchmark-fixtures.mjs";

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

function row(caseId = "one", versions = ["a", "b"], winner = null) {
  const evaluations = Object.fromEntries(versions.map((version) => [version, {
    is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [], summary: "完成查询",
    criterion_assessments: [{ criterion_id: "answer", status: "met", evidence_status: "established", summary: "核心可用", evidence: [{ evidence_id: `ev_${inputIds[version]}_1_text_0_1_/content`, message_index: 1, quote: "4" }] }],
    core_assessment: { meets_core: true, reason: "核心可用", criterion_ids: ["answer"] },
    findings: [{ finding_id: "11111111-1111-4111-8111-111111111111", type: "strength", dimension: "correctness", stage: "final_answer", importance: "high",
      text: "给出结果", reason: "符合所求", evidence: [{ evidence_id: `ev_${inputIds[version]}_1_text_0_1_/content`, message_index: 1, quote: "4" }], problem: null,
      assessment: { requirement_index: 0, observation: "4", evidence_status: "established", impact: "核心可用" } }],
  }]));
  const verdicts = {};
  for (let i = 0; i < versions.length; i++) for (const second of versions.slice(i + 1)) {
    const pair = [versions[i], second], better = winner && pair.includes(winner) ? winner : null;
    verdicts[pair.join("__vs__")] = { result: better ? "win" : "both_good", winner_version: better, winner_name: better, reason: "具体判断" };
  }
  return {
    request_time: null, has_standard_answer: false, evaluator_version: "judge-current",
    evaluation_type: "group_model_comparison", comparison_id: "comparison-" + caseId + "-" + versions.join("-"),
    status: "decided", criteria_task_id: "criteria-" + caseId, attribution_task_ids: Object.fromEntries(versions.map((version) => [version, "attribution-" + caseId + "-" + version])),
    case: { batch_id: "batch", case_id: caseId }, ground_truth: { available: false, value: null },
    models: Object.fromEntries(versions.map((version) => [version, { version, llm: "model", trace_id: "trace" }])),
    ranking: winner ? [[winner], versions.filter((version) => version !== winner)] : [versions],
    assessments: Object.fromEntries(versions.map((version) => [version, { meets_core: true, core_failure_refs: [], summary: "核心可用" }])),
    evaluations, verdicts,
    task_analysis: { task_type: "查询", goal: "结果", requirements: [{ id: "answer", text: "结果", applies_to: [], acceptance_rule: "提供准确的结果。" }], scoring_points: [], red_flags: [] },
    decision_basis: {
      tradeoff: "完成查询", decisive_findings: versions.map((candidate) => ({ candidate, finding_index: 0 })),
      comparisons: [{ aspect: "结果", criterion_ids: ["answer"], importance: "high", better_candidates: winner ? [winner] : [],
        assessments: Object.fromEntries(versions.map((version) => [version, { summary: "给出4", finding_indices: [0], status: "met", evidence_status: "established" }])) }],
    },
  };
}

// Three models produce three independently executed pair rows, sharing the same business case.
const triad = (caseId, winner) => [["a", "b"], ["a", "c"], ["b", "c"]].map((versions) => row(caseId, versions, winner));
const coreFails = (value, version) => {
  value.assessments[version].meets_core = false;
  value.assessments[version].core_failure_refs = ["answer"];
  value.evaluations[version].core_assessment.meets_core = false;
  value.evaluations[version].criterion_assessments[0].status = "unmet";
};

test("comparison uses current pair verdicts, stable IDs and exact missing coverage", () => {
  const before = triad("one", "a"), after = structuredClone(before);
  for (const value of after) {
    value.models = Object.fromEntries(Object.entries(value.models).reverse());
    value.verdicts = Object.fromEntries(Object.entries(value.verdicts).map(([id, verdict]) => [id.split("__vs__").reverse().join("__vs__"), verdict]));
  }
  assert.equal(compareSamples(pairSamples(before), pairSamples(after)).stable, 3);
  after[0].verdicts.b__vs__a.winner_version = "b";
  after[0].evaluations.a.findings[0].assessment.impact = "影响范围变化";
  const report = compareSamples(pairSamples([...before, row("missing")]), pairSamples(after));
  assert.equal(report.changed, 1);
  assert.equal(report.missing, 1);
  assert.equal(report.samples.find((sample) => sample.versions.join() === "a,b" && sample.case.case_id === "one").decisive_basis_changed, true);
  assert.equal(report.samples.find((sample) => !sample.complete).missing_from, "right");
  assert.equal(report.samples.find((sample) => !sample.complete).outcome_changed, null);
});

test("core changes and evidence changes remain separate from outcome agreement", () => {
  const before = row(), after = structuredClone(before);
  coreFails(after, "b");
  after.ranking = [["a"], ["b"]];
  after.verdicts.a__vs__b = { result: "win", winner_version: "a", winner_name: "a", reason: "未完成" };
  const changed = compareSamples(pairSamples([before]), pairSamples([after])).samples[0];
  assert.equal(changed.core_changed, true);
  assert.equal(changed.outcome_changed, true);
  const wording = structuredClone(before);
  wording.decision_basis.tradeoff = "同判决的另一种措辞";
  const stable = compareSamples(pairSamples([before]), pairSamples([wording])).samples[0];
  assert.equal(stable.stable, true);
  assert.equal(stable.tradeoff_changed, true);
});

test("duplicate pairs, missing pair verdicts and orphan decisive refs fail explicitly", () => {
  assert.throws(() => pairSamples([row(), { ...row(), comparison_id: "other" }]), /duplicate case\/model pair/);
  const broken = row(); delete broken.verdicts.a__vs__b;
  assert.throws(() => pairSamples([broken]), /Missing or duplicate verdict/);
  const orphan = row(); orphan.decision_basis.decisive_findings[0].finding_index = 9;
  assert.throws(() => pairSamples([orphan]), /reference does not exist/);
  assert.throws(() => pairSamples([{ case: row().case, verdict: row().verdicts.a__vs__b }]), /current comparison.jsonl envelope/);
});

test("pair matrix groups three independently judged pair outcomes by case and gates both_bad", () => {
  const first = triad("one", "a"), second = triad("two", "b");
  let draw = 0;
  const summary = summarizeSamples(pairSamples([...first, ...second]), { rounds: 100, random: () => [0, 0, 0.99, 0.99][draw++ % 4] });
  assert.equal(summary.cases, 2);
  assert.equal(summary.pair_cases, 6);
  const ab = summary.matrix.find((pair) => pair.versions.join() === "a,b");
  assert.deepEqual(ab.wins, { a: 1, b: 1 });
  assert.deepEqual(ab.score_interval, { level: 0.95, lower: 0, upper: 1 });
  assert.equal(ab.interval_replicates, 100);
  const bad = row();
  for (const version of Object.keys(bad.assessments)) coreFails(bad, version);
  bad.verdicts.a__vs__b = { result: "both_bad", winner_version: null, winner_name: null, reason: "均未完成，a相对更好" };
  const single = summarizeSamples(pairSamples([bad]), { rounds: 100 });
  assert.equal(single.matrix[0].both_bad, 1);
  assert.equal(single.matrix[0].gated_outcome_score, 0.5);
  assert.equal(single.matrix[0].score_interval, null);
});

test("model quality counts answers once across opponents and separates objective accuracy from wins", () => {
  const objective = triad("objective", "a"), subjective = row("subjective", ["a", "b"]);
  for (const value of objective) {
    value.has_standard_answer = true;
    value.ground_truth = { available: true, value: "4" };
    for (const version of Object.keys(value.evaluations)) value.evaluations[version].is_correct = version === "b" ? false : version === "c" ? null : true;
  }
  const summary = summarizeSamples(pairSamples([...objective, subjective]), { rounds: 100 });
  const a = summary.models.find((model) => model.version === "a"), c = summary.models.find((model) => model.version === "c");
  assert.equal(a.pair_cases, 3);
  assert.equal(a.answer_cases, 2, "one answer facing two opponents remains one quality sample");
  assert.equal(a.core.count, 2);
  assert.equal(a.standard_agreement.objective_answers, 1);
  assert.equal(a.standard_agreement.subjective_answers, 1);
  assert.equal(a.standard_agreement.correct, 1);
  assert.equal(a.standard_agreement.rate, 1);
  assert.equal(a.wins + a.losses + a.both_good + a.both_bad, a.pair_cases);
  assert.equal(c.coverage_of_formal_cases, 0.5);
  assert.equal(c.standard_agreement.unknown, 1);
  assert.equal(c.standard_agreement.rate, null, "an undecidable objective answer is not incorrect");
  assert.equal(summary.coverage.scope, "formal_samples_only");
  assert.equal(summary.coverage.decided_coverage, null);
});

test("conflicting judgments across pairs become unknown quality and stay visible", () => {
  const [ab, ac] = triad("conflict", "b");
  for (const value of [ab, ac]) {
    value.has_standard_answer = true;
    value.ground_truth = { available: true, value: "4" };
    for (const version of Object.keys(value.evaluations)) value.evaluations[version].is_correct = true;
  }
  coreFails(ab, "a");
  ab.evaluations.a.is_correct = false;
  const summary = summarizeSamples(pairSamples([ab, ac]), { rounds: 100, planned: { pair_cases: 4, needs_review: 1 } });
  const a = summary.models.find((model) => model.version === "a");
  assert.equal(a.answer_cases, 1);
  assert.equal(a.core.conflicted, 1);
  assert.equal(a.core.unknown, 1);
  assert.equal(a.core.failed, 0);
  assert.equal(a.core.completion_rate, null);
  assert.equal(a.standard_agreement.conflicted, 1);
  assert.equal(a.standard_agreement.unknown, 1);
  assert.equal(a.standard_agreement.rate, null);
  assert.equal(summary.coverage.needs_review_pair_cases, 1);
  assert.equal(summary.coverage.incomplete_pair_cases, 1);
  assert.equal(summary.coverage.decided_coverage, 0.5);
});

test("plan counts cannot hide excess formal results or review counts", () => {
  const samples = pairSamples([row("one"), row("two")]);
  for (const planned of [{ pair_cases: 1, needs_review: 0 }, { pair_cases: 2, needs_review: 1 },
    { pair_cases: -1, needs_review: 0 }, { pair_cases: 2, needs_review: -1 }, { pair_cases: 2.5, needs_review: 0 }])
    assert.throws(() => summarizeSamples(samples, { rounds: 100, planned }), /Run plan counts disagree/);
});

test("different bound standards keep same-answer quality unknown even when pair judgments agree", () => {
  const values = [row("reference", ["a", "b"]), row("reference", ["a", "c"])];
  for (const [index, value] of values.entries()) {
    value.has_standard_answer = true;
    value.ground_truth = { available: true, value: index ? "5" : "4" };
    for (const evaluation of Object.values(value.evaluations)) evaluation.is_correct = true;
  }
  const samples = pairSamples(values), summary = summarizeSamples(samples, { rounds: 100 });
  assert.deepEqual([...samples.values()].map(sample => sample.ground_truth.value), ["4", "5"]);
  const a = summary.models.find(model => model.version === "a");
  assert.equal(a.answer_cases, 1);
  assert.equal(a.core.conditions_conflicted, 1);
  assert.equal(a.core.unknown, 1);
  assert.equal(a.core.completion_rate, null);
  assert.equal(a.standard_agreement.standard_status_conflicted, 1);
  assert.equal(a.standard_agreement.objective_answers, 1);
  assert.equal(a.standard_agreement.unknown, 1);
  assert.equal(a.standard_agreement.rate, null);
  assert.equal(a.standard_agreement.decidable_coverage, 0);
});

test("common acceptance differences conflict core quality but private scope and generated IDs do not", () => {
  const values = [row("conditions", ["a", "b"]), row("conditions", ["a", "c"])];
  values[1].criteria_task_id = "another-persistent-uuid";
  values[1].task_analysis.requirements[0].id = "another-generated-id";
  const common = values[1].task_analysis.requirements[0];
  const additional = { id: "scope", text: "核对查询对象", acceptance_rule: "使用原题对象", applies_to: [] };
  values[0].task_analysis.requirements.push(additional);
  values[1].task_analysis.requirements.unshift(structuredClone(additional));
  values[1].task_analysis.requirements.push({ id: "private", text: "私有格式", acceptance_rule: "私有格式",
    applies_to: [inputIds.c] });
  const quality = () => summarizeSamples(pairSamples(values), { rounds: 100 }).models.find(model => model.version === "a");
  assert.equal(quality().core.conditions_conflicted, 0);
  assert.equal(quality().core.completion_rate, 1);
  common.acceptance_rule = "必须提供过程证据。";
  assert.equal(quality().core.conditions_conflicted, 1);
  assert.equal(quality().core.completion_rate, null);
});

test("subjective answers cannot silently enter objective accuracy", () => {
  const value = row(); value.evaluations.a.is_correct = true;
  assert.throws(() => pairSamples([value]), /Correctness requires an objective/);
});

test("standard conflicts retain existing agreement results and count affected answers once", () => {
  const values = triad("standard", "a");
  for (const value of values) {
    value.has_standard_answer = true;
    value.ground_truth = { available: true, value: "4" };
    for (const version of Object.keys(value.evaluations)) {
      value.evaluations[version].is_correct = version !== "a";
      value.evaluations[version].standard_conflict = version === "a";
    }
  }
  const summary = summarizeSamples(pairSamples(values), { rounds: 100 });
  assert.deepEqual(summary.standard_conflicts, { answer_count: 1, case_count: 1 });
  const a = summary.models.find((model) => model.version === "a"), b = summary.models.find((model) => model.version === "b");
  assert.equal(a.standard_agreement.standard_conflict_answers, 1);
  assert.equal(a.standard_agreement.incorrect, 1, "the marker does not rewrite the accepted standard-agreement judgment");
  assert.equal(a.standard_agreement.rate, 0);
  assert.equal(a.wins, 2, "the marker does not change formal pair results");
  assert.equal(b.standard_agreement.correct, 1, "an unmarked peer is not silently excluded");
});

test("gold template carries no model predictions and unreviewed entries measure no agreement", () => {
  const samples = pairSamples([row()]), template = goldTemplate(samples);
  assert.equal(template.annotations[0].reviewed, false);
  assert.equal(template.annotations[0].outcome, null);
  assert.equal(template.annotations[0].assessments.a.meets_core, null);
  const report = calibrateSamples(samples, template);
  assert.equal(report.reviewed, 0);
  assert.equal(report.pending, 1);
  assert.equal(report.review_status, "pending_expert_review");
  assert.equal(report.pair_agreement, null);
  assert.equal(report.core_agreement, null);
});

test("expert calibration reports separate outcome, winner and deduplicated core agreement", () => {
  const samples = pairSamples(triad("one", "a"));
  const gold = goldTemplate(samples);
  for (const annotation of gold.annotations) Object.assign(annotation, {
    reviewed: true, reviewer: "reviewer", rationale: "专家核查双方结果均相符，无实质差距",
    assessments: Object.fromEntries(annotation.versions.map((version) => [version, { meets_core: true }])),
    outcome: "both_good", winner_version: null,
  });
  const report = calibrateSamples(samples, gold);
  assert.equal(report.reviewed, 3);
  assert.equal(report.core_judgments, 3);
  assert.equal(report.core_agreement, 1);
  assert.equal(report.pair_agreement, 1 / 3);
  assert.equal(report.errors.pairs.length, 2);
  assert.equal(report.errors.pairs[0].actual.trace.evaluator_version, "judge-current");
  gold.annotations[0].reviewer = null;
  assert.throws(() => calibrateSamples(samples, gold), /reviewer and rationale/);
});

test("expert annotations reject inconsistent core judgments and distinguish missing outputs", () => {
  const samples = pairSamples(triad("one", "a"));
  const gold = goldTemplate(samples);
  for (const annotation of gold.annotations) Object.assign(annotation, {
    reviewed: true, reviewer: "expert", rationale: "核查完成",
    assessments: Object.fromEntries(annotation.versions.map((version) => [version, { meets_core: true }])),
    outcome: "both_good", winner_version: null,
  });
  gold.annotations[1].assessments.a.meets_core = false;
  gold.annotations[1].outcome = "win"; gold.annotations[1].winner_version = "c";
  assert.throws(() => calibrateSamples(samples, gold), /conflicting core/);
  gold.annotations = [gold.annotations[0]];
  const missing = calibrateSamples(new Map(), gold);
  assert.equal(missing.missing_pairs, 1);
  assert.equal(missing.pair_agreement, null);
  assert.equal(missing.errors.core.length, 2);
});

test("no observed variation yields no degenerate interval, mixed judges stay visible", () => {
  const rows = [row("one"), row("two")];
  const traces = new Map(rows.map((item, index) => [item.comparison_id, { evaluator_version: "judge-current", judge: "judge-" + index }]));
  const report = summarizeSamples(pairSamples(rows, traces), { rounds: 100 });
  assert.equal(report.matrix[0].interval_status, "no_observed_variation");
  assert.equal(report.matrix[0].score_interval, null);
  assert.equal(report.mixed_evaluator_judges, true);
  assert.equal(report.trace_cohorts.length, 2);
  assert.equal(report.trace_cohorts[0].summary.cases, 1);
});

test("one cohort still reports mixed attribution evaluator judges without discarding model bindings", () => {
  const rows = [row("one", ["a", "b"]), row("two", ["a", "c"])];
  const traces = new Map(rows.map((item, index) => [item.comparison_id, { evaluator_version: "judge-current", judge: "comparison-judge",
    attributions: Object.keys(item.models).map((version, position) => ({ version,
      evaluator_version: (index + position) % 2 ? "r2" : "r1", judge: (index + position) % 2 ? "judge2" : "judge1" })) }]));
  const samples = pairSamples(rows, traces), report = summarizeSamples(samples, { rounds: 100 });
  assert.equal(report.trace_cohorts.length, 1);
  assert.equal(report.mixed_evaluator_judges, true);
  assert.deepEqual([...samples.values()].map(sample => sample.trace.attributions[0]),
    [{ version: "a", evaluator_version: "r1", judge: "judge1" }, { version: "a", evaluator_version: "r2", judge: "judge2" }]);
});

test("CLI compare reads only comparison.jsonl and traces accepted current receipts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-current-"));
  try {
    for (const name of ["left", "right"]) {
      const run = path.join(directory, name), comparison = row();
      await mkdir(path.join(run, "results"), { recursive: true });
      await writeFile(path.join(run, "results/comparison.jsonl"), JSON.stringify(comparison) + "\n");
      await writeFile(path.join(run, "results/attribution.jsonl"), "not comparison JSON\n");
      await writeFile(path.join(run, "results/clustering.jsonl"), "also not comparison JSON\n");
      await writeFile(path.join(run, "state.json"), JSON.stringify({ inputs: {}, tasks: {
        comparison: { stage: "comparison", status: "succeeded", dependencies: {}, receipt: { evaluatorVersion: "judge-current", judge: "resolved-judge", submissionId: "submission", exported: { comparisonId: comparison.comparison_id } } },
      } }));
    }
    const result = spawnSync(process.execPath, ["scripts/benchmark.mjs", "compare", "--run", path.join(directory, "left"), "--run", path.join(directory, "right")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stable, 1);
    assert.equal(report.samples[0].judgments[0].trace.judge, "resolved-judge");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI summarize combines distinct runs, preserves plan coverage, and rejects overlapping pairs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "benchmark-summary-"));
  try {
    const runs = [path.join(directory, "left"), path.join(directory, "right")];
    for (const [index, run] of runs.entries()) {
      const comparison = row("case-" + index, index ? ["a", "c"] : ["a", "b"], "a");
      await mkdir(path.join(run, "results"), { recursive: true });
      await writeFile(path.join(run, "results/comparison.jsonl"), JSON.stringify(comparison) + "\n");
      await writeFile(path.join(run, "results/attribution.jsonl"), "not a summary source\n");
      await writeFile(path.join(run, "state.json"), JSON.stringify({ inputs: {}, tasks: {
        comparison: { stage: "comparison", status: "succeeded", dependencies: {}, receipt: { evaluatorVersion: "judge-current", judge: "resolved-judge",
          submissionId: "submission", exported: { comparisonId: comparison.comparison_id } } },
        ...(index ? {} : {
          review: { stage: "comparison", status: "succeeded", dependencies: {}, receipt: { evaluatorVersion: "judge-current", judge: "resolved-judge",
            exported: { taskId: "review", file: "comparison-review.jsonl" } } },
          queued: { stage: "comparison", status: "pending", dependencies: {} },
        }),
        verification: { stage: "comparison", data: { verificationAudit: true }, dependencies: {} },
      } }));
      if (!index) await writeFile(path.join(run, "results/comparison-review.jsonl"), JSON.stringify({
        task_id: "review", evaluation_type: "comparison_review", evaluator_version: "judge-current", result: { status: "needs_review" },
      }) + "\n");
    }
    const invoke = (selected) => spawnSync(process.execPath, ["scripts/benchmark.mjs", "summarize", ...selected.flatMap((run) => ["--run", run]),
      "--bootstrap-rounds", "100"], { encoding: "utf8" });
    const result = invoke(runs);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.models.length, 3);
    assert.equal(report.models.find((model) => model.version === "a").answer_cases, 2);
    assert.deepEqual(report.coverage, { scope: "run_plan", planned_pair_cases: 4, decided_pair_cases: 2,
      needs_review_pair_cases: 1, incomplete_pair_cases: 1, decided_coverage: 0.5 });
    const overlap = invoke([runs[0], runs[0]]);
    assert.notEqual(overlap.status, 0);
    assert.match(overlap.stderr, /duplicate case\/model pair across runs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("CLI checks result receipt identity and review exports while absent state leaves coverage unknown", async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), "benchmark-receipts-")), comparison = row();
  const invoke = () => spawnSync(process.execPath, ["scripts/benchmark.mjs", "summarize", "--run", run,
    "--bootstrap-rounds", "100"], { encoding: "utf8" });
  try {
    await mkdir(path.join(run, "results"));
    await writeFile(path.join(run, "results/comparison.jsonl"), JSON.stringify(comparison) + "\n");
    const withoutState = invoke();
    assert.equal(withoutState.status, 0, withoutState.stderr);
    assert.equal(JSON.parse(withoutState.stdout).coverage.decided_coverage, null);
    const checkpoint = { inputs: {}, tasks: { comparison: { stage: "comparison", status: "succeeded", dependencies: {},
      receipt: { evaluatorVersion: "judge-current", judge: "judge", exported: { comparisonId: comparison.comparison_id } } } } };
    for (const change of [
      state => { state.tasks = {}; },
      state => { state.tasks.comparison.status = "pending"; },
      state => { state.tasks.comparison.data = { verificationAudit: true }; },
      state => { state.tasks.comparison.receipt.exported.comparisonId = "missing"; },
    ]) {
      const invalid = structuredClone(checkpoint); change(invalid);
      await writeFile(path.join(run, "state.json"), JSON.stringify(invalid));
      assert.notEqual(invoke().status, 0);
    }
    await writeFile(path.join(run, "state.json"), JSON.stringify(checkpoint));
    assert.equal(invoke().status, 0);
    const review = { stage: "comparison", status: "succeeded", dependencies: {}, receipt: {
      evaluatorVersion: "judge-current", exported: { taskId: "review", file: "comparison-review.jsonl" } } };
    await writeFile(path.join(run, "state.json"), JSON.stringify({ ...checkpoint,
      tasks: { ...checkpoint.tasks, review } }));
    const missingReview = invoke();
    assert.notEqual(missingReview.status, 0);
    assert.match(missingReview.stderr, /Review results and succeeded export receipts disagree/);
  } finally { await rm(run, { recursive: true, force: true }); }
});
