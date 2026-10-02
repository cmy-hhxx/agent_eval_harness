import test from "node:test";
import assert from "node:assert/strict";
import { compareTraceTableRows, parseTraceTables } from "./table-correspondence.js";
import { resolveEvidence } from "./evidence.js";
import { createRegistry, ToolRuntime } from "./index.js";
import { DEFAULT_POLICY, type ToolContext } from "@eval/contracts";

const table = (rows: string[]) => "| ID | Name |\n| --- | --- |\n" + rows.map((row) => `| ${row} |`).join("\n");
const input = (...texts: string[]) => ({ messages: texts.map((text, index) => index === texts.length - 1
  ? { role: "assistant", content: text } : { type: "function_call_output", output: text }) });
function check(raw: ReturnType<typeof input>, key = 1, value = 0) {
  const tables = parseTraceTables(raw);
  return compareTraceTableRows(raw, { answer_table_id: tables.at(-1)!.table_id,
    sources: tables.slice(0, -1).map((source) => ({ table_id: source.table_id,
      key_columns: [{ answer: key, source: key }], value_columns: [{ answer: value, source: value }] })) });
}

test("table correspondence finds every changed identifier and accepts its corrected counterpart", () => {
  const original = table(["301689.SZ | 电科思仪", "920748.BJ | 路桥信息", "002614.SZ | 奥佳华", "002238.SZ | 天威视讯"]);
  const wrong = table(["688255.SH | 电科思仪", "300791.SZ | 路桥信息", "002635.SZ | 奥佳华", "002009.SZ | 天威视讯"]);
  assert.deepEqual(check(input(original, wrong)).rows.map((row) => row.status), Array(4).fill("conflict"));
  assert.deepEqual(check(input(original, original)).rows.map((row) => row.status), Array(4).fill("matched"));
  // Choosing the incorrect identifiers as keys must not hide matching names in the other direction.
  assert.deepEqual(check(input(original, wrong), 0, 1).rows.map((row) => row.status), Array(4).fill("conflict"));
});

test("missing or truncated source rows stay unverified without alleging an error", () => {
  const result = check(input("Found 52 records; preview follows.\n\n" + table(["A | Alpha"]), table(["A | Alpha", "B | Beta"])));
  assert.deepEqual(result.rows.map((row) => row.status), ["matched", "unverified"]);
  assert.deepEqual(result.summary, { matched: 1, conflict: 0, unverified: 1, ambiguous: 0 });
});

test("selected source disagreements remain ambiguous even when a later echo matches the answer", () => {
  const result = check(input(table(["ID-1 | Alpha"]), table(["ID-2 | Alpha"]), table(["ID-2 | Alpha"])));
  assert.equal(result.rows[0].status, "ambiguous");
  assert.equal(result.rows[0].sources.length, 2);
  assert.deepEqual(result.rows[0].sources.map((row) => row.cells[0]), ["ID-1", "ID-2"]);
});

test("duplicate identical rows can agree but multiple values for one key are ambiguous", () => {
  assert.equal(check(input(table(["A | Alpha", "A | Alpha"]), table(["A | Alpha"]))).rows[0].status, "matched");
  assert.equal(check(input(table(["A | Alpha", "B | Alpha"]), table(["C | Alpha"]))).rows[0].status, "ambiguous");
});

test("a resolved key is not confused with other rows sharing a non-unique checked value", () => {
  const source = table(["A | Same value", "B | Same value"]);
  assert.equal(check(input(source, table(["A | Same value"])), 0, 1).rows[0].status, "matched");
  assert.equal(check(input(source, table(["C | Same value"])), 0, 1).rows[0].status, "ambiguous");
});

test("mechanical difference does not assert semantic entity identity or normalize suffixes", () => {
  const suffix = check(input(table(["HSI | 恒生指数"]), table(["HSI.GI | 恒生指数"])));
  assert.equal(suffix.rows[0].status, "conflict");
  assert.equal(suffix.rows[0].sources[0].cells[0], "HSI");
  assert.equal(check(input(table(["HSI | 恒生指数"]), table(["HSI.GI | Hang Seng"]))).rows[0].status, "unverified");
});

test("Markdown parsing preserves source coordinates, escaped pipes and displayed inline content", () => {
  const raw = input("prefix\r\n\r\n| ID | Name |\r\n|---|---|\r\n| A | **Alpha** \\| Beta |\r\n\r\n```md\n" + table(["X | Code example"]) + "\n```",
    table(["A | Alpha \\| Beta"]));
  const tables = parseTraceTables(raw);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rows[0].cells[1], "Alpha | Beta");
  assert.equal(check(raw).rows[0].status, "matched");
  for (const parsed of tables) for (const row of parsed.rows)
    assert.deepEqual(resolveEvidence(raw, row.evidence, "answer", [], "test"), {
      message_index: row.evidence.message_index, quote: row.evidence.quote,
    });
});

