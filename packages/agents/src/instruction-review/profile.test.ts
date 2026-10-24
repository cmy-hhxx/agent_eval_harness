import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest, ReviewCase, ToolAudit } from "@eval/contracts";
import { validateInstructionReview, type InstructionReview } from "./index.js";

function fixture() {
  const rule = { evidence_id: "rule", source_id: "N001", start: 0, end: 6, quote: "先核验再交付" };
  const behavior = { evidence_id: "behavior", source_id: "A", start: 0, end: 4, quote: "尚未核验" };
  const material = { evidence: { N001: rule.quote, A: behavior.quote } } as unknown as ReviewCase;
  const request: AgentRequest = { input: { norm_catalog: [{ source_id: "N001" }] }, sources: { case: { id: "case", value: material } } };
  const audit = { review: { quotes: [rule, behavior], sources: [], actions: [], viewed: [], searches: [] } } as unknown as ToolAudit;
  const value: InstructionReview = { summary: "未遵守核验要求。", checks: [{ rule: rule.quote, status: "violated", reason: "实际交付确认尚未核验。",
    rule_evidence_ids: [rule.evidence_id], behavior_evidence_ids: [behavior.evidence_id] }], evidence: [rule, behavior] };
  return { request, audit, value };
}

test("instruction review requires independent rule and behavior proof from its own quote ledger", () => {
  const f = fixture();
  validateInstructionReview(f.request, f.value, f.audit);
  const unsupported = structuredClone(f.value);
  unsupported.checks[0].behavior_evidence_ids = ["rule"];
  assert.throws(() => validateInstructionReview(f.request, unsupported, f.audit), /行为证据/);
  const invented = structuredClone(f.value);
  invented.evidence[1].quote = "已经核验";
  assert.throws(() => validateInstructionReview(f.request, invented, f.audit), /准确来自/);
  assert.throws(() => validateInstructionReview(f.request, f.value, { ...f.audit, review: undefined }), /本次取证账本/);
});

test("missing behavior remains unverified; it cannot silently pass or assert an exception", () => {
  const f = fixture();
  f.value.checks[0].status = "unverified";
  f.value.checks[0].behavior_evidence_ids = [];
  f.value.checks[0].reason = "未采集执行行为。";
  validateInstructionReview(f.request, f.value, f.audit);
  for (const status of ["met", "violated", "not_applicable"] as const) {
    f.value.checks[0].status = status;
    assert.throws(() => validateInstructionReview(f.request, f.value, f.audit), /实际行为/);
  }
});
