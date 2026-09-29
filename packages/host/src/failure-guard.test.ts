import test from "node:test";
import assert from "node:assert/strict";
import { FailureGuard } from "./failure-guard.js";
import type { StagePause, ValidationIssue } from "@eval/contracts";

const issue = (path: string): ValidationIssue => ({ category: "structure", code: "rewrite_context_prefix", path, message: "wrong subject" });
test("stage circuit counts distinct tasks and normalizes array coordinates", () => {
  const pauses: StagePause[] = [], guard = new FailureGuard(pauses, { windowSize: 4, threshold: 2 });
  guard.observe("rewrite", "a", [issue("/rewrites/0/text")]);
  assert.equal(guard.observe("rewrite", "a", [issue("/rewrites/1/text"), issue("/rewrites/2/text")]), undefined);
  assert.equal(guard.observe("comparison", "b", [issue("/rewrites/3/text")]), undefined);
  const pause = guard.observe("rewrite", "b", [issue("/rewrites/20/text")], 42);
  assert.deepEqual(pause, { stage: "rewrite", category: "structure", code: "rewrite_context_prefix",
    path: "/rewrites/*/text", taskIds: ["a", "b"], at: 42 });
  assert.equal(guard.paused("comparison"), false);
  const restarted = new FailureGuard(structuredClone(pauses));
  assert.equal(restarted.paused("rewrite"), true);
});
test("successes evict failures from a bounded window and unrelated paths do not combine", () => {
  const guard = new FailureGuard([], { windowSize: 2, threshold: 2 });
  guard.observe("rewrite", "a", [issue("/rewrites/0/text")]);
  guard.observe("rewrite", "b", []);
  assert.equal(guard.observe("rewrite", "c", [issue("/rewrites/1/text")]), undefined);
  assert.equal(guard.observe("rewrite", "d", [issue("/rewrites/1/id")]), undefined);
  assert.equal(guard.observe("rewrite", "d", []), undefined);
  assert.equal(guard.observe("rewrite", "e", [issue("/rewrites/5/id")]), undefined);
  for (const policy of [{ windowSize: 5, threshold: 1 }, { windowSize: 2, threshold: 3 }, { windowSize: 2.5, threshold: 2 }])
    assert.throws(() => new FailureGuard([], policy), /windowSize/);
});
