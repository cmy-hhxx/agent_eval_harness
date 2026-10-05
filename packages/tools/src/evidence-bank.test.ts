import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_POLICY, resolveEvidenceSelection, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, resolveEvidence, ToolRuntime } from "./index.js";
const id = "11111111-1111-4111-8111-111111111111";
test("read and search expose only committed task-local choices and preserve the bank on cached reads", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "evidence-selection-tool-"));
  try {
    const raw = { messages: [{ content: "六只股票，510630.SH，脚注 ref_6" }] };
    const ctx: ToolContext = { attemptId: "test", workdir, inputs: new Map([["A", raw]]), inputIds: new Map([["A", id]]),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 10 }, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "search_trace"]));
    const page = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal);
    const displayed = page.details as { evidence: { reference: { evidence_index: number }; quote: string }[] };
    assert.deepEqual(displayed.evidence[0].reference, { evidence_index: 1 });
    assert.equal(ctx.audit.evidenceBank!.length, 1); // Pagination probes never allocate invisible choices.
    assert.equal(resolveEvidence(raw, resolveEvidenceSelection(ctx.audit.evidenceBank!, displayed.evidence[0].reference, "/proof"), "A", ctx.audit, "/proof", id).quote,
      "六只股票，510630.SH，脚注 ref_6");
    const snapshot = [...ctx.audit.evidenceBank!];
    await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal);
    assert.deepEqual(ctx.audit.evidenceBank, snapshot);
    const searched = await runtime.execute("search_trace", { candidate: "A", query: "510630.SH" }, new AbortController().signal);
    assert(!searched.content[0].text!.includes("ev_"));
    assert(searched.content[0].text!.includes("510630.SH"));
    assert.deepEqual(ctx.audit.evidenceBank!.slice(0, snapshot.length), snapshot);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

test("read_trace preserves JSON business evidence fields while selecting only its generated proof envelope", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "evidence-business-fields-"));
  try {
    const business = { evidence_id: "business-id", source_input_id: "business-source", nested: { evidence_id: "ev_原始编号" } };
    const raw = { messages: [{ role: "tool", output: business }] }, before = structuredClone(raw);
    const ctx: ToolContext = { attemptId: "test", workdir, inputs: new Map([["A", raw]]), inputIds: new Map([["A", id]]),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 10 }, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const result = await new ToolRuntime(ctx, createRegistry().select(["read_trace"]))
      .execute("read_trace", { candidate: "A", message_index: 0, path: "/output" }, new AbortController().signal);
    const page = result.details as { evidence: { quote: string; reference: { evidence_index: number } }[] };
    assert.equal(page.evidence.length, 1);
    assert.deepEqual(JSON.parse("{" + page.evidence[0]!.quote + "}").output, business);
    assert.deepEqual(Object.keys(page.evidence[0]!.reference), ["evidence_index"]);
    assert.equal(ctx.audit.evidenceBank!.length, 1);
    assert.deepEqual(raw, before);
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
