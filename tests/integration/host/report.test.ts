import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { writeJson } from "@eval/data";
import { adapt } from "@eval/workflows/comparison";
import { comparisonWorkflow } from "@eval/workflows/comparison";
import { comparisonProfile } from "@eval/agents/comparison";
import { outputSchema } from "@eval/workflows/comparison";
import { validateEvaluation } from "../../fixtures/services.js";
import { comparisonRow, reportRun } from "@eval/workflows/comparison";
import type { ComparisonResult, TaskData } from "@eval/workflows/comparison";
import { validateRun } from "../../fixtures/services.js";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeJudge, fixtureConfig, criteriaResultForTask, criteriaTaskFor, raw } from "../../fixtures/comparison.js";

for (const objective of [false, true])
  test(`report preserves identities, evidence and correctness across blind swaps (${objective ? "objective" : "subjective"})`, async () => {
    const { directory, config } = await fixtureConfig();
    const validateOutput = new Ajv2020({ strict: false }).compile(outputSchema);
    try {
      for (const reverse of [false, true]) {
        const labels = reverse ? { A: "b_fast", B: "a_fast" } : { A: "a_fast", B: "b_fast" };
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
              meta: { ground_truth: reference, finish_answer_time_cost: version === "a_fast" ? 8000 : 40000,
                usage: { input_tokens: version === "a_fast" ? 100 : 1000, output_tokens: 20 } },
            },
          ]),
        );
        const candidates = Object.fromEntries(
          Object.entries(inputs).map(([label, input]) => [
            label,
            adapt(
              input,
              { ...config.inputs.versions.find((version) => version.id === labels[label as "A" | "B"])!,
                adapter: "a", sources: [{ kind: "file", path: "fixture.jsonl" }] },
              "fixture.jsonl",
              1,
            ),
          ]),
        );
        const data: TaskData = {
          stage: "comparison",
          candidates,
          reference,
          group: ["a_fast", "b_fast"],
          comparisonId: "cmp-fixture",
        };
        const task: PlannedTask = {
          id: "comparison",
          stage: "comparison",
          dependencies: { criteria: "criteria", A: "check-A", B: "check-B" },
          inputIds: Object.fromEntries(Object.entries(candidates).map(([label, c]) => [label, c.input_id])),
          data,
        };
        const snapshots = Object.fromEntries(
          Object.entries(candidates).map(([label, c]) => [c.input_id, inputs[label]]),
        );
        const rubric = criteriaResultForTask(task, snapshots);
        const receipts = new Map<string, SubmissionReceipt>([["criteria", {
          taskId: "criteria", submissionId: "criteria", attemptId: "test", evaluation: rubric,
          evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(),
          status: "succeeded", acceptedAt: 0,
        }]]);
        for (const label of ["A", "B"]) {
          const candidate = candidates[label]!;
          receipts.set("check-" + label, {
            submissionId: "check-" + label,
            taskId: "check-" + label,
            attemptId: "test",
            evaluation: {
              ...attributionResult(candidate.version === "a_fast", candidate.version === "a_fast" ? "2+2=4" : "2+2=5", objective, candidate.input_id),
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
        const bFast = labelOf.get("b_fast")!;
        const result: ComparisonResult = {
          status: "decided", review_requests: [],
          task_analysis: structuredClone(receipts.get("criteria")!.evaluation) as ComparisonResult["task_analysis"],
          ranking: [[aFast], [bFast]],
          assessments: {
            [aFast]: { meets_core: true, core_failure_refs: [], summary: `候选${aFast}与候选${bFast}相比，候选${aFast}更完整。` },
            [bFast]: {
              meets_core: false, core_failure_refs: ["r1"],
              summary: `候选${bFast}结果错误。`,
            },
          },
          decision_basis: {
            tradeoff: "候选B的优点不能抵消候选A的优势。",
            comparisons: [{ aspect: "计算结果", criterion_ids: ["r1"], importance: "high", better_candidates: [aFast], assessments: {
              [aFast]: { status: "met", evidence_status: "established", summary: `候选${aFast}给出正确结果。`, finding_indices: [0] },
              [bFast]: { status: "unmet", evidence_status: "established", summary: `候选${bFast}结果错误。`, finding_indices: [0] },
            } }],
            decisive_findings: [
              { candidate: aFast, finding_index: 0 },
              { candidate: bFast, finding_index: 0 },
            ],
          },
        };
        const dependencies = Object.fromEntries(
          Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]),
        );
        validateEvaluation(task, snapshots, result, emptyAudit(), dependencies);
        const binding = comparisonWorkflow.bind(task, snapshots, dependencies, { tasks: [criteriaTaskFor(task), task] });
        const validateRequest = new Ajv2020({ strict: false }).compile(comparisonProfile.requestSchema!);
        assert(validateRequest(binding.request.input), JSON.stringify(validateRequest.errors));
        const materials = (binding.request.input as { candidates: Record<string, { original_answer_usage: { total_tokens: number }; original_answer_timing: { finish_seconds: number } }> }).candidates;
        assert.equal(materials[aFast]!.original_answer_usage.total_tokens, 120);
        assert.equal(materials[bFast]!.original_answer_usage.total_tokens, 1020);
        assert.equal(materials[aFast]!.original_answer_timing.finish_seconds, 8);
        assert.deepEqual(Object.keys(materials[aFast]!.original_answer_timing), ["finish_seconds"]);
        const row = comparisonRow(snapshots, task, result, receipts, {
          a_fast: "A组Fast",
          b_fast: "B组Fast",
        }, fakeEvaluatorVersion);
        assert(validateOutput(row), JSON.stringify(validateOutput.errors));
        const aligned = (row.decision_basis as ComparisonResult["decision_basis"]).comparisons[0];
        assert.deepEqual(aligned.better_candidates, ["a_fast"]);
        assert.equal(aligned.assessments.a_fast.summary, "A组Fast给出正确结果。");
        assert.deepEqual(aligned.assessments.b_fast.finding_indices, [0]);
        assert.deepEqual(Object.keys(row).slice(0, 2), ["request_time", "has_standard_answer"]);
        assert.equal(row.request_time, "2026-09-24 11:37:31");
        assert.equal(row.has_standard_answer, objective);
        assert.deepEqual(row.task_analysis, rubric);
        assert.equal(row.criteria_task_id, "criteria");
        assert.deepEqual(row.attribution_task_ids, Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [candidate.version, "check-" + label])));
        assert.deepEqual((row.verdicts as Record<string, { result: string; winner_version: string }>)["a_fast__vs__b_fast"], {
          result: "win",
          winner_version: "a_fast",
          winner_name: "A组Fast",
          reason: "A组Fast完成核心要求而B组Fast未完成。",
        });
        const reviews = row.evaluations as Record<string, { is_correct: boolean | null; correctness_reason: string }>;
        assert.equal(reviews.a_fast!.is_correct, objective ? true : null);
        assert.equal(reviews.b_fast!.is_correct, objective ? false : null);
        const displayA = labels[aFast as "A" | "B"] === "a_fast" ? "A组Fast" : "B组Fast";
        const displayB = displayA === "A组Fast" ? "B组Fast" : "A组Fast";
        assert.equal(
          (row.assessments as Record<string, { summary: string }>).a_fast!.summary,
          `${displayA}与${displayB}相比，${displayA}更完整。`,
        );
        const fullNarrative = structuredClone(result);
        fullNarrative.decision_basis.tradeoff = `候选${aFast}正确完成核心计算，候选${bFast}结果错误。`.repeat(6);
        validateEvaluation(task, snapshots, fullNarrative, emptyAudit(), dependencies);
        const expanded = comparisonRow(snapshots, task, fullNarrative, receipts, {
          a_fast: "A组Fast", b_fast: "B组Fast",
        }, fakeEvaluatorVersion);
        assert(validateOutput(expanded), JSON.stringify(validateOutput.errors));
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

test("debug report requires the run's own schema snapshot", async () => {
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
