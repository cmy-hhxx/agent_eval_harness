import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest, ValidationIssue } from "@eval/contracts";
import { findingIssueContext } from "./finding-feedback.js";

const request: AgentRequest = { input: {}, sources: {} };
const issue = (path: string): ValidationIssue => ({ category: "evidence", code: "evidence_id_invalid",
  path, message: "Use the real source reference.", expected: { normative_sources: ["original"] } });

test("finding feedback retains the exact error path and identifies both public evidence path forms", () => {
  const draft = { findings: Array.from({ length: 6 }, (_, index) => ({ finding_id: `id-${index}`, text: `text-${index}` })) };
  const before = structuredClone(draft);
  for (const path of ["/findings/5/evidence/0", "findings[5].evidence[0]"])
    assert.deepEqual(findingIssueContext(request, draft, issue(path)), { target: { finding_index: 5, index_base: 0,
      path, finding_id: "id-5", text: "text-5" } });
  assert.deepEqual(draft, before);
});

test("finding feedback does not guess missing IDs or classify unrelated, malformed or nonexistent paths", () => {
  const draft = { findings: [null, { finding_id: 8, text: { value: "bad" } }, {}] };
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/1/text")),
    { target: { finding_index: 1, index_base: 0, path: "/findings/1/text" } });
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/0")),
    { target: { finding_index: 0, index_base: 0, path: "/findings/0" } });
  for (const path of ["/findings", "/findings/3/evidence", "/findings/01/text", "/findings/-1/text",
    "/findings/9007199254740992/text", "/criterion_assessments/1/evidence", "other.findings[1].evidence"])
    assert.equal(findingIssueContext(request, draft, issue(path)), undefined);
  assert.equal(findingIssueContext(request, null, issue("/findings/0")), undefined);
  assert.equal(findingIssueContext(request, { findings: {} }, issue("/findings/0")), undefined);
});

test("finding feedback bounds only the display text and preserves Unicode and the original stable ID", () => {
  const long = "📌".repeat(161), draft = { findings: [{ finding_id: "id/with~raw punctuation", text: long }] };
  assert.deepEqual(findingIssueContext(request, draft, issue("/findings/0/reason")), { target: {
    finding_index: 0, index_base: 0, path: "/findings/0/reason", finding_id: "id/with~raw punctuation",
    text: "📌".repeat(160) + "…",
  } });
  assert.equal(draft.findings[0]!.text, long);
});
