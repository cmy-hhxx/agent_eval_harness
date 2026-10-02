import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentRequest, ToolAudit } from "@eval/contracts";
import { ValidationError } from "@eval/contracts";
import { parseTraceTables, type TableCheckResult } from "@eval/tools";
import { attributionProfile } from "./index.js";
import { attributionTableChecks, attributionTablePlan, attributionTableReview } from "./table-review.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import requestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };

const source = "| 股票代码 | 股票简称 |\n|---|---|\n| 301689.SZ | 电科思仪 |\n| 920748.BJ | 路桥信息 |";
function fixture(answer = "| 代码 | 名称 |\n|---|---|\n| 688255.SH | 电科思仪 |\n| 300791.SZ | 路桥信息 |") {
  const request: AgentRequest = structuredClone(example.request);
  const raw = { messages: [{ role: "user", content: "按查询结果列出股票代码与名称。" },
    { role: "tool", type: "function_call_output", name: "lookup", content: source },
    { role: "assistant", content: answer }] };
  request.sources.answer.value = raw;
  const input = request.input as typeof example.request.input;
  input.ground_truth = { available: false, value: null as unknown as string };
  input.answer.final_message_index = 2;
  input.answer.final_answer = answer;
  input.answer.catalog = [{ message_index: 1, type: "function_call_output", role: "tool", name: "lookup" }] as never;
  Object.assign(input.answer, { table_check_results: attributionTableChecks(raw, 2) });
  const result = structuredClone(example.result) as AttributionResult;
  result.has_standard_answer = false; result.is_correct = null;
  result.correctness_reason = ""; result.correctness_evidence = []; result.numeric_checks = [];
  result.findings = [];
  for (const assessment of result.criterion_assessments)
    if (assessment.status !== "not_applicable") assessment.evidence = [{ message_index: 2, quote: answer }];
  const tables = parseTraceTables(raw);
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
  return { request, result, audit, tables };
}
const rejects = (data: ReturnType<typeof fixture>, code: string) => assert.throws(
  () => attributionProfile.validate!(data.request, data.result, data.audit),
  (error: unknown) => error instanceof ValidationError && !!error.issues?.some(issue => issue.code === code));

function resolutionFixture(messages: Record<string, unknown>[], quote: string,
  answer = "| 代码 | 名称 |\n|---|---|\n| 301689.SZ | 电科思仪 |\n| 123456.SZ | 另一标的 |", rowIndex = 1) {
  const data = fixture(answer);
  const raw = data.request.sources.answer.value as { messages: unknown[] };
  raw.messages.splice(2, 0, ...messages);
  const finalIndex = 2 + messages.length;
  (data.request.input.answer as { final_message_index: number }).final_message_index = finalIndex;
  for (const assessment of data.result.criterion_assessments)
    for (const item of assessment.evidence) item.message_index = finalIndex;
  const plan = attributionTablePlan(raw, finalIndex)[0];
  Object.assign(data.request.input.answer as object, { table_check_results: attributionTableChecks(raw, finalIndex) });
  const finalRow = parseTraceTables(raw).find(table => table.table_id === plan.answer_table_id)!.rows[rowIndex];
  data.result.table_resolutions = [{ table_id: plan.answer_table_id, row_index: rowIndex, outcome: "supported",
    reason: "后续原查询以普通文本给出了同一标的代码。",
    evidence: [{ message_index: finalIndex, quote: finalRow.evidence.quote }, { message_index: finalIndex - 1, quote }] }];
  Object.assign(data.request.input, { review_context: { reasons: ["核对来源。"] } });
  return data;
}

test("entity table materials must include program-computed summaries and doubt rows", () => {
  const data = fixture();
  delete (data.request.input.answer as { table_check_results?: unknown }).table_check_results;
  rejects(data, "table_check_results_missing");
});

