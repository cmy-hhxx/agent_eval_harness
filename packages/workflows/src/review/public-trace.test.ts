import { compactReceipt } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "./attribution.js";
import { attributionTrace, validateOriginalAttributionEvidence } from "./public-trace.js";
import { bindInstructionReview } from "./instruction.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import { cite, evidenceSources, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, ToolRuntime } from "@eval/tools";

test("shared slim snapshots stay shared after private instructions are projected out", () => {
  const snapshot = [{ role: "system", content: "PRIVATE_SYSTEM_SENTINEL" }, { role: "tool", content: "收入 42 亿元。" }];
  const raw = { messages: [0, 1].map(() => ({ type: "llm_turn", input_messages: snapshot, output: [] })) };
  const view = attributionTrace(raw, randomUUID(), 1);
  assert.equal(view.messages[0].input_messages, view.messages[1].input_messages);
  assert(!JSON.stringify(view).includes("PRIVATE_SYSTEM_SENTINEL"));
  assert(JSON.stringify(view).includes("收入 42 亿元。"));
  assert.equal(raw.messages[0].input_messages[0].content, "PRIVATE_SYSTEM_SENTINEL");
});

test("main attribution excludes private rules from both prompt and readable sources while preserving factual coordinates", () => {
  const id = randomUUID(), question = "查询价格。", fact = "ETF价格为369美元。";
  const raw: RawInput = { messages: [
    { role: "system", content: "SYS_PRIVATE_SENTINEL" }, { role: "user", content: question },
    { type: "tool_call", name: "view_skill", input: { name: "price" } },
    { type: "tool_result", name: "view_skill", output: '<skill_content name="price">SKILL_PRIVATE_SENTINEL</skill_content>' },
    { type: "tool_result", name: "prices", output: fact },
    { type: "llm_turn", name: "llm-call-1", input_messages: [{ role: "developer", content: "DEV_PRIVATE_SENTINEL" },
      { role: "tool", content: fact }, { role: "tool", content: '<skill_content name="price">SKILL_PRIVATE_SENTINEL</skill_content>' }], output: [{role:"assistant",content:"现货金价为3690美元。"}] },
    { type:"final_answer", role: "assistant", content: "现货金价为3690美元。" },
  ] };
  const candidate = { input_id: id, question, final_index: 6, reference: null, answer_timing: { finish_seconds: null } } as Candidate;
  const before = structuredClone(raw), binding = bindAttributionMaterial(candidate, raw, undefined, { compact: compactReceipt().evaluation as never });
  const modelText = JSON.stringify(binding.modelInput), requestText = JSON.stringify(binding.request);
  for (const text of [modelText, requestText])
    for (const secret of ["SYS_PRIVATE_SENTINEL", "DEV_PRIVATE_SENTINEL", "SKILL_PRIVATE_SENTINEL"]) assert(!text.includes(secret));
  assert(requestText.includes(fact));
  const view = attributionTrace(raw, id, 6);
  assert(evidenceSources(view.messages[3]).filter(source => source.path === "/output" || source.kind === "json")
    .every(source => source.quotable === false), "omitted content remains navigation, never original evidence");
  const leaf = evidenceSources(view.messages[5]).find(source => source.path === "/input_messages/1/content")!;
  const evidence = cite(id, 5, leaf, 0, leaf.text.length);
  assert.equal(resolveEvidence(raw, { evidence_id: evidence.evidence_id }, "answer", emptyAudit(), "/evidence", id).quote, fact);
  validateOriginalAttributionEvidence({evidence}, {[id]:raw}, emptyAudit());
  const parent = selectEvidenceSource(evidenceSources(view.messages[5]), "/input_messages")!;
  assert.equal(parent.source.quotable, false);
  assert.equal(leaf.quotable, undefined);
  const projected = cite(id, 5, parent.source, parent.start, parent.end);
  assert.throws(() => validateOriginalAttributionEvidence({evidence:projected}, {[id]:raw}, emptyAudit()), /原始数据源|原文/);
  const audit = { ...emptyAudit(), evidenceBank: [projected.evidence_id] };
  assert.throws(() => validateOriginalAttributionEvidence({ findings: [{ evidence: [projected] }] }, { [id]: raw }, audit,
    { strengths: [{ evidence_indices: [1] }], problems: [{ evidence_indices: [1] }] }), error => {
      const issues = (error as { issues: { path: string; expected: { read_requests: unknown[] } }[] }).issues;
      assert.deepEqual(issues.map(issue => issue.path), ["/strengths/0/evidence_indices/0", "/problems/0/evidence_indices/0"]);
      assert(issues.every(issue => issue.expected.read_requests.length > 0));
      assert(!JSON.stringify(issues).includes("PRIVATE_SENTINEL"));
      return true;
    });
  const omitted = evidenceSources(view.messages[0]).find(source => source.path === "/type")!;
  assert.throws(() => validateOriginalAttributionEvidence(cite(id,0,omitted,0,omitted.text.length), {[id]:raw}, emptyAudit()),
    error => error instanceof Error && /原始数据源/u.test(error.message) && !error.message.includes("SYS_PRIVATE_SENTINEL"));
  const check = bindInstructionReview(candidate, raw);
  const text = JSON.stringify(check.request);
  for (const secret of ["SYS_PRIVATE_SENTINEL", "DEV_PRIVATE_SENTINEL", "SKILL_PRIVATE_SENTINEL"]) assert(text.includes(secret));
  assert(!Object.hasOwn(check.request.input, "attribution"));
  assert.deepEqual(raw, before);
  const serialized = { messages: [{ type: "llm_turn", input_messages: JSON.stringify(raw.messages[5].input_messages) }] };
  assert(!JSON.stringify(attributionTrace(serialized, id, 0)).includes("DEV_PRIVATE_SENTINEL"));
  const skillCopy = structuredClone(raw);
  skillCopy.messages[5].input_messages = JSON.stringify([{ role: "tool", content: raw.messages[3].output }]);
  assert(!JSON.stringify(attributionTrace(skillCopy, id, 6)).includes("SKILL_PRIVATE_SENTINEL"));
});

