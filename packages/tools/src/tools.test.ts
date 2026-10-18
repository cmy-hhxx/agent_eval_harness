const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DEFAULT_POLICY, resolveEvidenceSelection, type ToolContext } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { ROOT } from "../../../tests/fixtures/services.js";
import { createRegistry, executeCode, resolveEvidence, traceReadCoverage, ToolRuntime } from "@eval/tools";
import { emptyAudit, raw } from "../../../tests/fixtures/comparison.js";

async function context() {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "eval-tools-"));
  const ctx: ToolContext = {
    inputIds: new Map([["A", INPUT_ID]]), attemptId: "test",
    workdir,
    inputs: new Map([["A", raw()]]),
    audit: emptyAudit(),
    policy: { ...DEFAULT_POLICY, maxToolCalls: 3 },
    artifacts: new ArtifactStore(path.join(workdir, "artifacts")),
  };
  return ctx;
}
test("JSON drafting retains earlier rows and exact literals through investigation and closing", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 4;
    ctx.draftWriteInCallLimit = true;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["edit_json"]));
    runtime.reserveDraftWrite();
    const call = (args: object) => runtime.execute("edit_json", { path: "draft.json", ...args }, new AbortController().signal);
    const first = { text: "范围尚未标明", reason: "2032-06-04，原值 -37.20%", evidence_indices: [2, 5] };
    await call({ set_json: JSON.stringify({ review_notes: ["解释是否成立：待核期间"], problems: [first] }) });
    await call({ append_json: JSON.stringify({ problems: [{ text: "已恢复的过程错误", evidence_indices: [8] }] }) });
    const before = await readFile(path.join(ctx.workdir, "draft.json"), "utf8");
    const invalid = await call({ append_json: '{"problems":true}' });
    assert.equal(invalid.isError, true);
    assert.equal(await readFile(path.join(ctx.workdir, "draft.json"), "utf8"), before);
    const closed = await call({ set_json: '{"meets_core":null}', remove_fields: ["review_notes"] });
    assert(!closed.isError);
    const saved = JSON.parse(await readFile(path.join(ctx.workdir, "draft.json"), "utf8"));
    assert.deepEqual(saved.problems, [first, { text: "已恢复的过程错误", evidence_indices: [8] }]);
    assert.equal(saved.meets_core, null);
    assert(!("review_notes" in saved));
    assert.deepEqual((closed.details as any).array_lengths, { problems: 2 });
    assert.equal(ctx.audit.calls, 4);
    assert.equal(runtime.budget().exploration.remaining + runtime.budget().draft_writes.remaining, 0);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("JSON drafting rejects paths outside the workspace without editing files", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["edit_json"]));
    for (const file of ["../outside.json", "/tmp/outside.json"])
      assert.equal((await runtime.execute("edit_json", { path: file, set_json: "{}" }, new AbortController().signal)).isError, true);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search distinguishes new source text from reused hits without inviting a redundant read", async () => {
  const ctx = await context();
  try {
    const content = "日期：2031-04-09；数量：-28；分位：6%。";
    ctx.inputs.set("A", { messages: [{ role: "tool", content }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const args = { candidate: "A", query: "数量", scope: "tool_returns" };
    const first = (await runtime.execute("search_trace", args, new AbortController().signal)).details as any;
    assert.equal(first.new_source_chars, content.length);
    assert.equal(first.matches[0].already_read, false);
    assert(!first.matches[0].read_request, "a complete source does not need a follow-up read");
    for (const query of ["数量", "分位"]) {
      const again = (await runtime.execute("search_trace", { ...args, query }, new AbortController().signal)).details as any;
      assert.equal(again.new_source_chars, 0);
      assert.equal(again.matches[0].already_read, true);
      assert(!again.matches[0].read_request);
      assert.equal(again.matches[0].evidence.quote, content, "short facts retain their exact sign, date and units");
    }
    assert.equal(ctx.audit.calls, 3, "reuse is visible but never grants free exploration calls");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("initially shown excerpts are reused without claiming unread suffixes or mandatory-read proof", async () => {
  const ctx = await context();
  try {
    const prefix = "已显示原文。".repeat(80), tail = "未显示的关键结果。";
    ctx.inputs.set("A", { messages: [{ role: "tool", content: prefix + tail }] });
    ctx.presentedReads = [{ candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: prefix.length }];
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "search_trace"]));
    const read = (max_chars: number) => runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content", max_chars }, new AbortController().signal);
    const reused = (await read(prefix.length)).details as any;
    assert.equal(reused.already_read, true);
    assert.equal(ctx.audit.traceReads.length, 0, "presentation reuse never manufactures actual tool-read proof");
    const expanded = (await read(prefix.length + tail.length)).details as any;
    assert.equal(expanded.evidence.map((e: any) => e.quote).join(""), prefix + tail);
    assert.deepEqual(ctx.audit.traceReads, [{ ...ctx.presentedReads[0], start: prefix.length, end: prefix.length + tail.length }]);
    const found = (await runtime.execute("search_trace", { candidate: "A", query: "已显示原文", message_index: 0 }, new AbortController().signal)).details as any;
    assert.equal(found.new_source_chars, 0);
    assert(found.matches.every((match: any) => match.already_read && !match.read_request));

    ctx.audit = emptyAudit();
    ctx.requiredReads = [{ ...ctx.presentedReads[0], end: prefix.length + tail.length }];
    const mandatory = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const result = (await mandatory.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal)).details as any;
    assert.equal(result.evidence[0].quote, prefix + tail);
    assert.equal(ctx.audit.requiredReadCalls, 1);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("trace search finds numeric tool fields and returns an exact structured quote", async () => {
  const ctx = await context();
  try {
    const source = {
      type: "tool_result",
      output: { datas: [{ "数量[20240220]": 4444 }] },
    };
    ctx.inputs.set("A", { messages: [source] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const result = await runtime.execute(
      "search_trace",
      { candidate: "A", query: '"数量[20240220]": 4444' },
      new AbortController().signal,
    );
    const details = result.details as {
      total: number;
      matches: { evidence: { reference: { evidence_index: number }; message_index: number; quote: string } }[];
    };
    assert.equal(details.total, 1);
    assert.equal(details.matches[0].evidence.message_index, 0);
    assert(JSON.stringify(source, null, 2).includes(details.matches[0].evidence.quote));
    assert.equal(Object.hasOwn(details.matches[0].evidence, "evidence_id"), false);
    assert.deepEqual(Object.keys(details.matches[0].evidence.reference), ["evidence_index"]);
    assert.equal(resolveEvidence({ messages: [source] }, resolveEvidenceSelection(ctx.audit.evidenceBank!, details.matches[0].evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote,
      details.matches[0].evidence.quote);
    assert.deepEqual(ctx.audit.traceReads, [{
      candidate: "A", message_index: 0, kind: "json", path: "", start: 0,
      end: JSON.stringify(source, null, 2).length,
    }]);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("tool-return search locates original values before repeated model history and opens the complete source", async () => {
  const ctx = await context();
  try {
    const source = { messages: [
      { type: "llm_turn", input_messages: { content: "成交量查询。".repeat(40) } },
      { type: "tool_result", output: { "成交量[20260929]": 10 } },
      { type: "function_call_output", output: { "成交量[20260930 14:30-20260930 15:00]": 11228580, unit: "股" } },
      { role: "tool", content: "当日成交量47588689股。" },
      { type: "llm_turn", output: "成交量1122.86万股。" },
      { role: "assistant", content: "成交量1122.86万股。" },
    ] };
    ctx.inputs.set("A", source);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace", "read_trace"]));
    const result = await runtime.execute("search_trace", { candidate: "A", query: "成交量", scope: "tool_returns" }, new AbortController().signal);
    assert(!result.isError, JSON.stringify(result));
    const page = result.details as { total: number; matches: { evidence: { message_index: number; quote: string };
      read_request: { candidate: string; message_index: number; path: string } }[] };
    assert.deepEqual([...new Set(page.matches.map(match => match.evidence.message_index))], [3, 2, 1]);
    const matched = page.matches.find(match => match.evidence.quote.includes("11228580"))!;
    assert(matched, "search the metric even when the answer rounds and changes units");
    assert.equal(matched.read_request, undefined, "the complete short structured result is already visible");
    const read = await runtime.execute("read_trace", { candidate: "A", message_index: matched.evidence.message_index }, new AbortController().signal);
    assert(!read.isError, JSON.stringify(read));
    assert((read.details as { evidence: { quote: string }[] }).evidence.some(item => item.quote.includes('"unit": "股"')));
    const all = await runtime.execute("search_trace", { candidate: "A", query: "成交量" }, new AbortController().signal);
    assert((all.details as { total: number }).total > page.total, "all-message search remains available for instructions and history");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("targeted search avoids duplicate histories and JSON mirrors while preserving real field coordinates", async () => {
  const ctx = await context();
  try {
    const source = { messages: [
      { input_messages: [{ content: "规则：最多搜索2次。" }] },
      { input_messages: [{ content: "规则：最多搜索2次。" }], output: [{ text: "4" }, { text: "AttributeError: shift" }] },
    ] };
    ctx.inputs.set("A", source);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    for (const [path, query] of [["/input_messages/0/content", "最多搜索"], ["/output/1/text", "AttributeError"]]) {
      const result = await runtime.execute("search_trace", { candidate: "A", message_index: 1, path, query }, new AbortController().signal);
      assert(!result.isError, JSON.stringify(result));
      const page = result.details as any;
      assert.equal(page.total, 1);
      assert.equal(page.matches[0].evidence.message_index, 1);
      assert.equal(page.matches[0].path, path);
      const proof = page.matches[0].evidence;
      assert.equal(resolveEvidence(source, resolveEvidenceSelection(ctx.audit.evidenceBank!, proof.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, proof.quote);
    }
    const all = await runtime.execute("search_trace", { candidate: "A", message_index: null,
      path: "/input_messages/0/content", query: "最多搜索" }, new AbortController().signal);
    assert.equal((all.details as { total: number }).total, 2, "null leaves the message scope unrestricted");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("trace paths select structured objects and scalar fields with program-generated JSON coordinates", async () => {
  const ctx = await context();
  try {
    const input = { messages: [{ output: { data: [{ code: "510630.SH", roe: 27.97773 }],
      code_count: 108, "a/b~c": { value: null }, empty: [], note: "原文🙂" } }] };
    ctx.inputs.set("A", input);
    ctx.policy.maxToolCalls = 12;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    for (const [path, quote] of [["/output/data/0", "510630.SH"], ["/output/code_count", '"code_count": 108'],
      ["/output/a~1b~0c/value", '"value": null'], ["/output/empty", '"empty": []'], ["/output/note", "原文🙂"]]) {
      const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path }, new AbortController().signal);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const page = result.details as { evidence: { reference: { evidence_index: number }; quote: string }[]; selection_path: string; has_more: boolean };
      assert.equal(page.selection_path, path);
      assert.equal(page.has_more, false);
      assert(page.evidence.some((item) => item.quote.includes(quote!)));
      for (const evidence of page.evidence) {
        assert.equal(Object.hasOwn(evidence, "evidence_id"), false);
        assert.deepEqual(Object.keys(evidence.reference), ["evidence_index"]);
        assert.equal(resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, evidence.quote);
      }
    }
    const invalid = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/output/invented" }, new AbortController().signal);
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /\/output\/note/u, "a path mistake supplies actual locations without another root read");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("structured trace pagination stays inside the selected subtree and audits original JSON offsets", async () => {
  const ctx = await context();
  try {
    const input = { messages: [{ before: "不属于证据", output: { rows: [{ value: "数值🙂".repeat(1000) }] }, after: "不属于证据" }] };
    ctx.inputs.set("A", input);
    ctx.policy.maxToolCalls = 30;
    ctx.policy.maxOutputChars = 2048;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    let offset = 0, text = "";
    for (;;) {
      const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/output/rows/0", offset }, new AbortController().signal);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const page = result.details as { evidence: { reference: { evidence_index: number }; quote: string }[]; next_offset: number; has_more: boolean };
      assert(result.content[0]!.text!.length <= ctx.policy.maxOutputChars);
      for (const evidence of page.evidence) {
        assert.equal(resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, evidence.quote);
        text += evidence.quote;
      }
      assert(page.next_offset > offset);
      offset = page.next_offset;
      if (!page.has_more) break;
    }
    assert(!text.includes("不属于证据"));
    assert.equal(JSON.parse(text).value, input.messages[0]!.output.rows[0]!.value);
    assert(ctx.audit.traceReads[0]!.start > 0);
    for (let i = 1; i < ctx.audit.traceReads.length; i++) assert.equal(ctx.audit.traceReads[i]!.start, ctx.audit.traceReads[i - 1]!.end);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("image placeholders have no evidence ID even when structured pages split the placeholder", async () => {
  const ctx = await context();
  try {
    ctx.inputs.set("A", { messages: [{ content: [{ type: "image", mimeType: "image/png", data: "AA==" }],
      "a~2b": { value: 1 } }] });
    ctx.policy.maxToolCalls = 12;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    for (const offset of [8, 18]) {
      const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content/0/data", offset, max_chars: 8 }, new AbortController().signal);
      assert.equal(result.isError, undefined);
      assert.deepEqual((result.details as { evidence: unknown[] }).evidence, []);
    }
    assert.equal((await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/a~2b" }, new AbortController().signal)).isError, true);
    assert.equal((await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/a~02b" }, new AbortController().signal)).isError, undefined);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("out-of-range evidence can be repaired from source-backed feedback without guessing offsets", () => {
  const input = { messages: Array.from({ length: 31 }, () => ({
    role: "assistant", content: [{ type: "text", text: "数".repeat(4096) }], type: "message",
  })) };
  let issue: { message: string; expected: unknown } | undefined;
  try {
    resolveEvidence(input, { evidence_id: "ev_11111111-1111-4111-8111-111111111111_30_text_0_8192_/content/0/text" }, "answer", emptyAudit(), "/findings/0/evidence/0", INPUT_ID);
    assert.fail("an invalid range must still be rejected");
  } catch (error) {
    issue = (error as { issues: { message: string; expected: unknown }[] }).issues[0];
  }
  assert.match(issue!.message, /文本长度为 4096/);
  const repair = issue!.expected as { suggested_evidence?: { reference: { evidence_id: string }; quote: string }[] };
  assert(repair.suggested_evidence?.length, "feedback must offer source-backed IDs, not require manual coordinate repair");
  for (const evidence of repair.suggested_evidence)
    assert.equal(resolveEvidence(input, evidence.reference, "answer", emptyAudit(), "/findings/0/evidence/0", INPUT_ID).quote, evidence.quote);
});
test("trace pages keep evidence intact within the output budget", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 4096;
    ctx.inputs.set("A", { messages: [{ role: "assistant", content: "长文本".repeat(4000) }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, max_chars: 16000 }, new AbortController().signal);
    assert(!result.isError);
    const text = result.content[0]!.text!;
    assert(text.length <= ctx.policy.maxOutputChars, "pagination must happen before generic result truncation");
    const page = JSON.parse(text);
    assert(page.evidence.length);
    assert(page.has_more);
    assert.deepEqual(ctx.audit.traceReads, [{
      candidate: "A", message_index: 0, kind: "json", path: "", start: 0, end: page.next_offset,
    }]);
    assert(page.next_offset < page.total_chars, "a shrunken page must not credit unseen characters");
    for (const evidence of page.evidence)
      assert.equal(resolveEvidence(ctx.inputs.get("A") as { messages: unknown[] }, resolveEvidenceSelection(ctx.audit.evidenceBank!, evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, evidence.quote);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("trace text-path pagination uses field coordinates and returns copyable evidence for every page", async () => {
  const ctx = await context();
  try {
    const text = '值"\\\n🙂'.repeat(800).slice(0, 4096);
    const input = { messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
    ctx.inputs.set("A", input);
    ctx.policy.maxOutputChars = 4096;
    ctx.policy.maxToolCalls = 30;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const target = { candidate: "A", message_index: 0, kind: "text" as const,
      path: "/content/0/text", start: 0, end: text.length };
    let offset = 0, recovered = "";
    do {
      const result = await runtime.execute("read_trace", {
        candidate: "A", message_index: 0, path: "/content/0/text", offset, max_chars: 16000,
      }, new AbortController().signal);
      assert(!result.isError, JSON.stringify(result));
      const page = JSON.parse(result.content[0]!.text!);
      assert.equal(page.total_chars, 4096);
      assert.equal(page.source.path, "/content/0/text");
      assert.equal(page.evidence.length, 1);
      const evidence = page.evidence[0];
      assert.equal(resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, text.slice(offset, page.next_offset));
      assert.deepEqual(ctx.audit.traceReads.at(-1), { ...target, start: offset, end: page.next_offset });
      recovered += evidence.quote;
      assert(page.next_offset > offset);
      offset = page.next_offset;
      if (!page.has_more) break;
    } while (offset < text.length);
    assert.equal(recovered, text);
    assert.deepEqual(traceReadCoverage(ctx.audit, target), { covered: true, missing: [] });
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search pages preserve complete evidence and paginate without skipping matches", async () => {
  const ctx = await context();
  try {
    const input = { messages: Array.from({ length: 12 }, (_, i) => ({
      role: "tool", content: `${'"\\\n'.repeat(80)}目标${i}${'"\\\n'.repeat(80)}`,
    })) };
    ctx.inputs.set("A", input);
    ctx.policy.maxOutputChars = 4096;
    ctx.policy.maxToolCalls = 30;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    let offset = 0, total = 0;
    const ids = new Set<number>();
    do {
      const result = await runtime.execute("search_trace", { candidate: "A", query: "目标", offset }, new AbortController().signal);
      assert(!result.isError);
      assert(result.content[0]!.text!.length <= ctx.policy.maxOutputChars);
      const page = JSON.parse(result.content[0]!.text!);
      total = page.total;
      assert(page.matches.length);
      assert.equal(ctx.audit.traceReads.length, offset + page.matches.length,
        "only emitted search matches count as reads, including after the output budget removes later matches");
      for (const { evidence } of page.matches) {
        assert.equal(resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, evidence.quote);
        assert(evidence.quote.includes("目标"));
        assert(!ids.has(evidence.reference.evidence_index));
        ids.add(evidence.reference.evidence_index);
      }
      assert.equal(page.next_offset, offset + page.matches.length);
      offset = page.next_offset;
      if (!page.has_more) break;
    } while (offset < total);
    assert.equal(ids.size, total);
    assert.equal(total, 12);
    assert.equal(ctx.audit.artifacts.length, 0);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("bounded context rereads retain a complete rule after fragmented exposure without gaining calls", async () => {
  const ctx = await context();
  try {
    const text = "## 交付规范\n" + "常规说明。".repeat(80) + "\n仅限实验组使用，发布时不得列为正式指标。\n";
    const source = { messages: [{ content: text }] };
    ctx.inputs.set("A", source);
    ctx.policy.maxToolCalls = 3;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"])), signal = new AbortController().signal;
    const read = async (offset: number, max_chars: number) => (await runtime.execute("read_trace", {
      candidate: "A", message_index: 0, path: "/content", offset, max_chars }, signal)).details as any;
    await read(0, 260);
    const partial = await read(220, text.length - 220);
    assert.equal(partial.evidence[0].quote, text.slice(220), "a short requested context is not split around the prior exposure");
    const full = await read(0, text.length);
    assert.equal(full.already_read, true);
    assert.equal(full.evidence[0].quote, text, "the exception beyond the first 200 characters remains visible");
    assert.equal(full.evidence[0].quote_preview, undefined);
    const ref = resolveEvidenceSelection(ctx.audit.evidenceBank!, full.evidence[0].reference, "/reference");
    assert.equal(resolveEvidence(source, ref, "A", ctx.audit, "/evidence", INPUT_ID).quote, text);
    assert.equal(ctx.audit.calls, 3);
    assert.equal(runtime.budget().exploration.remaining, 0);
    assert.deepEqual(ctx.audit.traceReads.map(({ start, end }) => [start, end]), [[0, 260], [260, text.length]]);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});

test("repeated long reads reuse evidence with a compact preview, while new ranges remain readable", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 4;
    const text = "已读的原文。".repeat(500) + "新增尾部。".repeat(300), source = { messages: [{ content: text }] };
    ctx.inputs.set("A", source);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"])), signal = new AbortController().signal;
    const read = async (offset: number, max_chars: number) => (await runtime.execute("read_trace", {
      candidate: "A", message_index: 0, path: "/content", offset, max_chars }, signal)).details as any;
    const first = await read(0, 3000), repeat = await read(0, 3000), subset = await read(500, 2000);
    assert.equal(first.evidence[0].quote, text.slice(0, 3000));
    for (const page of [repeat, subset]) {
      assert.equal(page.already_read, true);
      assert.equal(page.evidence[0].quote, undefined);
      assert.equal(page.evidence[0].quote_preview.length, 200);
      const ref = resolveEvidenceSelection(ctx.audit.evidenceBank!, page.evidence[0].reference, "/reference");
      assert.equal(resolveEvidence(source, ref, "A", ctx.audit, "/evidence", INPUT_ID).quote, text.slice(page.offset, page.next_offset));
    }
    assert.deepEqual(repeat.evidence[0].reference, first.evidence[0].reference);
    assert.equal(ctx.audit.traceReads.length, 1);
    const fresh = await read(3000, 500);
    assert.equal(fresh.already_read, undefined);
    assert.equal(fresh.evidence[0].quote, text.slice(3000, 3500));
    assert.equal(ctx.audit.traceReads.length, 2);
    assert.equal(ctx.audit.calls, 4, "repeat requests never gain extra exploration budget");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("a complete JSON read reuses its text leaf but not matching text at another path or a partial JSON string", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 7;
    const text = '条件："原值"\n'.repeat(100), input = { messages: [{ output: [{ text }, { text }] }] };
    ctx.inputs.set("A", input);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"])), signal = new AbortController().signal;
    const read = async (path: string, max_chars = 16000) => (await runtime.execute("read_trace", {
      candidate: "A", message_index: 0, path, max_chars }, signal)).details as any;
    await read("/output/0");
    const reused = await read("/output/0/text");
    assert.equal(reused.already_read, true);
    assert.equal(reused.evidence[0].quote, undefined);
    assert.equal(ctx.audit.traceReads.length, 1, "reuse does not fabricate a second actual read");
    assert.equal((await read("/output/1/text")).already_read, undefined, "equal values at distinct locations remain distinct");
    ctx.audit.traceReads = [];
    await read("/output/0", 500);
    assert.equal((await read("/output/0/text")).already_read, undefined, "partial escaped JSON is insufficient");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("expanding a read returns only missing spans with reusable references for the overlap", async () => {
  const ctx = await context();
  try {
    const text = "prefix ".repeat(100) + "middle ".repeat(100) + "suffix ".repeat(100);
    const input = { messages: [{ output: text }] };
    ctx.inputs.set("A", input);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"])), signal = new AbortController().signal;
    const read = async (offset: number, max_chars: number) => (await runtime.execute("read_trace", {
      candidate: "A", message_index: 0, path: "/output", offset, max_chars }, signal)).details as any;
    await read(700, 700);
    const expanded = await read(0, text.length);
    assert.deepEqual(expanded.evidence.map((item: any) => item.quote), [text.slice(0, 700), text.slice(1400)]);
    assert.equal(expanded.reused_evidence.length, 1);
    assert.equal(expanded.next_offset, text.length);
    for (const item of [...expanded.evidence, ...expanded.reused_evidence]) {
      const resolved = resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, item.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID);
      assert.equal(resolved.quote, item.quote ?? text.slice(700, 1400));
    }
    assert.deepEqual(ctx.audit.traceReads.map(({ start, end }) => [start, end]), [[700, 1400], [0, 700], [1400, 2100]]);
    assert(traceReadCoverage(ctx.audit, { candidate: "A", message_index: 0, kind: "text", path: "/output", start: 0, end: text.length }).covered);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("structured searches prefer real text fields over their serialized mirrors", async () => {
  const ctx = await context();
  try {
    ctx.inputs.set("A", { messages: [{ type: "tool_result", output: [{ text: "fact: target metric = 12" }, { text: "target metric = 15" }], history: "target metric" }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"])), signal = new AbortController().signal;
    const scoped = (await runtime.execute("search_trace", { candidate: "A", message_index: 0, path: "/output", query: "target metric" }, signal)).details as any;
    assert.deepEqual(scoped.matches.map((item: any) => item.path), ["/output/0/text", "/output/1/text"]);
    const all = (await runtime.execute("search_trace", { candidate: "A", scope: "tool_returns", query: "target metric" }, signal)).details as any;
    assert.equal(all.total, 3, "distinct original fields remain searchable, without the JSON mirror");
    ctx.inputs.set("A", { messages: [{ type: "tool_result", output: { text: "value 15", amount: 15 } }] });
    const mixed = (await runtime.execute("search_trace", { candidate: "A", query: "15" }, signal)).details as any;
    assert.deepEqual(mixed.matches.map((item: any) => item.path), ["/output/text", ""]);
    assert.equal(mixed.total, 2, "a text hit must not hide a distinct numeric field");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search supplies bounded source context once without requiring separate metadata reads", async () => {
  const ctx = await context();
  try {
    const input = { messages: [{ type: "tool_result", output: [{ uid: "transport-id", title: "Capacity report", date: "2026-08-12", source: "Public release",
      text: "Context: period is July.\n" + "detail ".repeat(300) + "target capacity = 90; target use = 45." }] }] };
    ctx.inputs.set("A", input);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const result = await runtime.execute("search_trace", { candidate: "A", query: "target", scope: "tool_returns" }, new AbortController().signal);
    assert(!result.isError);
    const matches = (result.details as any).matches;
    assert.equal(matches.length, 2);
    assert.deepEqual(matches[0].context.map((item: any) => item.path), ["/output/0/text", "/output/0/title", "/output/0/date", "/output/0/source"]);
    assert.equal(matches[1].context.length, 0, "one page does not repeat the same metadata for each hit");
    assert(matches[0].context.reduce((n: number, item: any) => n + item.evidence.quote.length, 0) <= 600);
    for (const item of matches[0].context) assert.equal(resolveEvidence(input,
      resolveEvidenceSelection(ctx.audit.evidenceBank!, item.evidence.reference, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote, item.evidence.quote);
    const again = await runtime.execute("search_trace", { candidate: "A", query: "capacity", scope: "tool_returns" }, new AbortController().signal);
    assert((again.details as any).matches.every((match: any) => match.context.length === 0), "already displayed metadata is not repeated");
    ctx.audit.traceReads = [];
    ctx.policy.maxOutputChars = 1300;
    const small = await runtime.execute("search_trace", { candidate: "A", query: "target use", scope: "tool_returns" }, new AbortController().signal);
    assert(!small.isError, "optional source context must not make a valid search fail under a small output allowance");
    assert((small.details as any).matches[0].evidence.quote.includes("target use"));
    assert(small.content.filter(item => item.type === "text").reduce((n, item) => n + item.text!.length, 0) <= 1300);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search follow-up reads center on the hit instead of reopening a long source prefix", async () => {
  const ctx = await context();
  try {
    const text = "unrelated prefix ".repeat(1000) + "target condition; exception: only when enabled." + " tail".repeat(500);
    ctx.inputs.set("A", { messages: [{ content: text }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace", "read_trace"])), signal = new AbortController().signal;
    const result = await runtime.execute("search_trace", { candidate: "A", query: "target", message_index: 0, path: "/content" }, signal);
    const request = (result.details as any).matches[0].read_request;
    assert(request.offset > 15000);
    assert(request.max_chars <= 1800);
    const page = (await runtime.execute("read_trace", request, signal)).details as any;
    assert((result.details as any).matches[0].evidence.quote.includes("exception: only when enabled"));
    assert.equal(page.reused_evidence, undefined, "a short context check keeps the condition together with its exception");
    assert.equal(page.evidence[0].quote, text.slice(request.offset, page.next_offset));
    assert(page.evidence[0].quote.includes("exception: only when enabled"));
    assert(page.next_offset - page.offset <= 1800);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("trace reads credit only successful returned ranges and do not repeat prior audit entries", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 8;
    ctx.inputs.set("A", { messages: [{ role: "assistant", content: "最终结果" }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const signal = new AbortController().signal;
    for (const args of [
      { candidate: "B", message_index: 0 },
      { candidate: "A", message_index: 1 },
      { candidate: "A", message_index: 0, path: "/missing" },
      { candidate: "A", message_index: 0, path: "/content", offset: 5 },
    ]) assert.equal((await runtime.execute("read_trace", args, signal)).isError, true);
    assert.deepEqual(ctx.audit.traceReads, []);
    const args = { candidate: "A", message_index: 0, path: "/content", offset: 1, max_chars: 2 };
    assert.equal((await runtime.execute("read_trace", args, signal)).isError, undefined);
    assert.deepEqual(ctx.audit.traceReads, [{
      candidate: "A", message_index: 0, kind: "text", path: "/content", start: 1, end: 3,
    }]);
    await runtime.execute("read_trace", args, signal);
    assert.equal(ctx.audit.traceReads.length, 1);
    assert.deepEqual(traceReadCoverage(ctx.audit, {
      candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: 4,
    }), { covered: false, missing: [{ start: 0, end: 1 }, { start: 3, end: 4 }] });
    ctx.policy.maxOutputChars = 1;
    assert.equal((await runtime.execute("read_trace", { ...args, offset: 0 }, signal)).isError, true);
    assert.equal(ctx.audit.traceReads.length, 1, "a rejected oversized response must not mark new characters as read");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("searching a whole trace only credits the visible hit and source context", async () => {
  const ctx = await context();
  try {
    const text = "左".repeat(500) + "关键词" + "右".repeat(500);
    ctx.inputs.set("A", { messages: [{ role: "assistant", content: text }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const result = await runtime.execute("search_trace", { candidate: "A", query: "关键词" }, new AbortController().signal);
    assert(!result.isError);
    assert.deepEqual(ctx.audit.traceReads.filter((read) => read.kind === "text"), [{
      candidate: "A", message_index: 0, kind: "text", path: "/content", start: 400, end: 703,
    }, {
      candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: 200,
    }]);
    assert.deepEqual(traceReadCoverage(ctx.audit, {
      candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: text.length,
    }), { covered: false, missing: [{ start: 200, end: 400 }, { start: 703, end: 1003 }] });
    assert.equal(ctx.audit.artifacts.length, 0);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("image viewing remains separate from text coverage and records the complete message image set", async () => {
  const ctx = await context();
  try {
    const input = { messages: [{ role: "assistant", content: [
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "image", mimeType: "image/png", data: "AQ==" },
    ] }] };
    ctx.inputs.set("A", input);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["view_image"]));
    const result = await runtime.execute("view_image", { candidate: "A", message_index: 0 }, new AbortController().signal);
    assert(!result.isError);
    assert.equal(result.content.filter((item) => item.type === "image").length, 2);
    const display = JSON.parse(result.content.find((item) => item.type === "text")!.text!);
    assert.equal(Object.hasOwn(display, "evidence_id"), false);
    assert.deepEqual(Object.keys(display.reference), ["evidence_index"]);
    assert.equal(resolveEvidence(input, resolveEvidenceSelection(ctx.audit.evidenceBank!, { ...display.reference, observation: "两张图片" }, "/reference"), "A", ctx.audit, "/evidence", INPUT_ID).quote,
      "[图像观察]两张图片");
    assert.deepEqual(ctx.audit.viewedImages, ["A:0"]);
    assert.deepEqual(ctx.audit.traceReads, []);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("registered tools are available without engine-specific changes and budgets are enforced", async () => {
  const ctx = await context();
  try {
    const registry = createRegistry([
      {
        name: "custom_count",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          return { content: [{ type: "text", text: "42" }] };
        },
      },
    ]);
    const runtime = new ToolRuntime(ctx, registry.select(["custom_count", "read_trace"]));
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await runtime.execute("custom_count", {}, new AbortController().signal)).content[0].text,
        "42",
      );
    assert.equal(
      (
        await runtime.execute(
          "read_trace",
          { candidate: "A", message_index: 1 },
          new AbortController().signal,
        )
      ).isError,
      true,
    );
    assert.equal(ctx.audit.calls, 3);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("artifact pages preserve escaped text and complete JSON without creating new artifacts", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 4096; ctx.policy.maxToolCalls = 30;
    const text = '\"\\\n🙂'.repeat(1500);
    const artifact = await ctx.artifacts.put("escaped.txt", text);
    ctx.audit.artifacts.push(artifact);
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_artifact"]));
    let offset = 0, recovered = "";
    do {
      const result = await runtime.execute("read_artifact", { id: artifact.id, offset, max_chars: 16000 }, new AbortController().signal);
      assert(!result.isError, JSON.stringify(result));
      assert(result.content.map(item => item.text ?? "").join("\n").length <= ctx.policy.maxOutputChars);
      const page = JSON.parse(result.content[0].text!);
      recovered += page.text;
      assert(page.next_offset <= text.length);
      assert(page.next_offset > offset);
      offset = page.next_offset;
      if (!page.has_more) break;
    } while (offset < text.length);
    assert.equal(recovered, text);
    assert.equal(ctx.audit.artifacts.length, 1);
    assert.equal((await runtime.execute("read_artifact", { id: artifact.id, offset: text.length + 1 }, new AbortController().signal)).isError, true);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("trace reads accept neutral directory defaults and an empty root path without losing evidence", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 10;
    ctx.inputs.set("A", { messages: [{ content: "模型实际输入" }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const read = (args: Record<string, unknown>) => runtime.execute("read_trace",
      { candidate: "A", message_index: 0, offset: 0, max_chars: 1000, ...args }, new AbortController().signal);
    const plain = await read({ path: "/content" });
    const withDefaults = await read({ path: "/content", source_offset: 0 });
    assert(!withDefaults.isError, JSON.stringify(withDefaults));
    const { already_read, ...reused } = JSON.parse(withDefaults.content[0].text!);
    assert.equal(already_read, true);
    assert.deepEqual(reused, JSON.parse(plain.content[0].text!));
    const root = await read({ path: "", source_offset: 0 });
    assert(!root.isError, JSON.stringify(root));
    assert.deepEqual(JSON.parse(root.content[0].text!).text_sources, [{ path: "/content", chars: 6 }]);
    assert.equal(ctx.audit.traceReads.length, 2);
    const conflicting = await read({ path: "/content", source_offset: 1 });
    assert.equal(conflicting.isError, true);
    assert.match(JSON.stringify(conflicting), /source_offset/u);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("text source directories have independent pagination and expose every path", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 10;
    const content = Array.from({ length: 40 }, (_, i) => ({ text: `正文${i}` }));
    ctx.inputs.set("A", { messages: [{ content }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    let source_offset = 0;
    const paths: string[] = [];
    for (;;) {
      const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, source_offset }, new AbortController().signal);
      assert(!result.isError);
      const page = JSON.parse(result.content[0].text!);
      paths.push(...page.text_sources.map((item: { path: string }) => item.path));
      if (!page.text_sources_has_more) break;
      assert(page.text_sources_next_offset > source_offset);
      source_offset = page.text_sources_next_offset;
    }
    assert.deepEqual(paths, content.map((_, i) => `/content/${i}/text`));
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("search counts and paginates matches beyond ten thousand without retaining every hit", async () => {
  const ctx = await context();
  try {
    ctx.inputs.set("A", { messages: [{ content: "目标".repeat(15000) }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace"]));
    const result = await runtime.execute("search_trace", { candidate: "A", query: "目标", offset: 14999 }, new AbortController().signal);
    assert(!result.isError);
    const page = JSON.parse(result.content[0].text!);
    assert.equal(page.total, 15000);
    assert.equal(page.matches.length, 1);
    assert.equal(page.next_offset, 15000);
    assert.equal(page.has_more, false);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("cached reads return the live budget and still consume exploration calls", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const args = { candidate: "A", message_index: 0 };
    for (let used = 1; used <= 2; used++) {
      const result = await runtime.execute("read_trace", args, new AbortController().signal);
      const budget = JSON.parse(result.content.at(-1)!.text!).budget;
      assert.equal(budget.exploration.used, used);
      assert.equal(budget.exploration.remaining, 3 - used);
      assert.deepEqual((result.details as { budget: unknown }).budget, budget);
    }
    assert.equal(ctx.audit.traceReads.length, 1);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("budget feedback covers errors and actual mandatory coverage without confusing unused reading allowance", async () => {
  const ctx = await context();
  try {
    const text = "必须核对的原文。";
    ctx.inputs.set("A", { messages: [{ content: text }] });
    ctx.policy.maxToolCalls = 1;
    ctx.requiredReads = [{ candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: text.length }];
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "calculate"]));
    const budgetFor = (result: Awaited<ReturnType<typeof runtime.execute>>) => {
      const budget = JSON.parse(result.content.at(-1)!.text!).budget;
      assert.deepEqual((result.details as { budget: unknown }).budget, budget);
      assert.equal(budget.exploration.remaining, 0);
      return budget;
    };
    const calculation = await runtime.execute("calculate", { operation: "add", operands: ["2", "2"] }, new AbortController().signal);
    assert.equal(budgetFor(calculation).required_reads.covered, false);
    const exhausted = await runtime.execute("calculate", { operation: "add", operands: ["2", "2"] }, new AbortController().signal);
    assert.equal(exhausted.isError, true);
    assert.equal(budgetFor(exhausted).required_reads.covered, false);
    const read = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal);
    assert.equal(read.isError, undefined);
    assert.equal(budgetFor(read).required_reads.covered, true);
    const denied = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal);
    assert.equal(denied.isError, true);
    assert.equal(budgetFor(denied).required_reads.covered, true);
    assert.equal(ctx.audit.calls, 2, "denied calls consume no exploration or mandatory allowance");
    const searched = new ToolRuntime({ ...ctx, audit: emptyAudit() }, createRegistry().select(["search_trace"]));
    const match = await searched.execute("search_trace", { candidate: "A", query: text }, new AbortController().signal);
    const searchBudget = budgetFor(match);
    assert.equal(searchBudget.required_reads.used, 0);
    assert(searchBudget.required_reads.remaining > 0);
    assert.equal(searchBudget.required_reads.covered, true, "emitted source text can cover the mandatory range before its paging allowance is used");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
for (const tailChars of [2000, 18000])
test(`mandatory pages crossing searched text preserve the final draft call (tail: ${tailChars})`, async () => {
  const ctx = await context();
  try {
    const text = "a".repeat(1000) + "TARGET" + "b".repeat(tailChars);
    const target = { candidate: "A", message_index: 0, kind: "text" as const, path: "/content", start: 0, end: text.length };
    ctx.inputs.set("A", { messages: [{ content: text }] });
    ctx.policy.maxOutputChars = 24000;
    ctx.requiredReads = [target];
    ctx.draftWriteInCallLimit = true;
    const runtime = new ToolRuntime(ctx, createRegistry().select(["search_trace", "read_trace", "calculate", "edit_json"]));
    runtime.reserveDraftWrite();
    const signal = new AbortController().signal;
    const found = await runtime.execute("search_trace", { candidate: "A", message_index: 0, path: "/content", query: "TARGET" }, signal);
    assert.equal(found.isError, undefined);
    assert.equal((await runtime.execute("calculate", { operation: "add", operands: ["1", "1"] }, signal)).isError, undefined);
    assert.deepEqual(runtime.budget().exploration, { used: 2, remaining: 0 });
    const missing = traceReadCoverage(ctx.audit, target).missing;
    assert.equal(missing.length, 2, "the search leaves gaps on both sides of its hit");
    let offset = missing[0]!.start, pages = 0;
    while (offset < text.length) {
      const read = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content", offset }, signal);
      assert.equal(read.isError, undefined, JSON.stringify(read));
      const page = read.details as { next_offset: number };
      assert(page.next_offset > offset);
      offset = page.next_offset;
      pages++;
      assert.equal(ctx.audit.requiredReadCalls, pages, "each new mandatory page uses exactly one required-read call");
      assert.deepEqual(runtime.budget().exploration, { used: 2, remaining: 0 });
      assert.equal(runtime.budget().draft_writes.remaining, 1);
    }
    assert.equal(runtime.budget().required_reads.covered, true);
    assert.equal((await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, signal)).isError, true,
      "a repeated read still cannot spend the reserved writer call");
    const draft = await runtime.execute("edit_json", { path: "draft.json", set_json: '{"summary":"已核对完整正文"}' }, signal);
    assert.equal(draft.isError, undefined, JSON.stringify(draft));
    assert.deepEqual(JSON.parse(await readFile(path.join(ctx.workdir, "draft.json"), "utf8")), { summary: "已核对完整正文" });
    assert.equal(ctx.audit.calls, pages + 3);
    assert.equal(runtime.budget().draft_writes.remaining, 0);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("registered writers have nonaccumulating atomic draft allowances bounded by content turns", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 1;
    ctx.policy.repairAttempts = 2;
    let calls = 0;
    const registry = createRegistry([{
      name: "save_fixture", fileWriter: true, inputSchema: { type: "object" },
      async execute() {
        calls++;
        await Promise.resolve();
        if (calls === 3) throw new Error("write failed");
        return { content: [{ type: "text", text: "written" }] };
      },
    }]);
    const runtime = new ToolRuntime(ctx, registry.select(["save_fixture", "calculate"]));
    const signal = new AbortController().signal;
    assert.equal((await runtime.execute("save_fixture", {}, signal)).isError, undefined);
    assert.deepEqual(runtime.budget().draft_writes, { used: 0, remaining: 0, tools: ["save_fixture"] });
    assert.equal((await runtime.execute("save_fixture", {}, signal)).isError, true, "the caller has not reserved a file-content turn");
    runtime.reserveDraftWrite();
    runtime.reserveDraftWrite();
    assert.equal(runtime.budget().draft_writes.remaining, 1, "unused credits cannot accumulate");
    assert.equal((await runtime.execute("calculate", { operation: "add", operands: ["1", "1"] }, signal)).isError, true,
      "the reserved allowance cannot be spent on an unregistered writer");
    const results = await Promise.all([runtime.execute("save_fixture", {}, signal), runtime.execute("save_fixture", {}, signal)]);
    assert.equal(results.filter(result => result.isError !== true).length, 1, "parallel calls reserve the credit before executing");
    assert.deepEqual(runtime.budget().exploration, { used: 1, remaining: 0 });
    assert.equal(runtime.budget().draft_writes.used, 1);
    runtime.reserveDraftWrite();
    assert.equal((await runtime.execute("save_fixture", {}, signal)).isError, true, "failed execution still consumes its reserved credit");
    assert.deepEqual(runtime.budget().draft_writes, { used: 2, remaining: 1, tools: ["save_fixture"] },
      "a failed protected writer can correct its script within the original total cap");
    assert.equal((await runtime.execute("save_fixture", [], signal)).isError, true, "invalid writer parameters consume the protected attempt");
    runtime.reserveDraftWrite();
    assert.deepEqual(runtime.budget().draft_writes, { used: 3, remaining: 0, tools: ["save_fixture"] });
    assert.equal((await runtime.execute("save_fixture", {}, signal)).isError, true, "repeated grants cannot exceed the content-turn cap");
    assert.equal(calls, 3);
    assert.equal(ctx.audit.calls, 4, "ordinary, reserved and invalid writer attempts remain audited");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("in-limit drafting cannot renew calls after writer or file-loading failures", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 1; ctx.policy.repairAttempts = 2; ctx.draftWriteInCallLimit = true;
    let writes = 0;
    const registry = createRegistry([{ name: "save_fixture", fileWriter: true, inputSchema: { type: "object" },
      async execute() { writes++; throw new Error("write failed"); } }]);
    const runtime = new ToolRuntime(ctx, registry.select(["save_fixture", "calculate"])), signal = new AbortController().signal;
    runtime.reserveDraftWrite();
    assert.equal(runtime.budget().exploration.remaining, 0);
    await runtime.execute("save_fixture", {}, signal);
    runtime.reserveDraftWrite(); // A file-loading failure may request another writer, but cannot create credit.
    assert.equal(runtime.budget().draft_writes.remaining, 0);
    await runtime.execute("save_fixture", {}, signal);
    assert.equal(writes, 1); assert.equal(ctx.audit.calls, 1);
    assert.equal(runtime.budget(4).exploration.remaining, 2, "a content repair still adds only three calls including drafting");
    for (let index = 0; index < 2; index++)
      assert.equal((await runtime.execute("calculate", { operation: "add", operands: ["1", "1"] }, signal, 4)).isError, undefined);
    await runtime.execute("save_fixture", {}, signal, 4);
    runtime.reserveDraftWrite();
    await runtime.execute("save_fixture", {}, signal, 4);
    assert.equal(writes, 2); assert.equal(ctx.audit.calls, 4);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("malformed call accounting uses registered budgets without executing or exempting unread material", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxToolCalls = 1;
    ctx.requiredReads = [{ candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: 1 }];
    let executed = false;
    const registry = createRegistry([{ name: "save_fixture", fileWriter: true, inputSchema: {},
      async execute() { executed = true; return { content: [] }; } }]);
    const runtime = new ToolRuntime(ctx, registry.select(["save_fixture", "read_trace", "calculate"]));
    await runtime.execute("calculate", { operation: "add", operands: ["1", "1"] }, new AbortController().signal);
    runtime.reserveDraftWrite();
    assert.throws(() => runtime.chargeCall("unknown"), /Unknown tool/);
    assert.throws(() => runtime.chargeCall("read_trace"), /预算已耗尽/,
      "unavailable arguments cannot qualify as an exact mandatory read");
    runtime.chargeCall("save_fixture");
    assert.equal(executed, false, "even a permissive tool schema cannot dispatch absent SDK arguments");
    assert.equal(ctx.audit.calls, 2); assert.equal(ctx.audit.requiredReadCalls, 0);
    assert.deepEqual(runtime.budget().exploration, { used: 1, remaining: 0 });
    assert.deepEqual(runtime.budget().draft_writes, { used: 1, remaining: 0, tools: ["save_fixture"] });
    assert.throws(() => runtime.chargeCall("save_fixture"), /预算已耗尽/);
    assert.equal(ctx.audit.calls, 2, "denied calls cannot be counted twice");
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("an oversized text-path entry fails instead of returning a directory that cannot advance", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 700;
    ctx.inputs.set("A", { messages: [{ ["路径".repeat(500)]: "内容" }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"]));
    const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0 }, new AbortController().signal);
    assert.equal(result.isError, true);
    assert.match(JSON.parse(result.content[0].text!).message, /工具输出上限.*完整页面/);
    assert.deepEqual(ctx.audit.traceReads, []);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("an image withheld by the output budget cannot be claimed as viewed", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 200;
    ctx.inputs.set("A", { messages: [{ content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }] });
    const runtime = new ToolRuntime(ctx, createRegistry().select(["view_image"]));
    const result = await runtime.execute("view_image", { candidate: "A", message_index: 0 }, new AbortController().signal);
    assert.equal(result.isError, true);
    assert(!result.content.some(item => item.type === "image"));
    assert.deepEqual(ctx.audit.viewedImages, []);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("mandatory long-text pages finish after exploration is exhausted without freeing duplicate reads", async () => {
  const ctx = await context();
  try {
    const text = "核".repeat(300000);
    ctx.inputs.set("A", { messages: [{ content: text }] });
    ctx.policy.maxToolCalls = 1;
    ctx.requiredReads = [{ candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: text.length }];
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace", "calculate"]));
    await runtime.execute("calculate", { operation: "add", operands: ["1", "1"] }, new AbortController().signal);
    let offset = 0, pages = 0;
    do {
      const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content", offset }, new AbortController().signal);
      assert(!result.isError, JSON.stringify(result));
      const page = JSON.parse(result.content[0].text!);
      offset = page.next_offset; pages++;
      assert(result.content.map(item => item.text ?? "").join("\n").length <= ctx.policy.maxOutputChars);
    } while (offset < text.length);
    assert(pages > 14);
    assert.equal(ctx.audit.requiredReadCalls, pages);
    assert.equal(ctx.audit.calls, pages + 1);
    assert(traceReadCoverage(ctx.audit, ctx.requiredReads[0]).covered);
    assert.equal((await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, new AbortController().signal)).isError, true);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("JSON reuse does not suppress a deferred text read required by the submission contract", async () => {
  const ctx = await context();
  try {
    const text = "deferred answer ".repeat(100);
    ctx.inputs.set("A", { messages: [{ content: text }] });
    ctx.requiredReads = [{ candidate: "A", message_index: 0, kind: "text", path: "/content", start: 0, end: text.length }];
    const runtime = new ToolRuntime(ctx, createRegistry().select(["read_trace"])), signal = new AbortController().signal;
    await runtime.execute("read_trace", { candidate: "A", message_index: 0 }, signal);
    const result = await runtime.execute("read_trace", { candidate: "A", message_index: 0, path: "/content" }, signal);
    assert(!result.isError, JSON.stringify(result));
    assert.equal((result.details as any).evidence[0].quote, text);
    assert(traceReadCoverage(ctx.audit, ctx.requiredReads[0]).covered);
    assert.equal(ctx.audit.requiredReadCalls, 1);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("code executes with persistent task files and paged artifact output", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code", "read_artifact"]));
    const result = await runtime.execute(
      "execute_code",
      {
        language: "python",
        code: 'from pathlib import Path\nPath("answer.txt").write_text("4")\nprint(2+2)',
        outputs: ["answer.txt"],
      },
      new AbortController().signal,
    );
    assert(!result.isError, JSON.stringify(result));
    const details = result.details as { stdout: string; exit_code: number; artifacts: { name: string }[] };
    assert.equal(details.exit_code, 0);
    assert.equal(details.stdout.trim(), "4");
    assert.deepEqual(details.artifacts.map(artifact => artifact.name), ["answer.txt"], "only declared outputs need navigation when logs are already visible");
    assert.equal(ctx.audit.artifacts.length, 4, "diagnostic artifacts remain available in the audit");
    const output = ctx.audit.artifacts.find((a) => a.name === "answer.txt")!;
    const read = await runtime.execute("read_artifact", { id: output.id }, new AbortController().signal);
    assert.equal((read.details as { text: string }).text, "4");
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("truncated execution logs retain full-text navigation without exposing the script or empty logs", async () => {
  const ctx = await context();
  try {
    ctx.policy.maxOutputChars = 80;
    const result = await executeCode(ctx, { language: "python", code: "import sys\nprint('x'*120)\nprint('y'*120+' ValueError: tail',file=sys.stderr)" }, new AbortController().signal);
    const details = result.details as { stdout: string; stderr: string; artifacts: { id: string; name: string }[] };
    assert.equal(details.stdout.length, 80); assert.equal(details.stderr.length, 80);
    assert.deepEqual(details.artifacts.map(item => item.name.split('.').at(-1)), ["stdout", "stderr"]);
    const stderr = details.artifacts.find(item => item.name.endsWith('.stderr'))!;
    assert(Buffer.from(await ctx.artifacts.get(stderr.id)).toString().includes("ValueError: tail"));
    assert.equal(ctx.audit.artifacts.length, 3);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
for (const [kind, code, outputs, exitCode] of [
  ["syntax", "items = [\n}", ["draft.json"], 1],
  ["missing", "print('execution completed')", ["draft.json"], 0],
  ["outside", "print('execution completed')", [".."], 0],
] as const)
  test(`code output ${kind} failures preserve execution diagnostics and artifact errors`, async () => {
    const ctx = await context();
    try {
      const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
      const result = await runtime.execute("execute_code", { language: "python", code, outputs: [...outputs] }, new AbortController().signal);
      assert.equal(result.isError, true);
      const details = result.details as { exit_code: number; stdout: string; stderr: string;
        errors: { code: string; path: string; message: string }[] };
      assert.equal(details.exit_code, exitCode, "output collection must not hide the actual process result");
      if (kind === "syntax") assert.match(details.stderr, /SyntaxError/);
      else assert.equal(details.stdout.trim(), "execution completed");
      assert.equal(details.errors[0]?.code, "code_output_invalid");
      assert.equal(details.errors[0]?.path, "/outputs/0");
      if (kind === "outside") assert.match(details.errors[0]!.message, /产物必须位于任务工作目录/);
      assert.deepEqual(ctx.audit.artifacts.map(artifact => artifact.name.split(".").at(-1)), ["script", "stdout", "stderr"]);
    } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
  });
test("cancellation terminates the code process group", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
    const signal = new AbortController();
    const started = Date.now();
    const task = runtime.execute(
      "execute_code",
      { language: "shell", code: "sleep 30 &\nwait" },
      signal.signal,
    );
    setTimeout(() => signal.abort(), 150);
    const result = await task;
    assert(Date.now() - started < 5000);
    assert.equal((result.details as { cancelled: boolean }).cancelled, true);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("code timeout is enforced without waiting for the task deadline", async () => {
  const ctx = await context();
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
    const start = Date.now();
    const result = await runtime.execute(
      "execute_code",
      {
        language: "python",
        code: "import time; time.sleep(30)",
        timeout_seconds: 1,
      },
      new AbortController().signal,
    );
    assert.equal((result.details as { timed_out: boolean }).timed_out, true);
    assert(Date.now() - start < 4000);
  } finally {
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
test("cancellation falls back to the guardian when group signalling is denied", async (t) => {
  const ctx = await context();
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(pid, signal);
  });
  try {
    const runtime = new ToolRuntime(ctx, createRegistry().select(["execute_code"]));
    const signal = new AbortController();
    const started = Date.now();
    const task = runtime.execute("execute_code", { language: "shell", code: "sleep 30 &\nwait" }, signal.signal);
    setTimeout(() => signal.abort(), 150);
    const result = await task;
    assert.equal((result.details as { cancelled: boolean }).cancelled, true);
    assert(Date.now() - started < 5000);
  } finally { await rm(ctx.workdir, { recursive: true, force: true }); }
});
test("worker SIGKILL does not leave an executing Python process behind", async () => {
  const ctx = await context(),
    child = spawn(process.execPath, [path.join(ROOT, "dist/tests/fixtures/code-child.js"), ctx.workdir], {
      stdio: "ignore",
    });
  let pid: number | undefined;
  try {
    for (let i = 0; i < 200 && !pid; i++) {
      try {
        const value = Number(await readFile(path.join(ctx.workdir, "pid"), "utf8"));
        if (Number.isInteger(value) && value > 0) pid = value;
      } catch {}
      if (!pid) await new Promise((r) => setTimeout(r, 25));
    }
    assert(pid, "Python did not start");
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGKILL");
    await exited;
    let alive = true;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(alive, false, "Invocation guardian must terminate its process group after IPC disconnect");
  } finally {
    child.kill("SIGKILL");
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    await rm(ctx.workdir, { recursive: true, force: true });
  }
});
