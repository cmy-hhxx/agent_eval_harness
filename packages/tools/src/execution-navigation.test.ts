import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DEFAULT_POLICY, evidenceId, type ToolContext, type ToolResult } from "@eval/contracts";
import { ArtifactStore } from "@eval/data";
import { createRegistry, ToolRuntime } from "./index.js";

const inputId = "11111111-1111-4111-8111-111111111111";
const proof = (message: number) => ({ message_index: message, evidence_id: evidenceId(inputId, message, "text", "/content", 0, 6) });
async function setup() {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "execution-navigation-"));
  const snapshots: string[][] = [];
  const nodes = Array.from({ length: 25 }, (_, i) => ({ execution_node_index: i + 1,
    kind: "model", actor_index: i + 1, message_index: i, component: `模型 ${i}`, summary: `摘要 ${i}` }));
  const boundaries = Array.from({ length: 24 }, (_, i) => ({ transition_index: i + 1,
    kind: i === 0 ? "request_formation" : "transfer", actor_index: i === 0 ? 1 : null,
    execution_node_index: i === 0 ? 1 : null, source_node_index: i + 1, target_node_index: i + 2,
    chain_index: 1, chain_indices: [1], input_path: "/input_messages/0", relation: "captured",
    before: [proof(i)], after: [proof(i + 1)], predecessors: i === 0 ? [] : [i] }));
  const ctx: ToolContext = { attemptId: "test", workdir,
    inputs: new Map([["answer", { messages: nodes.map(() => ({ content: "证据正文六字" })) }]]),
    inputIds: new Map([["answer", inputId]]), materialNavigation: { answer: { nodes, boundaries,
      table_checks: [{ table_index: 1, row_index: 1, reference: { evidence_id: proof(0).evidence_id } }] } },
    audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] },
    policy: { ...DEFAULT_POLICY, maxToolCalls: 50, maxOutputChars: 20000 },
    artifacts: new ArtifactStore(path.join(workdir, "artifacts")), persistEvidenceBank: async bank => { snapshots.push([...bank]); } };
  const runtime = new ToolRuntime(ctx, createRegistry().select(["read_execution", "read_trace"]));
  const call = (args: Record<string, unknown>) => runtime.execute("read_execution", { candidate: "answer", ...args }, new AbortController().signal);
  return { ctx, nodes, boundaries, snapshots, runtime, call, close: () => rm(workdir, { recursive: true, force: true }) };
}
function page(result: ToolResult) {
  assert(!result.isError, result.content[0].text);
  const value = JSON.parse(result.content[0].text!);
  assert.equal(value.returned_chars, result.content[0].text!.length);
  return value;
}

test("execution navigation pages complete nodes, searches only short metadata, and enforces page limits", async () => {
  const f = await setup();
  try {
    const first = page(await f.call({ view: "nodes" }));
    assert.equal(first.total, 25); assert.equal(first.items.length, 8);
    assert.equal(first.next_offset, 8); assert(first.has_more);
    assert.equal(first.next_request.tool, "read_execution");
    const second = page(await f.call(first.next_request.arguments));
    assert.equal(second.items[0].execution_node_index, 9);
    const last = page(await f.call({ view: "nodes", offset: 24 }));
    assert.equal(last.items.length, 1); assert.equal(last.next_request, null); assert.equal(last.next_offset, null);
    assert.equal(page(await f.call({ view: "nodes", query: "摘要 22" })).items[0].message_index, 22);
    assert.equal(page(await f.call({ view: "nodes", query: "证据正文" })).total, 0);
    assert.equal(page(await f.call({ view: "nodes", message_index: 3 })).items[0].execution_node_index, 4);
    assert.equal(page(await f.call({ view: "nodes", limit: 20, max_chars: 16000 })).items.length, 20);
    assert((await f.call({ view: "nodes", limit: 21 })).isError);
    assert((await f.call({ view: "nodes", max_chars: 16001 })).isError);
    const tight = page(await f.call({ view: "nodes", limit: 20, max_chars: 1100 }));
    assert(tight.returned_chars <= 1100); assert(tight.items.length > 0 && tight.items.length < 8);
    assert((await f.call({ view: "nodes", max_chars: 20 })).isError);
  } finally { await f.close(); }
});

