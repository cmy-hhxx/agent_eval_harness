import test from "node:test";
import assert from "node:assert/strict";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { investigationValidator } from "./investigation.js";
import type { AttributionExecutionNode, AttributionTransition } from "./transitions.js";

test("one validation pass verifies its source directory once across problem checks", () => {
  const f = businessChainFixture();
  const answer = f.binding.request.input.answer as { transitions: AttributionTransition[]; execution_nodes: AttributionExecutionNode[] };
  const nodes = answer.execution_nodes;
  let directoryReads = 0;
  Object.defineProperty(answer, "execution_nodes", { configurable: true, get() { directoryReads++; return nodes; } });
  const validate = investigationValidator(f.binding.request);
  assert.equal(directoryReads, 0, "a no-problem pass does not rebuild a directory");
  const first = validate(f.problem, f.evidence, f.audit, "/problems/0");
  for (let index = 1; index < 4; index++) {
    const issues = validate(structuredClone(f.problem), f.evidence, f.audit, `/problems/${index}`);
    assert.deepEqual(issues.map(issue => issue.code), first.map(issue => issue.code));
  }
  assert.equal(directoryReads, 1, "the expensive directory reconstruction belongs to the pass, not each problem");
});

test("a new validation pass rechecks modified source directories and rejects forged ownership", () => {
  const f = businessChainFixture();
  const check = () => investigationValidator(f.binding.request)(f.problem, f.evidence, f.audit, "/problem");
  assert(!check().some(issue => issue.code === "transition_directory"));
  f.generated.actor_index = 999999;
  assert(check().some(issue => issue.code === "transition_directory"), "no acceptance is cached between passes or runs");
});
