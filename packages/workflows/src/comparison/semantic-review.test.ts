import { isTraceAttributionTask } from "@eval/workflows/attribution";
import { compactReceipt } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { traceAttributionProfile } from "@eval/agents/attribution";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import type { TaskData } from "./types.js";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";

test("explicit semantic questions target one business case equally without becoming raw input or a verdict", async () => {
  const rows = [raw("checked"), raw("untouched")];
  const fixture = await fixtureConfig([rows, [], rows, []]);
  const questions = ["核对原要求的时间限制与最终操作步骤是否一致，不预设是否违反。"];
  fixture.config.reviewQuestions = [{ batch_id: "b1", case_id: "checked", questions }];
  try {
    const plan = await buildPlan(fixture.config);
    const targets = plan.tasks.filter(task => isTraceAttributionTask(task));
    assert.equal(targets.length, 4);
    for (const task of targets) {
      const data = task.data as TaskData;
      const selected = data.candidates.A.case_id === "checked";
      assert.deepEqual(data.reviewQuestions, selected ? questions : undefined);
      const binding = bindTask(task, plan.inputs, { compact: compactReceipt() }, { tasks: plan.tasks });
      assert.equal(binding.request.input.review_context, undefined, "workflow notes do not alter evidence validation input");
      const material = binding.modelInput!;
      assert.deepEqual(material.review_context, selected ? { reasons: questions, kind: "unverified_concerns" } : undefined);
      assert.equal(traceAttributionProfile.renderPrompt!(material).includes(questions[0]), selected);
      assert(!JSON.stringify(binding.request.sources).includes(questions[0]), "audit questions must never alter the original evidence");
      assert.equal(data.reviewOf, undefined, "a fresh semantic evaluation does not pretend to reuse an accepted source result");
    }
    fixture.config.reviewQuestions = [{ batch_id: "other-batch", case_id: "checked", questions }];
    const unmatched = await buildPlan(fixture.config);
    assert((unmatched.summary.issues as { reason: string }[]).some(issue => issue.reason === "review_case_unavailable"));
    assert(unmatched.tasks.filter(task => isTraceAttributionTask(task)).every(task => !(task.data as TaskData).reviewQuestions));
    fixture.config.comparisons = [];
    const maintenance = await buildPlan(fixture.config);
    assert(!(maintenance.summary.issues as { reason: string }[]).some(issue => issue.reason === "review_case_unavailable"),
      "post-processing without comparison work must not invent an unavailable semantic review");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