test("precomputed table material cannot hide doubt rows, counts or original evidence", () => {
  const mutate = [
    (checks: TableCheckResult[]) => checks.pop(),
    (checks: TableCheckResult[]) => checks[0].rows.pop(),
    (checks: TableCheckResult[]) => { checks[0].rows[0].status = "matched"; },
    (checks: TableCheckResult[]) => { checks[0].summary.conflict = 0; },
    (checks: TableCheckResult[]) => { checks[0].rows[0].sources[0].evidence.quote = "伪造来源"; },
  ];
  for (const change of mutate) {
    const data = fixture();
    change((data.request.input.answer as { table_check_results: TableCheckResult[] }).table_check_results);
    rejects(data, "table_check_results_mismatch");
  }
});

test("automatic table correspondence supplies both original sides without fabricating model activity", () => {
  const data = fixture(), before = structuredClone(data.audit);
  const checks = (data.request.input.answer as { table_check_results: TableCheckResult[] }).table_check_results;
  assert.equal(checks.length, 1);
  assert.equal(checks[0].summary.conflict, 2);
  for (const [index, row] of checks[0].rows.entries()) {
    assert.deepEqual(row.answer.evidence, data.tables[1].rows[index].evidence);
    assert.deepEqual(row.sources[0].evidence, data.tables[0].rows[index].evidence);
  }
  attributionTableReview(data.request, data.result);
  assert.deepEqual(data.audit, before);
});

test("a large matching table supplies only normalized summary counts", () => {
  const count = 1000;
  const rows = Array.from({ length: count }, (_, index) => ({ code: String(100000 + index), name: `标的${index}` }));
  const source = `| 股票代码 | 股票简称 |\n|---|---|\n${rows.map(row => `| ${row.code}.SZ | ${row.name} |`).join("\n")}`;
  const answer = `| 代码 | 名称 |\n|---|---|\n${rows.map(row => `| ${row.code} | ${row.name} |`).join("\n")}`;
  const raw = { messages: [{ role: "tool", name: "lookup", content: source }, { role: "assistant", content: answer }] };
  const checks = attributionTableChecks(raw, 1);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].summary, { matched: count, conflict: 0, unverified: 0, ambiguous: 0 });
  assert.deepEqual(checks[0].rows, []);
});

test("normalized doubt material retains every conflict, ambiguity and missing row with complete evidence", () => {
  const raw = { messages: [
    { role: "tool", name: "lookup", content: "| 股票代码 | 股票简称 |\n|---|---|\n| 111111.SZ | 已匹配 |\n| 222222.SZ | 歧义标的 |\n| 333333.SZ | 冲突标的 |" },
    { role: "tool", name: "lookup", content: "| 股票代码 | 股票简称 |\n|---|---|\n| 111111.SZ | 已匹配 |\n| 999999.SZ | 歧义标的 |\n| 333333.SZ | 冲突标的 |" },
    { role: "assistant", content: "| 代码 | 名称 |\n|---|---|\n| 111111 | 已匹配 |\n| 222222 | 歧义标的 |\n| 444444 | 冲突标的 |\n| 555555 | 未展示标的 |" },
  ] };
  const checks = attributionTableChecks(raw, 2);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].summary, { matched: 1, conflict: 1, unverified: 1, ambiguous: 1 });
  assert.deepEqual(checks[0].rows.map(row => [row.row_index, row.status]), [[1, "ambiguous"], [2, "conflict"], [3, "unverified"]]);
  const tables = parseTraceTables(raw), answer = tables.find(table => table.table_id === checks[0].answer_table_id)!;
  for (const row of checks[0].rows) {
    assert.deepEqual(row.answer.cells, answer.rows[row.row_index].cells);
    assert.deepEqual(row.answer.evidence, answer.rows[row.row_index].evidence);
    assert.equal(row.sources.length, row.status === "unverified" ? 0 : 2);
    for (const source of row.sources) {
      const original = tables.find(table => table.table_id === source.table_id)!.rows[source.row_index];
      assert.deepEqual(source.cells, original.cells);
      assert.deepEqual(source.evidence, original.evidence);
    }
  }
});

