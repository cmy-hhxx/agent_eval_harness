import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { writeJson } from "@eval/data";
import { adapt } from "@eval/workflows/comparison";
import { outputSchema } from "@eval/workflows/comparison";
import { validateEvaluation } from "../../fixtures/services.js";
import { comparisonRow, reportRun } from "@eval/workflows/comparison";
import type { ComparisonResult, TaskData } from "@eval/workflows/comparison";
import { validateRun } from "../../fixtures/services.js";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeJudge, fixtureConfig, raw } from "../../fixtures/comparison.js";

for (const objective of [false, true])
  test(`report preserves identities, evidence and correctness across blind swaps (${objective ? "objective" : "subjective"})`, async () => {
    const { directory } = await fixtureConfig();
    const validateOutput = new Ajv2020({ strict: false }).compile(outputSchema);
    try {
      for (const reverse of [false, true]) {
        const labels = reverse ? { A: "aa_fast", B: "a_fast" } : { A: "a_fast", B: "aa_fast" };
        const reference = objective ? "4" : null;
        const inputs = Object.fromEntries(
          Object.entries(labels).map(([label, version]) => [
            label,
            {
              ...raw(
                "q1",
                reference,
                version === "a_fast" ? "2+2=4（【候选A】、候选B 为原文）" : "2+2=5",
              ),
              request_time: version === "a_fast" ? "2026-09-24 11:37:31" : "2026-09-24 11:37:29",
              has_standard_answer: objective,
            },
          ]),
        );
        const candidates = Object.fromEntries(
          Object.entries(inputs).map(([label, input]) => [
            label,
            adapt(
              input,
              { id: labels[label as "A" | "B"], name: labels[label as "A" | "B"], adapter: "a", sources: [{ kind: "file", path: "fixture.jsonl" }] },
              "fixture.jsonl",
              1,
            ),
          ]),
        );
        const data: TaskData = {
          stage: "comparison",
          candidates,
          reference,
          group: ["a_fast", "aa_fast"],
          comparisonId: "cmp-fixture",
        };
        const task: PlannedTask = {
          id: "comparison",
          stage: "comparison",
          dependencies: { A: "check-A", B: "check-B" },
          inputIds: Object.fromEntries(Object.entries(candidates).map(([label, c]) => [label, c.input_id])),
          data,
        };
        const receipts = new Map<string, SubmissionReceipt>();
        for (const label of ["A", "B"]) {
          const candidate = candidates[label]!;
          receipts.set("check-" + label, {
            submissionId: "check-" + label,
            taskId: "check-" + label,
            attemptId: "test",
            evaluation: {
              ...attributionResult(candidate.version === "a_fast", candidate.version === "a_fast" ? "2+2=4" : "2+2=5", objective),
              correctness_reason: objective
                ? candidate.version === "a_fast"
                  ? "候选A结果是4。"
                  : "【候选A】结果应为4。"
                : "",
            },
            evaluatorVersion: fakeEvaluatorVersion,
            judge: fakeJudge,
            audit: emptyAudit(),
            usage: emptyUsage(),
            status: "succeeded",
            acceptedAt: 0,
          });
        }
        const labelOf = new Map(Object.entries(candidates).map(([label, c]) => [c.version, label]));
        const aFast = labelOf.get("a_fast")!;
        const aaFast = labelOf.get("aa_fast")!;
        const result: ComparisonResult = {
          task_analysis: {
            task_type: "整数加法",
            goal: "计算2+2",
            requirements: ["给出正确的加法结果"],
            scoring_points: ["比较候选A与候选B的交付质量。"],
            red_flags: ["擅自替换操作数"],
          },
          ranking: [[aFast], [aaFast]],
          assessments: {
            [aFast]: { meets_core: true, summary: `候选${aFast}与候选${aaFast}相比，候选${aFast}更完整。` },
            [aaFast]: {
              meets_core: !objective,
              summary: `候选${aaFast}结果错误。`,
            },
          },
          decision_basis: {
            tradeoff: "候选B的优点不能抵消候选A的优势。",
            decisive_findings: [
              { candidate: aFast, finding_index: 0 },
              { candidate: aaFast, finding_index: 0 },
            ],
          },
        };
        const snapshots = Object.fromEntries(
          Object.entries(candidates).map(([label, c]) => [c.input_id, inputs[label]]),
        );
        const dependencies = Object.fromEntries(
          Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]),
        );
        validateEvaluation(task, snapshots, result, emptyAudit(), dependencies);
        const row = comparisonRow(snapshots, task, result, receipts, {
          a_fast: "A组Fast",
          aa_fast: "AA组Fast",
        }, fakeEvaluatorVersion);
        assert(validateOutput(row), JSON.stringify(validateOutput.errors));
        assert.deepEqual(Object.keys(row).slice(0, 2), ["request_time", "has_standard_answer"]);
        assert.equal(row.request_time, "2026-09-24 11:37:31");
        assert.equal(row.has_standard_answer, objective);
        assert.deepEqual((row.verdicts as Record<string, { result: string; winner_version: string }>)["a_fast__vs__aa_fast"], {
          result: "win",
          winner_version: "a_fast",
          winner_name: "A组Fast",
          reason: objective
            ? "A组Fast完成核心要求而AA组Fast未完成。"
            : "双方都完成核心要求，A组Fast实际可用性更优。",
        });
        const reviews = row.evaluations as Record<string, { is_correct: boolean | null; correctness_reason: string }>;
        assert.equal(reviews.a_fast!.is_correct, objective ? true : null);
        assert.equal(reviews.aa_fast!.is_correct, objective ? false : null);
        const displayA = labels[aFast as "A" | "B"] === "a_fast" ? "A组Fast" : "AA组Fast";
        const displayB = displayA === "A组Fast" ? "AA组Fast" : "A组Fast";
        assert.equal(
          (row.assessments as Record<string, { summary: string }>).a_fast!.summary,
          `${displayA}与${displayB}相比，${displayA}更完整。`,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("report and validate reject unsupported run formats without a compatibility path", async () => {
  const { directory } = await fixtureConfig();
  try {
    for (const manifest of [{}, { format: "unsupported" }]) {
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
      format: "evaluation-run",
      debug: true,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      inputs: {},
      preflight: {},
      tasks: {},
      usage: {},
      recordedAttempts: 0,
    });
    await assert.rejects(reportRun(directory), /ENOENT.*output_schema\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
