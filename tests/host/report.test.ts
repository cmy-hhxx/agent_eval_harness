import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "../../packages/contracts/src/index.js";
import { writeJson } from "../../packages/contracts/src/io.js";
import { adapt } from "../../packages/pairwise-eval/src/input.js";
import { outputSchema, validateEvaluation } from "../../packages/pairwise-eval/src/index.js";
import { comparisonRow, reportRun } from "../../packages/pairwise-eval/src/report.js";
import type { CorrectnessResult, Review, TaskData } from "../../packages/pairwise-eval/src/types.js";
import { validateRun } from "../../apps/host/src/validate.js";
import { emptyAudit, fixtureConfig, pairResult, raw } from "./fixtures.js";

for (const objective of [false, true])
  test(`report preserves identities, evidence and correctness across A/B swaps (${objective ? "objective" : "subjective"})`, async () => {
    const { directory } = await fixtureConfig();
    const validateOutput = new Ajv2020({ strict: false }).compile(outputSchema);
    let comparisonId: unknown;
    try {
      for (const reverse of [false, true]) {
        const versions = reverse ? ["aa_fast", "a_fast"] : ["a_fast", "aa_fast"];
        const reference = objective ? "4" : null;
        const inputs = Object.fromEntries(
          versions.map((version, i) => [
            i === 0 ? "A" : "B",
            {
              ...raw("q1", reference, version === "a_fast" ? "2+2=4（【候选A】、候选B、B的问题小于A为原文）" : "2+2=5"),
              request_time: version === "a_fast" ? "2026-09-24 11:37:31" : "2026-09-24 11:37:29",
              has_standard_answer: objective,
            },
          ]),
        );
        const candidates = Object.fromEntries(
          Object.entries(inputs).map(([label, input], i) => [
            label,
            adapt(input, { id: versions[i], name: versions[i], adapter: "a", path: "fixture.jsonl" }, "fixture.jsonl", 1),
          ]),
        );
        const data: TaskData = { stage: "pairwise", candidates, reference, pair: ["a_fast", "aa_fast"] };
        const task: PlannedTask = {
          id: "comparison",
          stage: "pairwise",
          dependencies: objective ? { A: "check-A", B: "check-B" } : {},
          inputIds: Object.fromEntries(Object.entries(candidates).map(([label, c]) => [label, c.input_id])),
          data,
        };
        const receipts = new Map<string, SubmissionReceipt>();
        for (const [label, candidate] of Object.entries(candidates)) {
          if (objective)
            receipts.set("check-" + label, {
              submissionId: "check-" + label,
              taskId: "check-" + label,
              attemptId: "test",
              evaluation: {
                is_correct: candidate.version === "a_fast",
                correctness_reason: candidate.version === "a_fast" ? "候选A结果是4。" : "【候选A】结果应为4。",
                evidence: [{ message_index: 1, quote: String(inputs[label].messages[1].content) }],
              },
              audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", acceptedAt: 0,
            });
        }
        const result = pairResult(Object.fromEntries(
          Object.entries(inputs).map(([label, input]) => [label, String(input.messages[1].content)]),
        ));
        const winner = reverse ? "B" : "A", loser = reverse ? "A" : "B";
        result.verdict = { result: reverse ? "B_better" : "A_better", reason: "【候选A】与【候选B】存在结果差异。B的问题小于A的缺陷。" };
        result.evaluations[winner].summary = "候选A与候选 B相比，A更完整，B更快。A股、B股、A+H、A浪、AI、EBITDA、方案A、中枢A/B、A/B/C均为题目术语。";
        result.evaluations[loser].summary = "加法结果错误。";
        result.evaluations[loser].findings[0].type = "problem";
        result.evaluations[winner].findings[0].reason = "相较B，A更完整。";
        result.evaluations[winner].findings[0].assessment.impact = "B的问题小于A的缺陷。";
        result.task_analysis.scoring_points = ["比较A与B的交付质量。"];
        result.task_analysis.timing_analysis = "A与B的耗时相同。";
        result.decision_basis.tradeoff = "B的优点不能抵消A的优势。";
        const snapshots = Object.fromEntries(Object.entries(candidates).map(([label, c]) => [c.input_id, inputs[label]]));
        const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]));
        validateEvaluation(task, snapshots, result, emptyAudit(), dependencies);
        const row = comparisonRow(snapshots, task, result, receipts, { a_fast: "A组Fast", aa_fast: "AA组Fast" });
        assert(validateOutput(row), JSON.stringify(validateOutput.errors));
        assert.deepEqual(Object.keys(row).slice(0, 2), ["request_time", "has_standard_answer"]);
        assert.equal(row.request_time, "2026-09-24 11:37:31");
        assert.equal(row.has_standard_answer, objective);
        for (const key of ["request_time", "has_standard_answer"]) {
          const missing = { ...row };
          delete missing[key];
          assert.equal(validateOutput(missing), false);
        }
        assert.equal(validateOutput({ ...row, request_time: 0 }), false);
        assert.equal(validateOutput({ ...row, has_standard_answer: "false" }), false);
        if (comparisonId !== undefined) assert.equal(row.comparison_id, comparisonId);
        comparisonId = row.comparison_id;
        assert.deepEqual(row.case, { batch_id: "b1", case_id: "q1" });
        assert.deepEqual(row.verdict, {
          result: "win", winner_version: "a_fast", winner_name: "A组Fast",
          reason: reverse ? "AA组Fast与A组Fast存在结果差异。A组Fast的问题小于AA组Fast的缺陷。" : "A组Fast与AA组Fast存在结果差异。AA组Fast的问题小于A组Fast的缺陷。",
        });
        const reviews = row.evaluations as Record<string, Review & CorrectnessResult>;
        assert.equal(reviews.a_fast.is_correct, objective ? true : null);
        assert.equal(reviews.aa_fast.is_correct, objective ? false : null);
        assert.equal(reviews.a_fast.correctness_reason, objective ? "A组Fast结果是4。" : "");
        assert.equal(reviews.aa_fast.correctness_reason, objective ? "AA组Fast结果应为4。" : "");
        const labelA = reverse ? "AA组Fast" : "A组Fast", labelB = reverse ? "A组Fast" : "AA组Fast";
        assert.equal(reviews.a_fast.summary, `${labelA}与${labelB}相比，${labelA}更完整，${labelB}更快。A股、B股、A+H、A浪、AI、EBITDA、方案A、中枢A/B、A/B/C均为题目术语。`);
        assert.equal(reviews.a_fast.findings[0].reason, `相较${labelB}，${labelA}更完整。`);
        assert.equal(reviews.a_fast.findings[0].assessment.impact, `${labelB}的问题小于${labelA}的缺陷。`);
        assert.deepEqual((row.task_analysis as { scoring_points: string[] }).scoring_points, [`比较${labelA}与${labelB}的交付质量。`]);
        assert.equal((row.task_analysis as { timing_analysis: string }).timing_analysis, `${labelA}与${labelB}的耗时相同。`);
        assert.deepEqual(reviews.a_fast.findings[0].evidence, result.evaluations[winner].findings[0].evidence);
        assert.deepEqual(row.decision_basis, {
          tradeoff: `${labelB}的优点不能抵消${labelA}的优势。`,
          decisive_findings: versions.map((candidate) => ({ candidate, finding_index: 0 })),
          counterevidence: [],
        });
        const changed = structuredClone(snapshots);
        changed[candidates[winner].input_id].messages[1].content = "被改写的回答";
        assert.throws(() => validateEvaluation(task, changed, result, emptyAudit(), dependencies), /原文/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("report and validate reject unsupported run formats without a compatibility path", async () => {
  const { directory } = await fixtureConfig();
  try {
    for (const manifest of [{}, { format: "unsupported" }, { format: "dual-agent-eval/1" }]) {
      await writeJson(path.join(directory, "state.json"), manifest);
      await assert.rejects(reportRun(directory), /不支持此运行格式/);
      await assert.rejects(validateRun(directory), /不支持此运行格式/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report requires the run's own schema snapshot", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    await writeJson(path.join(directory, "state.json"), {
      format: "dual-agent-eval/6", debug: true, config, inputs: {}, preflight: {}, tasks: {}, usage: {}, recordedAttempts: 0,
    });
    await assert.rejects(reportRun(directory), /ENOENT.*output_schema\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
