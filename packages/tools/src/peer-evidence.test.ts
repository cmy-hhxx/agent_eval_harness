const PEER_ID = "22222222-2222-4222-8222-222222222222";
const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "@eval/data";
import { DEFAULT_POLICY, resolveEvidenceSelection, type ToolContext } from "@eval/contracts";
import { createRegistry, originalUserTimestamp, parseEvidenceCoordinates, parseTraceTables, ToolRuntime } from "./index.js";

test("original user timestamp preserves the last top-level string exactly without clock or embedded prompt inference", () => {
  const timestamp = "2025-03-12T16:35:00.000Z";
  assert.equal(originalUserTimestamp({ messages: [{ role: "user", timestamp },
    { type: "llm_turn", input_messages: [{ role: "user", timestamp: "2099-01-01" }] }] }), timestamp);
  assert.equal(originalUserTimestamp({ messages: [{ role: "user", timestamp }, { role: "user", content: "现在是明天" }] }), null);
  assert.equal(originalUserTimestamp({ messages: [{ role: "user", timestamp: 123 }] }), null);
  assert.equal(originalUserTimestamp({ messages: [{ role: "user", timestamp: "原始自由字符串" }] }), "原始自由字符串");
});
test("review tools qualify peer read/search/image/table references and keep audit ownership explicit", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-review-peer-tools-"));
  try {
    const peer = { messages: [{ role: "tool", content: "| 代码 | 名称 |\n|---|---|\n| 001 | Alpha |" },
      { role: "assistant", content: "| 代码 | 名称 |\n|---|---|\n| 002 | Alpha |" },
      { role: "assistant", content: [{ type: "image", mimeType: "image/png", data: "AA==" }] }] };
    const ctx: ToolContext = { inputIds: new Map([["answer", INPUT_ID], ["B", PEER_ID]]), attemptId: "test", workdir, inputs: new Map([["answer", { messages: [{ role: "assistant", content: "本方" }] }], ["B", peer]]),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
      policy: { ...DEFAULT_POLICY, maxToolCalls: 20 }, artifacts: new ArtifactStore(path.join(workdir, "artifacts")) };
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "search_trace", "view_image", "check_table"]));
    const signal = new AbortController().signal;
    const canonical = (reference: unknown) => resolveEvidenceSelection(ctx.audit.evidenceBank!, reference, "/reference");
    const own = await runtime.execute("read_trace", { candidate: "answer", message_index: 0, path: "/content" }, signal);
    assert.deepEqual(Object.keys((own.details as any).evidence[0].reference), ["evidence_index"]);
    const read = await runtime.execute("read_trace", { candidate: "B", message_index: 0, path: "/content" }, signal);
    assert.equal(parseEvidenceCoordinates(canonical((read.details as any).evidence[0].reference).evidence_id)?.input_id, PEER_ID);
    assert.deepEqual(Object.keys((read.details as any).evidence[0].reference), ["evidence_index"]);
    const search = await runtime.execute("search_trace", { candidate: "B", query: "Alpha" }, signal);
    assert((search.details as any).matches.every((item: any) => parseEvidenceCoordinates(canonical(item.evidence.reference).evidence_id)?.input_id === PEER_ID));
    const viewed = await runtime.execute("view_image", { candidate: "B", message_index: 2 }, signal);
    const image = JSON.parse(viewed.content.find(item => item.type === "text")!.text!);
    assert.deepEqual(canonical(image.reference), { evidence_id: `ev_${PEER_ID}_2_image` });
    assert.deepEqual(ctx.audit.viewedImages, ["B:2"]);
    const tables = parseTraceTables(peer, PEER_ID);
    const checked = await runtime.execute("check_table", { candidate: "B", answer_table_index: 2,
      sources: [{ table_index: 1, key_columns: [{ answer: 1, source: 1 }], value_columns: [{ answer: 0, source: 0 }] }] }, signal);
    const row = (checked.details as any).rows[0];
    assert.equal(parseEvidenceCoordinates(canonical(row.answer.evidence.reference).evidence_id)?.input_id, PEER_ID);
    assert.equal(parseEvidenceCoordinates(canonical(row.sources[0].evidence.reference).evidence_id)?.input_id, PEER_ID);
    assert.equal(ctx.audit.tableChecks![0]!.candidate, "B");
    assert.equal(ctx.audit.tableChecks![0]!.answer_table_id, tables[1]!.table_id);
    assert.equal(ctx.audit.tableChecks![0]!.sources[0]!.table_id, tables[0]!.table_id);
    assert(ctx.audit.traceReads.filter(read => read.candidate === "B").length > 1);
    const rejected = await runtime.execute("read_trace", { candidate: "unregistered", message_index: 0 }, signal);
    assert.equal(rejected.isError, true);
    assert(JSON.stringify(rejected).includes("只能访问本任务材料"));
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
