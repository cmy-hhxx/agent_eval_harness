import { draftFor } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emptyUsage, type AgentBackend, type ModelConfig, type RunManifest, type SubmissionReceipt } from "../../packages/contracts/src/index.js";
import { readJsonl, writeInputs, writeJson } from "../../packages/contracts/src/io.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { outputSchema, pairwisePack, validateEvaluation } from "../../packages/pairwise-eval/src/index.js";
import { comparisonRow, reportRun } from "../../packages/pairwise-eval/src/report.js";
import { writeRunState } from "../../packages/pairwise-eval/src/run-data.js";
import type { PairwiseResult, TaskData } from "../../packages/pairwise-eval/src/types.js";
import { validateRun } from "../../apps/host/src/validate.js";
import { runEvaluation } from "../../apps/host/src/runner.js";
import { startWorker } from "../../packages/worker/src/server.js";
import { emptyAudit, fakeIdentity, fixtureConfig, pairResult, raw } from "./fixtures.js";

function receipt(taskId: string, evaluation: unknown): SubmissionReceipt {
  return {
    taskId, attemptId: "test", submissionId: randomUUID(), evaluation,
    audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", acceptedAt: 0,
  };
}
function badResult(): PairwiseResult {
  const result = pairResult({ A: "2+2=5", B: "2+2=5" });
  result.verdict = { result: "both_bad", reason: "双方都把2+2算成5，核心结果错误，未发现可用性差异。" };
  result.decision_basis.tradeoff = "双方均未交付正确结果，也无足以区分胜负的其他差异。";
  for (const review of Object.values(result.evaluations)) {
    review.summary = "核心加法结果错误。";
    Object.assign(review.findings[0], { type: "problem", text: "结果错误", reason: "2+2应为4。" });
    review.findings[0].assessment.impact = "未完成核心计算要求。";
  }
  return result;
}

