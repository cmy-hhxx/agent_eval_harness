import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, presentSource, resolveEvidenceSelection, type ToolContext, type SourcePresentation } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, resolveEvidence, ToolRuntime } from "./index.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

const inputId = "296439d0-d228-45fc-8c5e-35f42990547e";
const presentation: SourcePresentation = { redactions: [{ text: "Model-A", replacement: "匿名候选一" }], omitMessageKeys: ["model", "provider"] };

test("source display rules preserve coordinates and binary bytes while omitting message provenance", () => {
  const image = "data:image/png;base64,Model-A";
  const raw = { messages: [{ role: "assistant", model: "Model-A", content: "Model-A 的结果", image }],
    reference: { evidence_id: "Model-A", evidence_index: 1 }, read_request: { path: "/Model-A", offset: 12, max_chars: 40 }, total_chars: 40 };
  const original = structuredClone(raw), shown = presentSource(raw, presentation);
  assert.equal(shown.messages[0].content, "匿名候选一 的结果");
  assert.equal(Object.hasOwn(shown.messages[0], "model"), false);
  assert.equal(shown.messages[0].image, image);
  assert.deepEqual(shown.reference, raw.reference); assert.deepEqual(shown.read_request, raw.read_request);
  assert.equal(shown.total_chars, 40); assert.deepEqual(raw, original);
});

test("blind tool display after raw pagination keeps numeric selection tied to original longer text", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "evidence-blind-origin-"));
  const text = "Model-A：原始回答。", raw = { messages: [{ role: "assistant", model: "Model-A", content: text }] };
  const original = structuredClone(raw);
  const context: ToolContext = { attemptId: "blind-tool", workdir, inputs: new Map([["A", raw]]), inputIds: new Map([["A", inputId]]),
    sourcePresentations: new Map([["A", presentation]]), audit: emptyAudit(),
    policy: { ...DEFAULT_POLICY, maxToolCalls: 2 }, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
  try {
    const runtime = new ToolRuntime(context, createRegistry().select(["read_trace"]));
    const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content", offset: 0, max_chars: text.length }, new AbortController().signal);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const shown = result.details as { total_chars: number; evidence: { reference: { evidence_index: number }; quote: string }[] };
    assert.equal(shown.evidence[0].quote, "匿名候选一：原始回答。");
    assert.equal(shown.total_chars, text.length);
    assert.notEqual(shown.evidence[0].quote.length, text.length);
    const selected = resolveEvidenceSelection(context.audit.evidenceBank!, shown.evidence[0].reference, "/reference");
    assert.equal(resolveEvidence(raw, selected, "A", context.audit, "/evidence", inputId).quote, text);
    assert.deepEqual(raw, original); assert.equal(context.audit.traceReads[0].end, text.length);
    const cached = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content", offset: 0, max_chars: text.length }, new AbortController().signal);
    const { budget: _firstBudget, ...firstPage } = result.details as Record<string, unknown>;
    const { budget: _cachedBudget, ...cachedPage } = cached.details as Record<string, unknown>;
    assert.deepEqual(cachedPage, firstPage, "cached pages retain their original numeric selection and display");
  } finally { await rm(workdir, { recursive: true, force: true }); }
});


test("complete serialized message pages omit unlisted provenance and keep original selection", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "evidence-blind-json-origin-"));
  const raw = { messages: [{ role: "assistant", model: "unlisted-provider-model", content: "Model-A：原始回答。" }] };
  const before = structuredClone(raw);
  const context: ToolContext = { attemptId: "blind-json", workdir, inputs: new Map([["A", raw]]), inputIds: new Map([["A", inputId]]),
    sourcePresentations: new Map([["A", presentation]]), audit: emptyAudit(),
    policy: DEFAULT_POLICY, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
  try {
    const runtime = new ToolRuntime(context, createRegistry().select(["read_trace"]));
    const reply = await runtime.execute("read_trace", { candidate: "A", message_index: 0 }, new AbortController().signal);
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    assert(!JSON.stringify(reply).includes("unlisted-provider-model"));
    const shown = reply.details as { evidence: { reference: { evidence_index: number } }[] };
    const reference = resolveEvidenceSelection(context.audit.evidenceBank!, shown.evidence[0].reference, "/evidence");
    assert.equal(resolveEvidence(raw, reference, "A", context.audit, "/evidence", inputId).quote, JSON.stringify(raw.messages[0], null, 2));
    assert.deepEqual(raw, before);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