test("execution navigation follows only one edge and can select formation among history transfers", async () => {
  const f = await setup();
  try {
    const related = page(await f.call({ view: "boundaries", execution_node_index: 2 }));
    assert.deepEqual(related.items.map((x: any) => x.transition_index), [1, 2]);
    assert(!("before" in related.items[0])); assert(!("after" in related.items[0])); assert(!("predecessors" in related.items[0]));
    assert.equal(related.items[0].requests.before.arguments.view, "before");
    assert.equal(related.items[0].component, '模型 0');
    assert.equal(related.items[0].action, '生成工具调用参数');
    assert.deepEqual(page(await f.call({ view: 'nodes', message_index: 0 })).items[0].responsibility_choices,
      [{ transition_index: 1, action: '生成工具调用参数' }]);
    assert.equal(page(await f.call({ view: "boundaries", execution_node_index: 2, kind: "request_formation" })).total, 1);
    assert.deepEqual(page(await f.call({ view: "predecessors", transition_index: 3 })).items.map((x: any) => x.transition_index), [2]);
    assert.deepEqual(page(await f.call({ view: "successors", transition_index: 1 })).items.map((x: any) => x.transition_index), [2]);
    assert.equal(page(await f.call({ view: "successors", transition_index: 1, kind: "execution" })).total, 0);
    assert((await f.call({ view: "before" })).isError);
    assert((await f.call({ view: "nodes", transition_index: 1 })).isError);
    assert((await f.call({ view: "boundaries", query: "正文" })).isError);
    assert.equal(f.ctx.audit.evidenceBank!.length, 0);
  } finally { await f.close(); }
});

test("navigation registers stable evidence choices serially without claiming read coverage", async () => {
  const f = await setup();
  try {
    const [before, after] = await Promise.all([f.call({ view: "before", transition_index: 1 }), f.call({ view: "after", transition_index: 1 })]);
    const a = page(before), b = page(after);
    assert.deepEqual(a.items[0].reference, { evidence_index: 1 });
    assert.deepEqual(b.items[0].reference, { evidence_index: 2 });
    assert.deepEqual(f.snapshots.map(bank => bank.length), [1, 2]);
    assert.equal(a.items[0].read_request.tool, "read_trace");
    assert.deepEqual(a.items[0].read_request.arguments, { candidate: "answer", message_index: 0, path: "/content", offset: 0, max_chars: 6 });
    assert(!before.content[0].text!.includes("ev_"));
    assert.deepEqual(f.ctx.audit.traceReads, []); assert.deepEqual(f.ctx.audit.viewedImages, []);
    assert.equal(f.ctx.audit.requiredReadCalls, 0);
    assert.equal(page(await f.call({ view: "after", transition_index: 1 })).items[0].reference.evidence_index, 2);
    const read = await f.runtime.execute(a.items[0].read_request.tool, a.items[0].read_request.arguments, new AbortController().signal);
    assert(!read.isError); assert(f.ctx.audit.traceReads.length > 0);
    assert.equal(f.ctx.audit.evidenceBank!.length, 2);
    assert.equal(page(await f.call({ view: "before", transition_index: 1, message_index: 0, path: "/content" })).total, 1);
    assert.equal(page(await f.call({ view: "before", transition_index: 1, message_index: 1 })).total, 0);
    assert.equal(page(await f.call({ view: "before", transition_index: 1, path: "/missing" })).total, 0);
  } finally { await f.close(); }
});