test("evidence can quote structured numeric tool output without accepting invented values", async () => {
  const input = raw("q", null);
  input.messages.splice(1, 0, { type: "function_call_output", output: { datas: [{ "数量[20240220]": 4444 }] } });
  const { directory, config } = await fixtureConfig([[input], [], [input], []]);
  try {
    const plan = await buildPlan(config), result = pairResult();
    for (const review of Object.values(result.evaluations)) review.findings[0].evidence[0].message_index = 2;
    const evidence = { message_index: 1, quote: '"数量[20240220]": 4444' };
    result.evaluations.A.findings[0].evidence.push(evidence);
    const check = () => validateEvaluation(plan.tasks[0], plan.inputs, result, emptyAudit(), {});
    assert.doesNotThrow(check);
    evidence.quote = "4444";
    assert.doesNotThrow(check);
    evidence.quote = '"数量[20240220]": 5555';
    assert.throws(check, /quote 不是/);
    evidence.message_index = 2;
    evidence.quote = "4444";
    assert.throws(check, /quote 不是/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid evidence indices identify every candidate, field and valid message range", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config), result = pairResult();
    result.evaluations.A.findings[0].evidence[0].message_index = 10;
    result.evaluations.B.findings[0].evidence[0].message_index = 20;
    assert.throws(() => validateEvaluation(plan.tasks[0], plan.inputs, result, emptyAudit(), {}), error => {
      const message = (error as Error).message;
      assert.match(message, /evaluations\.A\.findings\[0\]\.evidence\[0\]/);
      assert.match(message, /evaluations\.B\.findings\[0\]\.evidence\[0\]/);
      assert.match(message, /0–1/);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both_good requires evidence for every core requirement and resolves serious contradictions", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  try {
    const plan = await buildPlan(config), task = plan.tasks[0];
    const check = (result: unknown) => validateEvaluation(task, plan.inputs, result, emptyAudit(), {});
    check(pairResult());
    assert.throws(() => check({ ...pairResult(), verdict: { result: "tie", reason: "差不多" } }), /输出结构无效/);
    const uncovered = pairResult();
    uncovered.task_analysis.requirements.push("解释计算过程");
    assert.throws(() => check(uncovered), /核心要求 1/);
    const trivial = pairResult();
    trivial.evaluations.B.findings[0].importance = "low";
    assert.throws(() => check(trivial), /B 对核心要求/);
    const oneSided = pairResult();
    oneSided.decision_basis.decisive_findings.pop();
    assert.throws(() => check(oneSided), /双方发现/);
    for (const evidence_status of ["established", "uncertain"] as const) {
      const contradicted = pairResult();
      const problem = structuredClone(contradicted.evaluations.B.findings[0]);
      problem.type = "problem";
      problem.assessment.evidence_status = evidence_status;
      contradicted.evaluations.B.findings.push(problem);
      assert.throws(() => check(contradicted), /严重问题矛盾/);
    }
    const withFlaw = pairResult();
    const problem = structuredClone(withFlaw.evaluations.B.findings[0]);
    problem.type = "problem";
    problem.importance = "medium";
    withFlaw.evaluations.B.findings.push(problem);
    assert.throws(() => check(withFlaw), /counterevidence 缺少 B:1/);
    withFlaw.decision_basis.counterevidence.push({ candidate: "B", finding_index: 1 });
    withFlaw.decision_basis.tradeoff = "该问题不阻断核心交付，双方可用性相同。";
    check(withFlaw);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("both_bad requires confirmed serious failures on each side and accounts for strengths", async () => {
  const input = raw("q", null, "2+2=5");
  const { directory, config } = await fixtureConfig([[input], [], [input], []]);
  try {
    const plan = await buildPlan(config), task = plan.tasks[0];
    const check = (result: PairwiseResult) => validateEvaluation(task, plan.inputs, result, emptyAudit(), {});
    check(badResult());
    for (const candidate of ["A", "B"]) {
      for (const importance of ["low", "medium"] as const) {
        const minor = badResult();
        minor.evaluations[candidate].findings[0].importance = importance;
        assert.throws(() => check(minor), /严重问题引用/);
      }
      const uncertain = badResult();
      uncertain.evaluations[candidate].findings[0].assessment.evidence_status = "uncertain";
      assert.throws(() => check(uncertain), /不确定/);
      const missing = badResult();
      missing.evaluations[candidate].findings[0].type = "strength";
      assert.throws(() => check(missing), /严重问题引用/);
      const withStrength = badResult();
      const strength = structuredClone(withStrength.evaluations[candidate].findings[0]);
      strength.type = "strength";
      withStrength.evaluations[candidate].findings.push(strength);
      assert.throws(() => check(withStrength), /counterevidence 缺少/);
      withStrength.decision_basis.counterevidence.push({ candidate, finding_index: 1 });
      check(withStrength);
    }
    const insufficient = badResult();
    insufficient.verdict = { result: "not_comparable", reason: "缺少完成判断所需的材料。" };
    insufficient.decision_basis.decisive_findings = [];
    for (const review of Object.values(insufficient.evaluations))
      review.findings[0].assessment.evidence_status = "uncertain";
    check(insufficient);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("absolute judgments cannot contradict or omit independent correctness receipts", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config), task = plan.tasks.find((t) => t.stage === "pairwise")!;
    const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [
      label, receipt(id, { is_correct: true, correctness_reason: "2+2=4。", evidence: [{ message_index: 1, quote: "2+2=4" }] }),
    ]));
    const check = (result: PairwiseResult) => validateEvaluation(task, plan.inputs, result, emptyAudit(), dependencies);
    check(pairResult());
    for (const is_correct of [false, null]) {
      dependencies.B.evaluation = { is_correct, correctness_reason: "未确认正确。", evidence: [] };
      assert.throws(() => check(pairResult()), /独立正确性为 true/);
    }
    delete dependencies.B;
    assert.throws(() => check(pairResult()), /缺少有效的独立正确性收据/);
    dependencies.B = receipt(task.dependencies.A, { is_correct: true });
    assert.throws(() => check(pairResult()), /缺少有效的独立正确性收据/);
    dependencies.B = receipt(task.dependencies.B, { is_correct: true });
    const bad = pairResult();
    bad.verdict.result = "both_bad";
    for (const review of Object.values(bad.evaluations)) review.findings[0].type = "problem";
    assert.throws(() => check(bad), /与独立正确性收据矛盾/);
    for (const review of Object.values(bad.evaluations)) review.findings[0].dimension = "instruction_following";
    check(bad); // A correct answer can still fail another core requirement.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const reverse of [false, true])
  test(`all verdicts export and aggregate without ties across A/B swaps (${reverse})`, async () => {
    const cases = ["good", "bad", "a_win", "aa_win", "unknown", "failed"];
    const rows = cases.map((id) => raw(id, null, id === "bad" ? "2+2=5" : "2+2=4"));
    rows[0].request_time = "2026-09-24 11:37:31";
    const { directory, config } = await fixtureConfig([rows, [], rows, []]);
    try {
      const plan = await buildPlan(config);
      const names = { a_fast: "A组Fast", aa_fast: "AA组Fast" };
      const validateOutput = new Ajv2020({ strict: false }).compile(outputSchema);
      const states: RunManifest["states"] = {};
      const receipts: Record<string, SubmissionReceipt> = {};
      for (const task of plan.tasks) {
        const data = task.data as TaskData;
        if (reverse) {
          [data.candidates.A, data.candidates.B] = [data.candidates.B, data.candidates.A];
          [task.inputIds.A, task.inputIds.B] = [task.inputIds.B, task.inputIds.A];
        }
        const id = data.candidates.A.case_id;
        states[task.id] = { status: id === "failed" ? "failed" : "succeeded", attempts: 0 };
        if (id === "failed") continue;
        const result = id === "bad" ? badResult() : pairResult();
        if (id.endsWith("_win")) {
          const version = id === "a_win" ? "a_fast" : "aa_fast";
          const winner = data.candidates.A.version === version ? "A" : "B";
          result.verdict.result = winner === "A" ? "A_better" : "B_better";
          result.decision_basis.counterevidence = [{ candidate: winner === "A" ? "B" : "A", finding_index: 0 }];
        } else if (id === "unknown") {
          result.verdict = { result: "not_comparable", reason: "关键材料不足。" };
          result.decision_basis.decisive_findings = [];
        }
        validateEvaluation(task, plan.inputs, result, emptyAudit(), {});
        const row = comparisonRow(plan.inputs, task, result, new Map(), names);
        if (id !== "unknown") {
          assert(validateOutput(row), JSON.stringify(validateOutput.errors));
          assert.equal(row.schema_version, "3.6");
          if (id === "good" || id === "bad") {
            assert.deepEqual(row.verdict, {
              result: id === "good" ? "both_good" : "both_bad", winner_version: null, winner_name: null,
              reason: result.verdict.reason,
            });
            const verdict = row.verdict as object;
            assert(!validateOutput({ ...row, verdict: { ...verdict, winner_version: "a_fast" } }));
            assert(!validateOutput({ ...row, verdict: { ...verdict, result: "tie" } }));
          }
        }
        receipts[task.id] = receipt(task.id, result);
      }
      const manifest: RunManifest = {
        format: "dual-agent-eval/6", debug: true, runId: "verdicts", status: "finished",
        engine: fakeIdentity, config, tasks: plan.tasks, inputs: {}, states, preflight: plan.summary, startedAt: 0, finishedAt: 1000,
      };
      await writeRunState(directory, { manifest, receipts, usage: emptyUsage(), recordedAttempts: 0 });
      await writeJson(path.join(directory, "_internal", "output_schema.json"), outputSchema);
      await writeInputs(directory, plan.inputs);
      const summary = await reportRun(directory, { details: true });
      assert.equal(summary.completed_comparisons, 4);
      const stats = (summary.pairs as Record<string, Record<string, unknown>>).a_fast__vs__aa_fast;
      assert.deepEqual(stats.wins, { a_fast: 1, aa_fast: 1 });
      assert.equal(stats.both_good, 1);
      assert.equal(stats.both_bad, 1);
      assert(!Object.hasOwn(stats, "ties"));
      assert.deepEqual(summary.task_statuses, { succeeded: 4, not_comparable: 1, failed: 1 });
      const summaries = [];
      for await (const row of readJsonl(path.join(directory, "_internal/exports/task_summaries.jsonl"))) summaries.push(row);
      assert.equal(summaries.length, 5);
      const exports = new Map<string, string>();
      for (const name of ["results/a_fast__vs__aa_fast.jsonl", "results/not_comparable.jsonl", "_internal/exports/task_summaries.jsonl"]) {
        const text = await readFile(path.join(directory, name), "utf8");
        exports.set(name, text);
        for (const line of text.trim().split("\n")) {
          const row = JSON.parse(line);
          assert.deepEqual(Object.keys(row).slice(0, 2), ["request_time", "has_standard_answer"]);
          assert.equal(row.request_time, row.case.case_id === "good" ? rows[0].request_time : null);
          assert.equal(row.has_standard_answer, false);
        }
      }
      const markdown = await readFile(path.join(directory, "task_summaries.md"), "utf8");
      assert(markdown.includes("结论（都好）"));
      assert(markdown.includes("结论（都差）"));
      assert.equal((await validateRun(directory)).valid, true);
      assert.deepEqual(await reportRun(directory, { details: true }), summary);
      for (const [name, text] of exports)
        assert.equal(await readFile(path.join(directory, name), "utf8"), text);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test("host rejects both_good against incorrect dependencies before committing a repaired both_bad receipt", async () => {
  const input = raw("q", "4", "2+2=5");
  const { directory, config } = await fixtureConfig([[input], [], [input], []]);
  let rejected = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          if ("is_correct" in (options.spec.evaluation.outputSchema.properties as object)) {
            await options.execute("submit_evaluation", draftFor(options.spec, {
              is_correct: false, correctness_reason: "2+2应为4，回答5错误。",
              evidence: [{ message_index: 1, quote: "2+2=5" }],
            }));
          } else {
            const invalid = await options.execute("submit_evaluation", draftFor(options.spec, pairResult({ A: "2+2=5", B: "2+2=5" })));
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid), /独立正确性为 true/);
            rejected++;
            const accepted = await options.execute("submit_evaluation", draftFor(options.spec, badResult()));
            assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
            assert.equal(accepted.terminate, true);
          }
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config), { correctness, pairwise, ...common } = config.judge;
    const summary = await runEvaluation({
      runId: "repair", outputDir: config.outputDir,
      engine: "pi", identity: fakeIdentity, config, pack: pairwisePack, plan, policy: config.execution,
      modelForStage: (stage) => ({ ...common, ...(stage === "correctness" ? correctness : pairwise) }) as ModelConfig,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url],
    });
    assert.equal(rejected, 1);
    assert.equal(summary.completed_comparisons, 1);
    const stats = (summary.pairs as Record<string, Record<string, unknown>>).a_fast__vs__aa_fast;
    assert.equal(stats.both_good, 0);
    assert.equal(stats.both_bad, 1);
    assert.equal((await validateRun(path.join(config.outputDir, "repair"))).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
