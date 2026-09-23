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
            raw("q1", reference, version === "a_fast" ? "2+2=4（【候选A】为原文）" : "2+2=5"),
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
          inputIds: Object.fromEntries(Object.entries(candidates).map(([label, c]) => [label, c.input_hash])),
          data,
        };
        const receipts = new Map<string, SubmissionReceipt>();
        for (const [label, candidate] of Object.entries(candidates)) {
          await writeJson(path.join(directory, "inputs", candidate.input_hash + ".json"), inputs[label]);
          if (objective)
            receipts.set("check-" + label, {
              submissionId: "check-" + label,
              taskId: "check-" + label,
              attemptId: "test",
              evaluation: {
                is_correct: candidate.version === "a_fast",
                correctness_reason: candidate.version === "a_fast" ? "结果是4。" : "结果应为4。",
                evidence: [{ message_index: 1, quote: String(inputs[label].messages[1].content) }],
              },
              audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", cached: false, acceptedAt: 0,
            });
        }
        const result = pairResult(Object.fromEntries(
          Object.entries(inputs).map(([label, input]) => [label, String(input.messages[1].content)]),
        ));
        const winner = reverse ? "B" : "A", loser = reverse ? "A" : "B";
        result.verdict = { result: reverse ? "B_better" : "A_better", reason: "【候选A】与【候选B】存在结果差异。" };
        result.evaluations[loser].summary = "加法结果错误。";
        result.evaluations[loser].findings[0].type = "problem";
        const snapshots = Object.fromEntries(Object.entries(candidates).map(([label, c]) => [c.input_hash, inputs[label]]));
        validateEvaluation(task, snapshots, result, emptyAudit());
        const row = await comparisonRow(directory, task, result, receipts, { a_fast: "A组Fast", aa_fast: "AA组Fast" });
        assert(validateOutput(row), JSON.stringify(validateOutput.errors));
        if (comparisonId !== undefined) assert.equal(row.comparison_id, comparisonId);
        comparisonId = row.comparison_id;
        assert.deepEqual(row.case, { batch_id: "b1", case_id: "q1" });
        assert.deepEqual(row.verdict, {
          result: "win", winner_version: "a_fast", winner_name: "A组Fast",
          reason: reverse ? "AA组Fast与A组Fast存在结果差异。" : "A组Fast与AA组Fast存在结果差异。",
        });
        const reviews = row.evaluations as Record<string, Review & CorrectnessResult>;
        assert.equal(reviews.a_fast.is_correct, objective ? true : null);
        assert.equal(reviews.aa_fast.is_correct, objective ? false : null);
        assert.equal(reviews.a_fast.correctness_reason, objective ? "结果是4。" : "");
        assert.equal(reviews.aa_fast.correctness_reason, objective ? "结果应为4。" : "");
        assert.deepEqual(reviews.a_fast.findings[0].evidence, result.evaluations[winner].findings[0].evidence);
        assert.deepEqual(row.decision_basis, {
          tradeoff: result.decision_basis.tradeoff,
          decisive_findings: versions.map((candidate) => ({ candidate, finding_index: 0 })),
          counterevidence: [],
        });
        const changed = structuredClone(snapshots);
        changed[candidates[winner].input_hash].messages[1].content = "被改写的回答";
        assert.throws(() => validateEvaluation(task, changed, result, emptyAudit()), /原文/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("report and validate reject unsupported run formats without a compatibility path", async () => {
  const { directory } = await fixtureConfig();
  try {
    for (const manifest of [{}, { format: "unsupported" }]) {
      await writeJson(path.join(directory, "manifest.json"), manifest);
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
    await writeJson(path.join(directory, "manifest.json"), {
      format: "dual-agent-eval/1", config, inputs: {}, tasks: [], states: {},
    });
    await assert.rejects(reportRun(directory), /ENOENT.*output_schema\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