test("evidence paging registers only visible items and table/image navigation does not fake reads", async () => {
  const f = await setup();
  try {
    f.boundaries[0].before = Array.from({ length: 25 }, (_, i) => proof(i));
    const first = page(await f.call({ view: "before", transition_index: 1, limit: 20, max_chars: 1400 }));
    assert(first.items.length > 0 && first.items.length < 20);
    assert.equal(f.ctx.audit.evidenceBank!.length, first.items.length);
    assert.equal(first.next_offset, first.items.length);
    const table = page(await f.call({ view: "table_checks" }));
    assert.equal(table.items[0].reference.evidence_index, 1);
    f.boundaries[0].after = [{ message_index: 1, evidence_id: evidenceId(inputId, 1, "image") }];
    const image = page(await f.call({ view: "after", transition_index: 1 }));
    assert.deepEqual(image.items[0].read_request, { tool: "view_image", arguments: { candidate: "answer", message_index: 1 } });
    assert.deepEqual(f.ctx.audit.traceReads, []); assert.deepEqual(f.ctx.audit.viewedImages, []);
    assert((await f.call({ view: "nodes", candidate: "other" })).isError);
    f.boundaries[0].after = [{ message_index: 1, evidence_id: evidenceId("22222222-2222-4222-8222-222222222222", 1, "image") }];
    assert((await f.call({ view: "after", transition_index: 1 })).isError);
  } finally { await f.close(); }
});

test("known evidence locates intersecting physical boundaries without matching equal history text", async () => {
  const f = await setup();
  try {
    const read = await f.runtime.execute("read_trace", { candidate: "answer", message_index: 1, path: "/content", offset: 2, max_chars: 2 }, new AbortController().signal);
    assert(!read.isError);
    const index = (read.details as { evidence: { reference: { evidence_index: number } }[] }).evidence[0].reference.evidence_index;
    const bank = [...f.ctx.audit.evidenceBank!], reads = structuredClone(f.ctx.audit.traceReads);
    const related = page(await f.call({ view: "boundaries", evidence_index: index }));
    assert.deepEqual(related.items.map((item: any) => [item.transition_index, item.matched_sides]), [[1, ["after"]], [2, ["before"]]]);
    assert(!related.items.some((item: any) => item.transition_index === 3), "identical content at another message is not this physical occurrence");
    assert.equal(page(await f.call({ view: "boundaries", evidence_index: index, kind: "request_formation" })).items[0].transition_index, 1);
    assert.deepEqual(f.ctx.audit.evidenceBank, bank); assert.deepEqual(f.ctx.audit.traceReads, reads);
    assert((await f.call({ view: "nodes", evidence_index: index })).isError);
    assert((await f.call({ view: "boundaries", evidence_index: 999 })).isError);
    f.ctx.audit.evidenceBank!.push(evidenceId("22222222-2222-4222-8222-222222222222", 1, "text", "/content", 0, 2));
    assert((await f.call({ view: "boundaries", evidence_index: f.ctx.audit.evidenceBank!.length })).isError);
  } finally { await f.close(); }
});

test("evidence-associated candidates retain whole-item pagination and exact next requests", async () => {
  const f = await setup();
  try {
    f.boundaries.forEach(boundary => { boundary.before = [proof(0)]; });
    page(await f.call({ view: "before", transition_index: 1 }));
    const first = page(await f.call({ view: "boundaries", evidence_index: 1, limit: 4 }));
    assert.equal(first.total, 24); assert.equal(first.items.length, 4); assert(first.has_more);
    assert.equal(first.next_request.arguments.evidence_index, 1);
    assert.equal(first.next_request.arguments.offset, 4);
    assert.deepEqual(page(await f.call(first.next_request.arguments)).items.map((item: any) => item.transition_index), [5, 6, 7, 8]);
    assert.equal(f.ctx.audit.evidenceBank!.length, 1); assert.deepEqual(f.ctx.audit.traceReads, []);
  } finally { await f.close(); }
});