test("a request without comparable entity tables still explicitly supplies an empty result array", () => {
  const data = fixture("没有查询到可列出的标的。");
  assert.deepEqual((data.request.input.answer as { table_check_results: TableCheckResult[] }).table_check_results, []);
  assert.deepEqual(attributionTableReview(data.request, data.result).errors, []);
  delete (data.request.input.answer as { table_check_results?: unknown }).table_check_results;
  rejects(data, "table_check_results_missing");
});

test("the request schema requires table results and permits only declared doubt rows", () => {
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(requestSchema);
  const data = fixture();
  (data.request.input.answer as { catalog: unknown[] }).catalog = [];
  assert(validate(data.request.input), JSON.stringify(validate.errors));
  const missing = structuredClone(data.request.input);
  delete (missing.answer as { table_check_results?: unknown }).table_check_results;
  assert.equal(validate(missing), false);
  assert(validate.errors?.some(error => error.keyword === "required" && error.params.missingProperty === "table_check_results"));
  const invalid = structuredClone(data.request.input);
  const row = (invalid.answer as { table_check_results: TableCheckResult[] }).table_check_results[0].rows[0];
  Object.assign(row, { unsupported_field: true });
  assert.equal(validate(invalid), false);
  assert(validate.errors?.some(error => error.keyword === "additionalProperties" && error.params.additionalProperty === "unsupported_field"));
  const matched = structuredClone(data.request.input);
  (matched.answer as { table_check_results: TableCheckResult[] }).table_check_results[0].rows[0].status = "matched";
  assert.equal(validate(matched), false);
  assert(validate.errors?.some(error => error.keyword === "enum" && error.instancePath.endsWith("/status")));
});

test("verified table conflicts cannot disappear from attribution findings", () => {
  const data = fixture();
  rejects(data, "table_conflict_unreported");
});

test("corrected entity pairs, case-insensitive exchanges and a missing suffix are not falsely accused", () => {
  for (const codes of [["301689.SZ", "920748.BJ"], ["301689.sz", "920748.bj"], ["301689", "920748"]]) {
    const data = fixture(`| 代码 | 名称 |\n|---|---|\n| ${codes[0]} | 电科思仪 |\n| ${codes[1]} | 路桥信息 |`);
    const checks = (data.request.input.answer as { table_check_results: TableCheckResult[] }).table_check_results;
    assert.deepEqual(checks[0].summary, { matched: 2, conflict: 0, unverified: 0, ambiguous: 0 });
    assert.deepEqual(checks[0].rows, []);
    attributionProfile.validate!(data.request, data.result, data.audit);
    assert.deepEqual(attributionTableReview(data.request, data.result).reasons, []);
    assert.equal(data.audit.calls, 0);
    assert.deepEqual(data.audit.traceReads, []);
  }
});

test("explicitly different exchanges remain conflicting for the same six-digit code", () => {
  const data = fixture("| 代码 | 名称 |\n|---|---|\n| 301689.SH | 电科思仪 |\n| 920748.SZ | 路桥信息 |");
  const checks = (data.request.input.answer as { table_check_results: TableCheckResult[] }).table_check_results;
  assert.deepEqual(checks[0].summary, { matched: 0, conflict: 2, unverified: 0, ambiguous: 0 });
  rejects(data, "table_conflict_unreported");
});

test("source truncation triggers review without manufacturing a confirmed problem", () => {
  const data = fixture("| 代码 | 名称 |\n|---|---|\n| 301689.SZ | 电科思仪 |\n| 123456.SZ | 未展示的标的 |");
  attributionProfile.validate!(data.request, data.result, data.audit);
  const review = attributionTableReview(data.request, data.result);
  assert.equal(review.errors.length, 0);
  assert.match(review.reasons.join(" "), /不证明答案错误/);
});

test("an explicit unknown cell is not mistaken for an asserted code without a source", () => {
  const data = fixture("| 代码 | 公司名称 |\n|---|---|\n| 301689.SZ | 电科思仪 |\n| 待核实 | 来源未展示标的 |");
  attributionProfile.validate!(data.request, data.result, data.audit);
  assert.deepEqual(attributionTableReview(data.request, data.result).reasons, []);
});