test("inventories exclude copied input messages and call arguments from source tables", () => {
  const content = table(["A | Alpha"]);
  const raw = { messages: [
    { type: "function_call", arguments: content, input_messages: { content } },
    { type: "function_call_output", output: [{ text: content }], input_messages: { content } },
    { role: "assistant", content },
  ] };
  assert.deepEqual(parseTraceTables(raw).map((item) => item.path), ["/output/0/text", "/content"]);
});

test("invalid coordinates and mappings cannot silently weaken a table check", () => {
  const raw = input(table(["A | Alpha"]), table(["B | Alpha"]));
  const tables = parseTraceTables(raw);
  const valid = { answer_table_id: tables[1].table_id, sources: [{ table_id: tables[0].table_id,
    key_columns: [{ answer: 1, source: 1 }], value_columns: [{ answer: 0, source: 0 }] }] };
  assert.throws(() => compareTraceTableRows(raw, { ...valid, answer_table_id: "missing" }), /不存在/);
  assert.throws(() => compareTraceTableRows(raw, { ...valid, sources: [] }), /来源表/);
  assert.throws(() => compareTraceTableRows(raw, { ...valid, answer_table_id: tables[0].table_id,
    sources: [{ ...valid.sources[0], table_id: tables[1].table_id }] }), /先于/);
  assert.throws(() => compareTraceTableRows(raw, { ...valid,
    sources: [{ ...valid.sources[0], table_id: tables[1].table_id }] }), /先于/);
  assert.throws(() => compareTraceTableRows(raw, { ...valid,
    sources: [{ ...valid.sources[0], key_columns: [] }] }), /列/);
  assert.throws(() => compareTraceTableRows(raw, { ...valid,
    sources: [{ ...valid.sources[0], key_columns: [{ answer: 5, source: 1 }] }] }), /列/);
});

test("check_table registers a bounded JSON inventory and records only recomputable comparison coordinates", async () => {
  const raw = input(table(Array.from({ length: 9 }, (_, i) => `A${i} | Name ${i}`)),
    table(Array.from({ length: 9 }, (_, i) => `B${i} | Name ${i}`)));
  const ctx: ToolContext = {
    attemptId: "table-check", workdir: "/tmp", inputs: new Map([["answer", raw]]),
    audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] },
    policy: { ...DEFAULT_POLICY, maxOutputChars: 1800 },
    artifacts: { async put() { throw new Error("table tool must paginate before artifact truncation"); },
      async get() { throw new Error("no artifacts"); } },
  };
  const runtime = new ToolRuntime(ctx, createRegistry().select(["check_table"]));
  const invoke = (args: unknown) => runtime.execute("check_table", args, new AbortController().signal);
  const inventory = await invoke({ candidate: "answer" });
  assert(!inventory.isError);
  const listed = JSON.parse(inventory.content[0].text!);
  assert.equal(listed.total, 2);
  assert.equal(listed.tables[0].row_count, 9);
  assert.equal(listed.tables[0].rows, undefined);
  assert.equal(ctx.audit.tableChecks, undefined);
  const tables = parseTraceTables(raw);
  const request = { candidate: "answer", answer_table_id: tables[1].table_id, sources: [{ table_id: tables[0].table_id,
    key_columns: [{ answer: 1, source: 1 }], value_columns: [{ answer: 0, source: 0 }] }] };
  const seen: number[] = [];
  let offset = 0;
  do {
    const result = await invoke({ ...request, offset });
    assert(!result.isError, JSON.stringify(result));
    assert(result.content[0].text!.length <= ctx.policy.maxOutputChars);
    const page = JSON.parse(result.content[0].text!);
    assert.equal(page.summary.conflict, 9);
    assert.equal(page.total, 9);
    for (const row of page.rows) {
      seen.push(row.row_index);
      assert.equal(row.sources[0].evidence.message_index, 0);
      assert.equal(row.answer.evidence.message_index, 1);
    }
    assert(page.next_offset > offset);
    offset = page.has_more ? page.next_offset : 0;
  } while (offset);
  assert.deepEqual(seen, Array.from({ length: 9 }, (_, i) => i));
  assert.deepEqual(ctx.audit.tableChecks, [request]);
  const invalid = await invoke({ ...request, candidate: "outside" });
  assert(invalid.isError);
  assert.deepEqual(ctx.audit.tableChecks, [request]);
});