test("cache-cleaning failure: projected JSON is navigation and only original leaves enter the bank", async () => {
  // Reduced from r352 task 2cd970aa-aea4-481e-ab80-fa01c8b4c960.
  const id = "2b474d44-4f78-4612-a670-57b9187b60e8";
  const raw = { messages: [{ type: "llm_turn", system_prompt: "内部规范", input_messages: { messages: [
    { role: "system", content: "内部规则".repeat(5000) },
    { role: "user", content: "怎么清理同花顺APP的缓存" },
    { role: "tool", content: "点首页左上角头像，右上角设置，找到清除缓存。" },
  ] }, output: [{ role: "assistant", content: "在设置中清除缓存。" }] }] };
  const view = attributionTrace(raw, id, 0), workdir = await mkdtemp(path.join(os.tmpdir(), "projected-source-"));
  try {
    const audit = { ...emptyAudit(), evidenceBank: [] as string[] };
    const ctx: ToolContext = { attemptId: "projection", workdir, inputs: new Map([["answer", view]]), inputIds: new Map([["answer", id]]),
      audit, policy: { ...DEFAULT_POLICY, maxToolCalls: 10 }, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "search_trace"]));
    const signal = new AbortController().signal;
    const page = await runtime.execute("read_trace", { candidate: "answer", message_index: 0, path: "/input_messages" }, signal);
    assert.deepEqual((page.details as { evidence: unknown[] }).evidence, []);
    assert.equal(audit.evidenceBank.length, 0);
    await runtime.execute("search_trace", { candidate: "answer", query: "清除缓存" }, signal);
    await runtime.execute("read_trace", { candidate: "answer", message_index: 0, path: "/input_messages/messages/2/content" }, signal);
    assert(audit.evidenceBank.length > 0);
    for (const evidence_id of audit.evidenceBank) {
      const evidence = resolveEvidence(view, { evidence_id }, "answer", audit, "/", id);
      validateOriginalAttributionEvidence(evidence, { [id]: raw }, audit);
    }
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