test("a conflict can be accepted when both original rows support an explicit problem", () => {
  const data = fixture();
  data.result.findings = data.tables[1].rows.map((row, index) => ({
    finding_id: `pair${index}`, type: "problem", dimension: "correctness", stage: "final_answer", importance: "high",
    text: "名称对应的代码与原始查询不一致。", reason: "源查询与最终表对同一名称给出不同代码。",
    evidence: [row.evidence, data.tables[0].rows[index].evidence].map(({ message_index, quote }) => ({ message_index, quote })),
    assessment: { requirement_index: 0, observation: "代码错配", evidence_status: "established", impact: "影响标的识别" },
    problem: { component: ["模型自身推理"], label: "代码错配", definition: "最终表替换了原始查询中的代码。" },
  }));
  attributionProfile.validate!(data.request, data.result, data.audit);
  assert.deepEqual(attributionTableReview(data.request, data.result).reasons, []);
});

test("independent review can resolve a row from a literal tool source outside Markdown tables", () => {
  const source = "另一标的的股票代码为123456.SZ。";
  for (const field of ["content", "output", "result"]) {
    const data = resolutionFixture([{ role: "tool", type: "function_call_output", name: "lookup", [field]: source }], source);
    assert.deepEqual(attributionTableReview(data.request, data.result).reasons, []);
    attributionProfile.validate!(data.request, data.result, data.audit);
    delete data.request.input.review_context;
    rejects(data, "table_resolution_invalid");
    assert.deepEqual(attributionTableReview(data.request, data.result, { accepted: true }).reasons, []);
  }
});

test("independent resolutions address existing doubt rows instead of inventing decisions for matched rows", () => {
  const source = "电科思仪的股票代码为301689.SZ。";
  const data = resolutionFixture([{ role: "tool", name: "lookup", content: source }], source, undefined, 0);
  rejects(data, "table_resolution_invalid");
  data.result.table_resolutions![0].row_index = 100;
  rejects(data, "table_resolution_invalid");
});

test("supported resolutions cannot discard a known conflicting source row", () => {
  const source = "电科思仪的股票代码为688255.SH。";
  const data = resolutionFixture([{ role: "tool", name: "lookup", content: source }], source,
    "| 代码 | 名称 |\n|---|---|\n| 688255.SH | 电科思仪 |\n| 920748.BJ | 路桥信息 |", 0);
  data.result.table_resolutions![0].evidence.push({ message_index: 1, quote: data.tables[0].rows[0].evidence.quote });
  rejects(data, "table_resolution_unsupported");
});

test("source resolutions preserve the complete returned leaf and ignore input or metadata", () => {
  const source = "另一标的的股票代码为123456.SZ。";
  for (const message of [
    { content: `以下是错误示例：${source}` },
    { content: `以下是错误示例：\n\n${source}` },
    { content: "无该标的数据。", input: { text: source } },
    { content: "无该标的数据。", metadata: { text: source } },
    { content: { text: "无该标的数据。", metadata: { text: source } } },
  ]) rejects(resolutionFixture([{ role: "tool", name: "lookup", ...message }], source), "table_resolution_unsupported");
});

test("model execution returns cannot independently support an unresolved pair", () => {
  const source = "另一标的的股票代码为123456.SZ。";
  for (const messages of [
    [{ role: "tool", name: "execute_code", content: source }],
    [{ role: "tool", name: "lookup", content: { stdout: source } }],
    [{ role: "tool", name: "lookup", result: { text: source, stderr: "" } }],
    [{ role: "tool", name: "custom", arguments: { code: `print('${source}')` }, content: source }],
    [{ type: "function_call", name: "custom", call_id: "code-call", arguments: JSON.stringify({ code: `print('${source}')` }) },
      { type: "function_call_output", call_id: "code-call", output: source }],
    [{ role: "assistant", tool_calls: [{ id: "code-call", type: "function", function: { name: "custom", arguments: JSON.stringify({ code: `print('${source}')` }) } }] },
      { role: "tool", tool_call_id: "code-call", content: source }],
  ]) rejects(resolutionFixture(messages, source), "table_resolution_unsupported");
});
