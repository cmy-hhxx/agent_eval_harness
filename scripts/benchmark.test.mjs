import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pairSamples, compareSamples, summarizeSamples, goldTemplate, calibrateSamples } from "./benchmark-analysis.mjs";

function row(caseId = "one", versions = ["a", "b"], winner = null) {
  const evaluations = Object.fromEntries(versions.map((version) => [version, {
    is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [], summary: "完成查询",
    criterion_assessments: [{ criterion_id: "answer", status: "met", evidence_status: "established", summary: "核心可用", evidence: [{ message_index: 1, quote: "4" }] }],
    core_assessment: { meets_core: true, reason: "核心可用", criterion_ids: ["answer"] },
    findings: [{ finding_id: "11111111-1111-4111-8111-111111111111", type: "strength", dimension: "correctness", stage: "final_answer", importance: "high",
      text: "给出结果", reason: "符合所求", evidence: [{ message_index: 1, quote: "4" }], problem: null,
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
        comparison: { stage: "comparison", dependencies: {}, receipt: { evaluatorVersion: "judge-current", judge: "resolved-judge", submissionId: "submission", exported: { comparisonId: comparison.comparison_id } } },
      } }));
    }
    const result = spawnSync(process.execPath, ["scripts/benchmark.mjs", "compare", "--run", path.join(directory, "left"), "--run", path.join(directory, "right")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stable, 1);
    assert.equal(report.samples[0].judgments[0].trace.judge, "resolved-judge");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
