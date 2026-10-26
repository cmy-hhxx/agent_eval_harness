import { isDeepStrictEqual } from "node:util";

const key = (sample) => JSON.stringify([sample.case.batch_id, sample.case.case_id, sample.versions]);
const caseKey = (sample) => JSON.stringify([sample.case.batch_id, sample.case.case_id]);
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const outcomes = ["win", "both_good", "both_bad"];
const commonCriteria = (analysis) => ({ goal: analysis.goal,
  ...Object.fromEntries(["requirements", "scoring_points", "red_flags"].map((field) => [field,
    analysis[field].filter((item) => !item.applies_to.length).map(({ text, acceptance_rule }) => ({ text, acceptance_rule }))
      .sort((a, b) => a.text.localeCompare(b.text) || a.acceptance_rule.localeCompare(b.acceptance_rule))])) });

function identity(value) {
  if (!value || !nonempty(value.batch_id) || !nonempty(value.case_id)) throw new Error("Expected business case identity");
  return { batch_id: value.batch_id, case_id: value.case_id };
}
function validateDecision(versions, assessments, outcome, winner) {
  if (!outcomes.includes(outcome)) throw new Error("Expected current pair outcome: win / both_good / both_bad");
  if (versions.some((version) => typeof assessments?.[version]?.meets_core !== "boolean"))
    throw new Error("Every model needs an explicit meets_core judgment");
  if (outcome === "win") {
    if (!versions.includes(winner) || !assessments[winner].meets_core) throw new Error("Winner must be a usable model in this pair");
  } else if (winner !== null || versions.some((version) => assessments[version].meets_core !== (outcome === "both_good")))
    throw new Error("Pair outcome contradicts core judgments or winner");
}
function decisiveBasis(row, versions) {
  return row.decision_basis.decisive_findings.filter((ref) => versions.includes(ref.candidate)).map((ref) => {
    const finding = row.evaluations[ref.candidate]?.Problem?.[ref.finding_index];
    if (!finding) throw new Error("Decisive finding reference does not exist");
    const { stage_trace: _trace, ...value } = finding;
    return { candidate: ref.candidate, finding: value };
  }).sort((a, b) => a.candidate.localeCompare(b.candidate) || a.finding.problem_id.localeCompare(b.finding.problem_id));
}

/** Read independently judged pair rows. Several pairs from one business case remain correlated. */
export function pairSamples(rows, traceByComparison = new Map()) {
  const samples = new Map();
  const comparisonIds = new Set();
  for (const row of rows) {
    if (row.evaluation_type !== "group_model_comparison" || row.status !== "decided" || !nonempty(row.comparison_id) ||
        !nonempty(row.evaluator_version) || !row.verdicts || !row.evaluations || !row.models ||
        !Array.isArray(row.decision_basis?.comparisons) || !Array.isArray(row.decision_basis?.decisive_findings))
      throw new Error("Expected current comparison.jsonl envelope");
    if (comparisonIds.has(row.comparison_id)) throw new Error("Duplicate comparison_id: " + row.comparison_id);
    comparisonIds.add(row.comparison_id);
    const businessCase = identity(row.case);
    const versions = Object.keys(row.models).sort();
    if (versions.length !== 2) throw new Error("Each current benchmark comparison must contain exactly two models");
    if (!isDeepStrictEqual(Object.keys(row.assessments ?? {}).sort(), versions) ||
        !isDeepStrictEqual(Object.keys(row.evaluations).sort(), versions)) throw new Error("Candidate coverage is incomplete");
    if (typeof row.has_standard_answer !== "boolean") throw new Error("Expected explicit standard-answer availability");
    if (row.ground_truth?.available !== row.has_standard_answer || !Object.hasOwn(row.ground_truth, "value"))
      throw new Error("Standard-answer availability differs from the bound reference");
    for (const version of versions) {
      const correct = row.evaluations[version].is_correct;
      if ((correct !== null && typeof correct !== "boolean") || (!row.has_standard_answer && correct !== null))
        throw new Error("Correctness requires an objective, explicitly judged answer");
    }
    const expectedPairs = new Set();
    for (let i = 0; i < versions.length; i++) for (const second of versions.slice(i + 1)) {
      const pair = [versions[i], second];
      const matched = Object.entries(row.verdicts).filter(([name]) =>
        name === pair.join("__vs__") || name === [...pair].reverse().join("__vs__"));
      if (matched.length !== 1) throw new Error("Missing or duplicate verdict for " + pair.join(" vs "));
      expectedPairs.add(matched[0][0]);
      const verdict = matched[0][1];
      validateDecision(pair, row.assessments, verdict.result, verdict.winner_version);
      const trace = traceByComparison.get(row.comparison_id) ?? {
        evaluator_version: row.evaluator_version, judge: null, trace_status: "state_unavailable",
      };
      if (trace.evaluator_version !== row.evaluator_version) throw new Error("Result and receipt evaluator versions disagree");
      const sample = {
        case: businessCase, versions: pair,
        comparison_id: row.comparison_id,
        criteria_task_id: row.criteria_task_id,
        attribution_task_ids: row.attribution_task_ids,
        outcome: verdict.result, winner_version: verdict.winner_version,
        meets_core: Object.fromEntries(pair.map((version) => [version, row.assessments[version].meets_core])),
        has_standard_answer: row.has_standard_answer,
        ground_truth: structuredClone(row.ground_truth),
        common_criteria: commonCriteria(row.task_analysis),
        is_correct: Object.fromEntries(pair.map((version) => [version, row.evaluations[version].is_correct])),
        trace,
        decision_basis: {
          tradeoff: row.decision_basis.tradeoff,
          decisive_findings: decisiveBasis(row, pair),
          comparisons: row.decision_basis.comparisons.map((item) => ({
            aspect: item.aspect, importance: item.importance, criterion_ids: item.criterion_ids,
            better_candidates: item.better_candidates.filter((version) => pair.includes(version)).sort(),
            assessments: Object.fromEntries(pair.map((version) => [version, item.assessments[version]])),
          })),
        },
        task_analysis: row.task_analysis,
      };
      if (samples.has(key(sample))) throw new Error("Ambiguous duplicate case/model pair: " + key(sample));
      samples.set(key(sample), sample);
    }
    if (Object.keys(row.verdicts).length !== expectedPairs.size) throw new Error("Unexpected pair verdict keys");
  }
  return samples;
}

