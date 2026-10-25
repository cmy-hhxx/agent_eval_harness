import test from "node:test";
import assert from "node:assert/strict";
import { businessChainFixture } from "../../../../tests/fixtures/business-chain.js";
import { businessChainDirectoryIssues, investigationValidator } from "./investigation.js";
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

test("directory validation renders each source message once despite repeated checkpoint references", () => {
  const f = businessChainFixture();
  const raw = f.binding.request.sources.answer.value as { messages: unknown[] };
  const point = f.chain.checkpoints.find(point => point.evidence.length)!;
  const evidence = point.evidence[0]!;
  const message = raw.messages[evidence.message_index];
  let reads = 0;
  Object.defineProperty(raw.messages, evidence.message_index, { configurable: true, get() { reads++; return message; } });
  assert.deepEqual(businessChainDirectoryIssues(f.binding.request), []);
  const firstReads = reads;
  assert(firstReads > 0);
  point.evidence.push(...Array.from({ length: 40 }, () => structuredClone(evidence)));
  reads = 0;
  assert.deepEqual(businessChainDirectoryIssues(f.binding.request), []);
  assert.equal(reads, firstReads, "extra references must not rerender the same message");
  point.evidence.at(-1)!.quote = "伪造原文";
  assert(businessChainDirectoryIssues(f.binding.request).some(issue => issue.code === "business_chain_directory"),
    "each new validation rechecks all quotes against real source content");
});