export function compareSamples(left, right) {
  const samples = [...new Set([...left.keys(), ...right.keys()])].sort().map((id) => {
    const a = left.get(id), b = right.get(id);
    const complete = !!a && !!b;
    return {
      case: (a ?? b).case, versions: (a ?? b).versions,
      complete, missing_from: !a ? "left" : !b ? "right" : null,
      outcome_changed: complete ? a.outcome !== b.outcome : null,
      winner_changed: complete ? a.winner_version !== b.winner_version : null,
      core_changed: complete ? !isDeepStrictEqual(a.meets_core, b.meets_core) : null,
      decisive_basis_changed: complete ? !isDeepStrictEqual(a.decision_basis.decisive_findings, b.decision_basis.decisive_findings) : null,
      comparison_basis_changed: complete ? !isDeepStrictEqual(a.decision_basis.comparisons, b.decision_basis.comparisons) : null,
      tradeoff_changed: complete ? a.decision_basis.tradeoff !== b.decision_basis.tradeoff : null,
      task_analysis_changed: complete ? !isDeepStrictEqual(a.task_analysis, b.task_analysis) : null,
      stable: complete && a.outcome === b.outcome && a.winner_version === b.winner_version && isDeepStrictEqual(a.meets_core, b.meets_core),
      judgments: [a ?? null, b ?? null],
    };
  });
  return {
    pair_cases: samples.length, complete: samples.filter((sample) => sample.complete).length,
    missing: samples.filter((sample) => !sample.complete).length,
    stable: samples.filter((sample) => sample.stable).length,
    changed: samples.filter((sample) => sample.complete && !sample.stable).length,
    manual_review: "逐项核查决定性发现和反向证据；稳定不等于事实正确，依据文案变化不自动构成错判",
    samples,
  };
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability, lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

/** Quality denominators count each answer once, regardless of how many opponents it faced. */
function modelSummaries(samples, formalCases) {
  const models = new Map();
  for (const sample of samples) for (const version of sample.versions) {
    if (!models.has(version)) models.set(version, { version, pair_cases: 0, wins: 0, losses: 0, both_good: 0, both_bad: 0, answers: new Map() });
    const model = models.get(version);
    model.pair_cases++;
    if (sample.outcome === "win") model[sample.winner_version === version ? "wins" : "losses"]++;
    else model[sample.outcome]++;
    const id = caseKey(sample);
    if (!model.answers.has(id)) model.answers.set(id, []);
    model.answers.get(id).push({ meets_core: sample.meets_core[version], has_standard_answer: sample.has_standard_answer,
      ground_truth: sample.ground_truth, common_criteria: sample.common_criteria,
      is_correct: sample.is_correct[version] });
  }
  return [...models.values()].sort((a, b) => a.version.localeCompare(b.version)).map(({ answers, ...model }) => {
    const core = { count: answers.size, completed: 0, failed: 0, unknown: 0, conflicted: 0, conditions_conflicted: 0 };
    const agreement = { basis: "standard_answer_agreement", objective_answers: 0, subjective_answers: 0,
      standard_status_conflicted: 0, correct: 0, incorrect: 0, unknown: 0, conflicted: 0 };
    for (const observations of answers.values()) {
      const cores = new Set(observations.map((item) => item.meets_core));
      const referenceConflict = observations.some((item) => !isDeepStrictEqual(item.ground_truth, observations[0].ground_truth));
      const conditionsConflict = referenceConflict || observations.some((item) => !isDeepStrictEqual(item.common_criteria, observations[0].common_criteria));
      if (conditionsConflict || cores.size !== 1) { core.unknown++; core.conflicted++; if (conditionsConflict) core.conditions_conflicted++; }
      else core[cores.has(true) ? "completed" : cores.has(false) ? "failed" : "unknown"]++;
      const standards = new Set(observations.map((item) => item.has_standard_answer));
      if (standards.has(true)) agreement.objective_answers++;
      if (standards.size !== 1 || referenceConflict) {
        agreement.standard_status_conflicted++; agreement.unknown++; agreement.conflicted++; continue;
      }
      if (!standards.has(true)) { agreement.subjective_answers++; continue; }
      const correctness = new Set(observations.map((item) => item.is_correct));
      if (correctness.size !== 1) { agreement.unknown++; agreement.conflicted++; }
      else agreement[correctness.has(true) ? "correct" : correctness.has(false) ? "incorrect" : "unknown"]++;
    }
    const coreDecided = core.completed + core.failed, correctDecided = agreement.correct + agreement.incorrect;
    return { ...model, answer_cases: answers.size, coverage_of_formal_cases: formalCases ? answers.size / formalCases : null,
      core: { ...core, completion_rate: coreDecided ? core.completed / coreDecided : null, decidable_coverage: answers.size ? coreDecided / answers.size : null },
      standard_agreement: { ...agreement, rate: correctDecided ? agreement.correct / correctDecided : null,
        decidable_coverage: agreement.objective_answers ? correctDecided / agreement.objective_answers : null } };
  });
}
/** Resample whole business cases, retaining all correlated pairs from each sampled case. */
export function summarizeSamples(sampleMap, { rounds = 2000, random = Math.random, includeCohorts = true, planned = null } = {}) {
  if (!Number.isInteger(rounds) || rounds < 100) throw new Error("Bootstrap rounds must be at least 100");
  const samples = [...sampleMap.values()];
  if (planned !== null && (!Number.isSafeInteger(planned.pair_cases) || planned.pair_cases < 0 ||
      !Number.isSafeInteger(planned.needs_review) || planned.needs_review < 0 ||
      samples.length + planned.needs_review > planned.pair_cases))
    throw new Error("Run plan counts disagree with decided and needs_review comparisons");
  const groups = new Map();
  for (const sample of samples) {
    if (!groups.has(caseKey(sample))) groups.set(caseKey(sample), []);
    groups.get(caseKey(sample)).push(sample);
  }
  const pairs = [...new Set(samples.map((sample) => JSON.stringify(sample.versions)))].sort();
  const clusters = [...groups.values()];
  const draws = new Map(pairs.map((pair) => [pair, []]));
  // The score is explicitly the current gated outcome score; both_bad carries no inferred preference.
  const score = (sample) => sample.outcome !== "win" ? 0.5 : sample.winner_version === sample.versions[0] ? 1 : 0;
  if (clusters.length >= 2) for (let iteration = 0; iteration < rounds; iteration++) {
    const totals = new Map();
    for (let n = 0; n < clusters.length; n++) {
      const cluster = clusters[Math.min(Math.floor(random() * clusters.length), clusters.length - 1)];
      for (const sample of cluster) {
        const pair = JSON.stringify(sample.versions), total = totals.get(pair) ?? [0, 0];
        total[0] += score(sample); total[1]++;
        totals.set(pair, total);
      }
    }
    for (const [pair, [sum, count]] of totals) draws.get(pair).push(sum / count);
  }
  const matrix = pairs.map((pair) => {
    const versions = JSON.parse(pair), observed = samples.filter((sample) => JSON.stringify(sample.versions) === pair);
    const byCase = new Set(observed.map(caseKey));
    const distribution = draws.get(pair).sort((a, b) => a - b);
    const intervalStatus = byCase.size < 2 ? "insufficient_cases" : distribution.length < rounds * 0.9 ? "insufficient_bootstrap_coverage"
      : distribution[0] === distribution.at(-1) ? "no_observed_variation" : "estimated";
    return {
      versions, pair_cases: observed.length, cases: byCase.size,
      wins: Object.fromEntries(versions.map((version) => [version, observed.filter((sample) => sample.winner_version === version).length])),
      both_good: observed.filter((sample) => sample.outcome === "both_good").length,
      both_bad: observed.filter((sample) => sample.outcome === "both_bad").length,
      core_pass_rate: Object.fromEntries(versions.map((version) => [version, observed.filter((sample) => sample.meets_core[version]).length / observed.length])),
      gated_outcome_score: observed.reduce((sum, sample) => sum + score(sample), 0) / observed.length,
      score_interval: intervalStatus !== "estimated" ? null : {
        level: 0.95, lower: percentile(distribution, 0.025), upper: percentile(distribution, 0.975),
      },
      interval_status: intervalStatus,
      interval_replicates: distribution.length,
    };
  });
  const cohorts = new Map();
  for (const [id, sample] of sampleMap) {
    const provenance = {
      evaluator_version: sample.trace.evaluator_version, judge: sample.trace.judge,
      criteria: sample.trace.criteria ? {
        evaluator_version: sample.trace.criteria.evaluator_version, judge: sample.trace.criteria.judge,
      } : null,
      attribution_evaluators: [...new Set((sample.trace.attributions ?? []).map((item) => JSON.stringify([item.evaluator_version, item.judge])))].sort().map((value) => {
        const [evaluator_version, judge] = JSON.parse(value); return { evaluator_version, judge };
      }),
    };
    const cohortId = JSON.stringify(provenance);
    if (!cohorts.has(cohortId)) cohorts.set(cohortId, { provenance, samples: new Map() });
    cohorts.get(cohortId).samples.set(id, sample);
  }
  return {
    cases: clusters.length, pair_cases: samples.length,
    coverage: { scope: planned === null ? "formal_samples_only" : "run_plan", planned_pair_cases: planned?.pair_cases ?? null,
      decided_pair_cases: samples.length, needs_review_pair_cases: planned?.needs_review ?? null,
      incomplete_pair_cases: planned === null ? null : planned.pair_cases - samples.length - planned.needs_review,
      decided_coverage: planned?.pair_cases ? samples.length / planned.pair_cases : null },
    quality_scope: "unique (batch_id, case_id, version) answers in formal decided pairs; differing bound standards or common criteria remain unknown quality; model coverage uses only cases with a formal pair; unresolved and uncompleted answers are not failures",
    models: modelSummaries(samples, clusters.length),
    estimator: "current gated outcomes: first model win=1, second model win=0, both_good/both_bad=0.5; not human preference or BT",
    interval_method: "business-case cluster percentile bootstrap", bootstrap_rounds: rounds,
    uncertainty_scope: "输入题目的抽样变化；不证明裁判语义正确性，同题分别执行的对局按 case 成簇；缺少独立题目或观测变异时不报退化区间",
    mixed_evaluator_judges: cohorts.size > 1 || [...cohorts.values()].some(cohort => cohort.provenance.attribution_evaluators.length > 1),
    trace_cohorts: [...cohorts.values()].map((cohort) => ({
      ...cohort.provenance, pair_cases: cohort.samples.size,
      ...(includeCohorts && cohorts.size > 1 ? {
        summary: summarizeSamples(cohort.samples, { rounds, random, includeCohorts: false }),
      } : {}),
    })),
    matrix,
  };
}

export function goldTemplate(samples) {
  return {
    review_status: "pending_expert_review",
    note: "仅提供待审核条目的业务定位；以下 null 不是专家结论，不得拿模型输出自动填为金标。专家核查原始输入、共同要求与证据后填写。",
    annotations: [...samples.values()].map((sample) => ({
      case: sample.case, versions: sample.versions,
      reviewed: false, reviewer: null, rationale: null,
      assessments: Object.fromEntries(sample.versions.map((version) => [version, { meets_core: null }])),
      outcome: null, winner_version: null,
    })),
  };
}

export function calibrateSamples(samples, gold) {
  if (!gold || !Array.isArray(gold.annotations)) throw new Error("Gold file requires annotations");
  const seen = new Set(), expectedCore = new Map(), pairResults = [];
  let pending = 0;
  for (const annotation of gold.annotations) {
    const businessCase = identity(annotation.case);
    if (!Array.isArray(annotation.versions) || annotation.versions.length !== 2 ||
        annotation.versions.some((version) => !nonempty(version)) || new Set(annotation.versions).size !== 2)
      throw new Error("Expert annotation must reference exactly two distinct stable model IDs");
    const versions = [...annotation.versions].sort(), normalized = { case: businessCase, versions };
    if (seen.has(key(normalized))) throw new Error("Duplicate gold case/model pair");
    seen.add(key(normalized));
    if (typeof annotation.reviewed !== "boolean") throw new Error("Gold reviewed must be explicit");
    if (!annotation.reviewed) { pending++; continue; }
    if (!nonempty(annotation.reviewer) || !nonempty(annotation.rationale)) throw new Error("Reviewed gold needs named reviewer and rationale");
    if (!isDeepStrictEqual(Object.keys(annotation.assessments ?? {}).sort(), versions)) throw new Error("Gold model coverage differs from pair");
    validateDecision(versions, annotation.assessments, annotation.outcome, annotation.winner_version);
    for (const version of versions) {
      const id = JSON.stringify([businessCase.batch_id, businessCase.case_id, version]), expected = annotation.assessments[version].meets_core;
      if (expectedCore.has(id) && expectedCore.get(id).expected !== expected) throw new Error("Gold has conflicting core judgments for the same case/model");
      expectedCore.set(id, { case: businessCase, version, expected });
    }
    const observed = samples.get(key(normalized));
    pairResults.push({
      ...normalized, reviewer: annotation.reviewer, rationale: annotation.rationale,
      complete: !!observed,
      expected: { outcome: annotation.outcome, winner_version: annotation.winner_version },
      actual: observed ? {
        outcome: observed.outcome, winner_version: observed.winner_version, comparison_id: observed.comparison_id,
        criteria_task_id: observed.criteria_task_id, attribution_task_ids: observed.attribution_task_ids,
        trace: observed.trace, decision_basis: observed.decision_basis,
      } : null,
      outcome_matches: observed ? annotation.outcome === observed.outcome : null,
      winner_matches: observed ? annotation.winner_version === observed.winner_version : null,
      matches: !!observed && annotation.outcome === observed.outcome && annotation.winner_version === observed.winner_version,
    });
  }
  const coreResults = [...expectedCore.values()].map((item) => {
    const matching = [...samples.values()].filter((sample) => caseKey(sample) === caseKey(item) && sample.versions.includes(item.version));
    const observed = [...new Set(matching.map((sample) => sample.meets_core[item.version]))];
    return { ...item, actual: observed.length === 1 ? observed[0] : null, conflict: observed.length > 1,
      observations: matching.map((sample) => ({
        comparison_id: sample.comparison_id, attribution_task_id: sample.attribution_task_ids[item.version],
        meets_core: sample.meets_core[item.version], trace: sample.trace,
      })),
      complete: observed.length > 0, matches: observed.length === 1 && observed[0] === item.expected };
  });
  const measuredPairs = pairResults.filter((result) => result.complete), measuredCore = coreResults.filter((result) => result.complete);
  const rate = (items, field) => items.length ? items.filter((item) => item[field]).length / items.length : null;
  return {
    review_status: pairResults.length ? pending ? "partial_expert_review" : "expert_annotations_loaded" : "pending_expert_review",
    annotations: gold.annotations.length, reviewed: pairResults.length, pending,
    matched_pairs: measuredPairs.length, missing_pairs: pairResults.length - measuredPairs.length,
    core_judgments: measuredCore.length,
    core_agreement: rate(measuredCore, "matches"),
    pair_agreement: rate(measuredPairs, "matches"), outcome_agreement: rate(measuredPairs, "outcome_matches"), winner_agreement: rate(measuredPairs, "winner_matches"),
    semantic_review: "仅对明确人工审核的标注统计；工具不验证专家结论本身，未标注题目不算语义验收通过",
    errors: { pairs: pairResults.filter((result) => !result.matches), core: coreResults.filter((result) => !result.matches) },
    pairs: pairResults, core: coreResults,
  };
}
