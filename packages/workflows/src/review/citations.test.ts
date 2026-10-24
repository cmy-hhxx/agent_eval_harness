import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { evidenceSources, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { citationInventory, citationSourceParts } from "./citations.js";
import { attributionProfile } from "@eval/agents/attribution";
import { comparisonProfile } from "@eval/agents/comparison";
import { Ajv2020 } from "ajv/dist/2020.js";
import { bindTask } from "../comparison/binding.js";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

const audit = { viewedImages: [], traceReads: [] };
test("split source presentation retains dates, signs and escaped content at readable leaf coordinates", () => {
  const body = '标题: 抽样结果\n发布时间: 2024-02-03\n摘要: 变化率为-7%，标记为"暂定"，路径C:\\数据。';
  const raw = { messages: [{ type: "tool_result", output: [
    { text: "无关前文\n<referencable-result>\nID: 8\n" },
    { text: body },
    { text: "补充统计期为2024-01。\n</referencable-result>\n无关后文" },
  ] }, { role: "assistant", content: "引用[^8]" }] };
  const source = citationInventory(raw, evidenceInputId, 1).references[0].sources[0];
  const parts = citationSourceParts(raw, evidenceInputId, source);
  assert.deepEqual(parts.map(part => part.read_request.path), ["/output/1/text", "/output/2/text"]);
  assert.equal(parts[0].quote, body);
  assert.doesNotMatch(parts.map(part => part.quote).join(""), /无关|input_text/u);
  for (const part of parts) {
    assert.equal(resolveEvidence(raw, part, "answer", audit, "/evidence", evidenceInputId).quote, part.quote);
    const read = part.read_request, selected = selectEvidenceSource(evidenceSources(raw.messages[0]), read.path)!;
    assert.equal(selected.source.text.slice(read.offset, part.end_offset), part.quote);
  }
});

test("document groups bind repeated footnote fragments to declared exact URLs across typed leaves", () => {
  const annual = "http://issuer.example/annual.pdf", results = "http://issuer.example/results.pdf";
  const raw = { messages: [{ type: "function_call_output", output: [
    { text: "<referencable-result>\nID: 2\n" },
    { text: `标题: 年报\n溯源地址: ${annual} （权威网站）\n摘要: 第一片段。` },
    { text: "</referencable-result>\n<referencable-result>\nID: 7\n" },
    { text: `标题: 业绩\n溯源地址: ${results}\n摘要: 第二文档。` },
    { text: "</referencable-result>\n<referencable-result>\nID: 8\n" },
    { text: `标题: 年报\n溯源地址: ${annual}\n摘要: 第二片段。` },
    { text: "</referencable-result>" },
  ] }, { role: "assistant", content: "已引用来源[^2][^7][^8]。" }] };
  const inventory = citationInventory(raw, evidenceInputId, 1);
  assert.deepEqual(inventory.document_groups, [
    { url: annual, references: [{ format: "footnote", reference: "2" }, { format: "footnote", reference: "8" }] },
    { url: results, references: [{ format: "footnote", reference: "7" }] },
  ]);
  for (const reference of inventory.references) {
    assert.equal(reference.status, "resolved");
    const source = reference.sources[0];
    assert.equal(source.document_url, reference.reference === "7" ? results : annual);
    assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
  }
});

test("document grouping preserves ambiguity and raw URL identity without inferring independence or support", () => {
  const first = "https://issuer.example/paper.pdf#p1", second = "https://issuer.example/paper.pdf#p2";
  const raw = { messages: [
    { type: "tool_result", output: [
      { title: "片段一", serial_number: "abc1234", url: first, content: "事实一" },
      { title: "片段二", serial_number: "def5678", url: second, content: "事实二" },
      { title: "发生变化", serial_number: "abc1234", url: first, content: "另一版本" },
      { title: "未提供源地址", serial_number: "hij9012", content: "正文中的 https://unrelated.example 不提供源身份" },
    ] },
    { role: "assistant", content: '<trace ref="abc1234" /><trace ref="def5678" /><trace ref="hij9012" />' },
  ] };
  const result = citationInventory(raw, evidenceInputId, 1);
  assert.equal(result.references[0].status, "ambiguous");
  assert.deepEqual(result.document_groups.map(group => group.url), [first, second]);
  assert.equal(result.document_groups[0].references.length, 1);
  assert.equal(Object.hasOwn(result.references[2].sources[0], "document_url"), false);
  assert.equal(Object.hasOwn(result.document_groups[0], "independent"), false);
  assert.equal(Object.hasOwn(result.document_groups[0], "supports_sentence"), false);
});

test("missing or conflicting explicit footnote addresses remain unknown document identity", () => {
  const raw = { messages: [{ type: "tool_result", output: [
    "<referencable-result>\nID: 1\n摘要: 正文 https://body.example/page\n溯源地址: https://body.example/quoted-metadata\n</referencable-result>",
    "<referencable-result>\nID: 2\n溯源地址: https://one.example/page\n溯源地址: https://two.example/page\n</referencable-result>",
  ] }, { role: "assistant", content: "两个编号[^1][^2]" }] };
  const result = citationInventory(raw, evidenceInputId, 1);
  assert.deepEqual(result.document_groups, []);
  assert.equal(result.references.every(reference => reference.sources.every(source => !source.document_url)), true);
});

test("citation occurrences expose the original paragraph without inferring which adjacent clause the source supports", () => {
  const paragraph = '- **利率下降**：2019年3.25%；2020年2.50%–2.80% <trace anchor="jmxXFOm" /> <trace anchor="oRUPDls" />。\n' +
    '- **利息支出**：0.53亿元增至2.58亿元 <trace anchor="jmfi0hX" />。';
  const answer = "开头摘要。\n\n" + paragraph + "\n\n最后收束。";
  const raw = { messages: [
    { type: "tool_result", output: { action_id: "jmxXFOm", traceability: true, stdout: "2019年利率3.25%" } },
    { type: "tool_result", output: { action_id: "oRUPDls", traceability: true, stdout: "2020年利息支出2.58亿元" } },
    { type: "tool_result", output: { action_id: "jmfi0hX", traceability: true, stdout: "2020年利率2.50%–2.80%" } },
    { role: "assistant", content: answer },
  ] };
  const result = citationInventory(raw, evidenceInputId, 3);
  assert.deepEqual(result.references.map(ref => ref.status), ["resolved", "resolved", "resolved"]);
  for (const ref of result.references) {
    const occurrence = ref.occurrences[0];
    assert.equal(occurrence.context?.quote, paragraph);
    assert.equal(occurrence.quote, `<trace anchor="${ref.reference}" />`);
    assert.equal(resolveEvidence(raw, occurrence.context, "answer", audit, "/evidence", evidenceInputId).quote, paragraph);
    assert.equal(occurrence.context.read_request.path, "/content");
    assert.equal(occurrence.context.read_request.offset, 7);
    assert.equal(occurrence.context.end_offset, 7 + paragraph.length);
    assert.equal(Object.hasOwn(occurrence, "supports_sentence"), false);
  }
});

test("each occurrence retains its own CRLF paragraph and cannot borrow another content leaf", () => {
  const first = '😀第一句保留 "引号" 与\\路径[^14]。';
  const second = "第二段重复标记[^14]，来源仍未知。";
  const raw = { messages: [{ role: "assistant", content: [
    { text: "前段。\r\n \t\r\n" + first + "\r\n\r\n" + second },
    { text: "另一内容分片[^14]，不可拼接前一段。" },
  ] }] };
  const ref = citationInventory(raw, evidenceInputId, 0).references[0];
  assert.equal(ref.status, "unknown");
  assert.deepEqual(ref.sources, []);
  assert.deepEqual(ref.occurrences.map(item => item.context.quote), [first, second, "另一内容分片[^14]，不可拼接前一段。"]);
  assert.deepEqual(ref.occurrences.map(item => item.context.read_request.path), ["/content/0/text", "/content/0/text", "/content/1/text"]);
  assert.equal(new Set(ref.occurrences.map(item => item.evidence_id)).size, 3);
  for (const occurrence of ref.occurrences) {
    assert.equal(resolveEvidence(raw, occurrence.context, "answer", audit, "/evidence", evidenceInputId).quote, occurrence.context.quote);
    const read = occurrence.context.read_request;
    const selected = selectEvidenceSource(evidenceSources(raw.messages[0]), read.path)!;
    assert.equal(selected.source.text.slice(read.offset, occurrence.context.end_offset), occurrence.context.quote);
  }
});

test("long occurrence paragraphs retain complete evidence and expose bounded reads to the actual paragraph end", () => {
  const paragraph = "全文不能裁剪。".repeat(2500) + "声明[^7]尾句。";
  const raw = { messages: [{ role: "assistant", content: "前段。\n\n" + paragraph + "\n\n后段。" }] };
  const occurrence = citationInventory(raw, evidenceInputId, 0).references[0].occurrences[0];
  assert.equal(occurrence.context.quote, paragraph);
  assert.equal(occurrence.context.read_request.max_chars, 16000);
  assert.equal(occurrence.context.read_request.offset, 5);
  assert.equal(occurrence.context.end_offset, 5 + paragraph.length);
  assert.equal(resolveEvidence(raw, occurrence.context, "answer", audit, "/evidence", evidenceInputId).quote, paragraph);
  const selected = selectEvidenceSource(evidenceSources(raw.messages[0]), occurrence.context.read_request.path)!;
  let restored = "";
  for (let offset = occurrence.context.read_request.offset; offset < occurrence.context.end_offset; offset += 16000)
    restored += selected.source.text.slice(offset, Math.min(offset + 16000, occurrence.context.end_offset));
  assert.equal(restored, paragraph);
});

test("deferred answer paragraphs retain context previews and candidate-specific complete reads", () => {
  const inputId = randomUUID(), criteriaId = randomUUID();
  const source = "<referencable-result>\nID: 7\n完整来源正文。\n</referencable-result>";
  const paragraph = "待核对陈述。".repeat(3000) + "[^7]，另一分句。";
  const raw: RawInput = { messages: [{ role: "user", content: "核对陈述" },
    { type: "function_call_output", output: source }, { role: "assistant", content: paragraph }] };
  const candidate: Candidate = { batch_id: "b1", case_id: "citation-context", version: "a_fast", name: "A组Fast",
    input_id: inputId, trace_id: null, source: "fixture", line: 1, question: "核对陈述", final_index: 2,
    reference: null, llm: null, answer_timing: { first_token_seconds: null, first_answer_seconds: null,
      finish_seconds: 1, source_unit: "s", source_values: {}, source_fields: {} } };
  const criteriaTask: PlannedTask = { id: criteriaId, stage: "criteria", inputIds: { A: inputId }, dependencies: {},
    data: { stage: "criteria", candidates: { A: candidate }, reference: null } satisfies TaskData };
  const receipt: SubmissionReceipt = { taskId: criteriaId, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1,
    status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: inputId }, dependencies: { criteria: criteriaId },
    data: { stage: "attribution", candidates: { A: candidate }, reference: null } satisfies TaskData };
  const binding = bindTask(task, { [inputId]: raw }, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const original = citationInventory(raw, inputId, 2).references[0];
  const shown = (binding.modelInput!.answer as { citation_inventory: { references: {
    occurrences: { quote: string; reference: { evidence_id: string }; context: {
      quote_preview: string; has_more: boolean; reference: { evidence_id: string };
      read_request: { candidate: string; offset: number }; end_offset: number;
    } }[]; sources: { quote: string; origin: string; reference: { evidence_id: string }; read_request: { candidate: string } }[];
  }[] } }).citation_inventory.references[0];
  assert.equal(shown.occurrences[0].reference.evidence_id, original.occurrences[0].evidence_id);
  assert.equal(shown.occurrences[0].quote, "[^7]");
  const context = shown.occurrences[0].context;
  assert.equal(context.quote_preview, paragraph.slice(0, 200));
  assert.equal(context.has_more, true);
  assert.equal(context.reference.evidence_id, original.occurrences[0].context.evidence_id);
  assert.equal(context.read_request.candidate, "answer");
  assert.equal(context.read_request.offset, 0);
  assert.equal(context.end_offset, paragraph.length);
  assert.equal(resolveEvidence(raw, context.reference, "answer", audit, "/evidence", inputId).quote, paragraph);
  assert.equal(Object.hasOwn(context, "evidence_id"), false);
  assert.equal(Object.hasOwn(context, "quote"), false);
  assert.equal(shown.sources[0].quote, source);
  assert.equal(shown.sources[0].origin, "tool_return");
  assert.equal(shown.sources[0].read_request.candidate, "answer");
  assert.equal(shown.sources[0].reference.evidence_id, original.sources[0].evidence_id);
});

test("A footnotes index complete result blocks rather than tool-call or message counts", () => {
  const raw = { messages: [
    { type: "function_call", name: "Search", arguments: '{"fake":"<referencable-result>\\nID: 999\\n"}' },
    { type: "function_call_output", output: [
      { type: "input_text", text: "<referencable-result>\nID: 7\n" },
      { type: "input_text", text: "标题: 华润啤酒末期业绩\n整体啤酒销量约10,874,000千升，同比下降2.5%。" },
      { type: "input_text", text: "</referencable-result>" },
      { type: "input_text", text: "<referencable-result>\nID: 8\n年报同样披露10,874,000千升。\n</referencable-result>" },
    ] },
    { role: "assistant", content: "销量1087.4万千升[^7][^8]。" },
  ] };
  const result = citationInventory(raw, evidenceInputId, 2);
  assert.deepEqual(result.protocols, ["footnote"]);
  assert.deepEqual(result.references.map(item => [item.reference, item.status]), [["7", "resolved"], ["8", "resolved"]]);
  for (const ref of result.references) {
    assert.equal(ref.sources[0].origin, "tool_return");
    assert.match(ref.sources[0].quote, /10,874,000/u);
    assert.equal(ref.sources[0].end_offset - ref.sources[0].read_request.offset, ref.sources[0].quote.length);
    assert.ok(ref.sources[0].read_request.max_chars <= 16000);
    const read = ref.sources[0].read_request;
    const selected = selectEvidenceSource(evidenceSources(raw.messages[read.message_index]), read.path)!;
    assert.equal(selected.source.text.slice(selected.start + read.offset, selected.start + ref.sources[0].end_offset), ref.sources[0].quote);
    for (const item of [...ref.sources, ...ref.occurrences]) assert.equal(resolveEvidence(raw, item, "answer", audit, "/evidence", evidenceInputId).quote, item.quote);
  }
  assert.match(result.references[0].sources[0].evidence_id, new RegExp(`^ev_${evidenceInputId}_1_json_`, "u"));
  assert.equal(result.references[0].sources[0].read_request.path, "");
  assert.match(result.references[1].sources[0].evidence_id, new RegExp(`^ev_${evidenceInputId}_1_text_`, "u"));
});

test("A high source IDs and full surrounding text remain visible without deriving claim support", () => {
  const source = "<referencable-result>\nID: 14\n主力合约一般为一、五、九月。\n</referencable-result>";
  const raw = { messages: [{ type: "function_call_output", output: source },
    { role: "assistant", content: "主力按1/5/9月换月[^14]，另一个判断[^99]。" }] };
  const result = citationInventory(raw, evidenceInputId, 1);
  assert.equal(result.references[0].status, "resolved");
  assert.equal(result.references[0].sources[0].quote, source);
  assert.equal(result.references[1].status, "unknown");
  assert.deepEqual(result.references[1].sources, []);
  assert.equal(Object.hasOwn(result.references[0], "supports_sentence"), false);
});

test("case021 ID14 spans complete original content parts through its closing result marker", () => {
  const raw = { messages: [
    { type: "function_call_output", output: [
      { text: "<referencable-result>\nID: 14\n", type: "input_text" },
      { text: "标题: 甲醇期货的主力合约都是几月? - 上甲期弈AI\n溯源地址: https://www.shangjia.com/item/4994998\n发布时间: 2023-04-12 00:00:00\n摘要: 期货主力合约是有规律的，到期后会换月，所以投资者要清楚期货主力合约有几个，下面先来了解下甲醇期货的主力合约都是几月？\n甲醇期货的主力合约都是几月？\n甲醇的主力合约是指在郑州商品交易所中所交易的甲醇合约里成交量和持仓量最大的一个合约。一般是由每年的一、五、九这三个月份的合约为主力合约。\n举个例子，今年是2022年，那么主力合约就是2201、2205、2209合约。交易所也想把更多的合约给搞活约起来，但目前还是这三个为主力。\n一年有三个主力合约，分别是1月，5月和9月。\n不同的期货品种，有不同的主力合约的月份，根据这个期货品种的一些交割性格来制定的。甲醇期货是在郑州商品交易所，挂牌交易的大宗商品，它的主力合约每年是1月份5月份和9月份，一年有三个主力合约。\n", type: "input_text" },
      { text: "</referencable-result>", type: "input_text" },
    ] },
    { role: "assistant", content: "通常1/5/9月合约交替为主力[^14]。" },
  ] };
  const source = citationInventory(raw, evidenceInputId, 1).references[0].sources[0];
  assert.equal(source.origin, "tool_return");
  assert.ok(source.quote.startsWith("<referencable-result>\\nID: 14\\n"));
  assert.ok(source.quote.endsWith("</referencable-result>"));
  assert.match(source.quote, /一般是由每年的一、五、九这三个月份的合约为主力合约/u);
  assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
  const read = source.read_request;
  assert.equal(read.path, "");
  const selected = selectEvidenceSource(evidenceSources(raw.messages[read.message_index]), read.path)!;
  assert.equal(selected.source.text.slice(read.offset, source.end_offset), source.quote);
  assert.equal(read.max_chars, source.quote.length);
});

test("cross-leaf result bounds preserve escaped source text and exclude text outside the block", () => {
  const raw = { messages: [
    { role: "tool", output: [
      { "quoted/key~": '排除前缀 "before" \\path\n<referencable-result>\nID: 27\n' },
      { text: '正文保留 "quoted"、\\path，以及换行\n和中文。' },
      { v: '续行 "tail" \\end\n</referencable-result>排除后缀 "after"' },
    ] },
    { role: "assistant", content: "判断[^27]。" },
  ] };
  const source = citationInventory(raw, evidenceInputId, 1).references[0].sources[0];
  const rendered = evidenceSources(raw.messages[0]).find(item => item.kind === "json")!.text;
  const expectedStart = rendered.indexOf("<referencable-result>\\nID: 27\\n");
  const expectedEnd = rendered.indexOf("</referencable-result>") + "</referencable-result>".length;
  assert.equal(source.quote, rendered.slice(expectedStart, expectedEnd));
  assert.ok(source.quote.startsWith("<referencable-result>\\nID: 27\\n"));
  assert.ok(source.quote.endsWith("</referencable-result>"));
  assert.match(source.quote, /\\"quoted\\"/u);
  assert.ok(source.quote.includes("\\\\path"));
  assert.doesNotMatch(source.quote, /排除前缀|排除后缀/u);
  assert.equal(source.read_request.offset, expectedStart);
  assert.equal(source.end_offset, expectedEnd);
  assert.equal(source.read_request.max_chars, expectedEnd - expectedStart);
  assert.equal(source.origin, "tool_return");
  assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
  const read = source.read_request;
  const selected = selectEvidenceSource(evidenceSources(raw.messages[read.message_index]), read.path)!;
  assert.equal(selected.source.text.slice(read.offset, source.end_offset), source.quote);
});

test("duplicate IDs retain all actual source blocks and cannot silently choose a source", () => {
  const raw = { messages: [
    { role: "tool", content: "<referencable-result>\nID: 1\n甲\n</referencable-result>" },
    { role: "tool", content: "<referencable-result>\nID: 1\n乙\n</referencable-result>" },
    { role: "assistant", content: "结论[^1][^1]" },
  ] };
  const ref = citationInventory(raw, evidenceInputId, 2).references[0];
  assert.equal(ref.status, "ambiguous");
  assert.equal(ref.sources.length, 2);
  assert.equal(ref.occurrences.length, 2);
});

test("B financial IDs are indexed from the actual renderer projection, with raw facts kept separate", () => {
  const block = "finquery_result:\nserial_number: RSTY3kK\nquery: 行业ETF的ROE\nrow_count: 108\ncol_count: 4\n\ndatas:\n|基金代码|ROE|\n|---|---|\n|510630.SH|27.97773|";
  const answer = 'ROE为27.98%<trace ref="RSTY3kK"/>，其他< trace />。';
  const raw = { messages: [
    { type: "llm_turn", input_messages: [{ role: "user", content: '{"serial_number":"PLANNER","title":"示例","summary":"不是最终材料"}' }] },
    { type: "tool_result", name: "finquery", output: { query: "行业ETF的ROE", datas: [{ ROE: 27.97773 }] } },
    { type: "llm_turn", input_messages: [{ role: "system", content: '{"serial_number":"EXAMPLE","title":"示例","summary":"不是数据"}' },
      { role: "user", content: "你取到的金融数据：\n" + block }], output: [{ role: "assistant", content: answer }] },
    { role: "assistant", type: "final_answer", content: answer },
  ] };
  const result = citationInventory(raw, evidenceInputId, 3);
  const ref = result.references[0];
  assert.deepEqual(result.protocols, ["trace"]);
  assert.equal(ref.status, "resolved");
  assert.equal(ref.sources[0].origin, "model_visible");
  assert.equal(ref.sources[0].message_index, 2);
  assert.equal(ref.sources[0].quote, block);
  assert.equal(ref.sources[0].read_request.path, "/input_messages/1/content");
  assert.equal(resolveEvidence(raw, ref.sources[0], "answer", audit, "/evidence", evidenceInputId).quote, block);
});

test("B source items use exact serial_number/ref fields, not uid/id aliases or final prose", () => {
  const answer = '订单和日产变化<trace ref="ngMcZlj"/><trace ref="qKg5e1G"/>，无源<trace ref="WRONGID"/>。';
  const raw = { messages: [
    { type: "tool_result", output: { items: [{ ref: "ngMcZlj", title: "供应链研报", summary: "日产从100台提升至200台。", uid: "WRONGID" }] } },
    { type: "llm_turn", input_messages: { messages: [{ role: "tool", content: JSON.stringify({ items: [
      { serial_number: "qKg5e1G", title: "基地与产能", summary: "订单积压超6000台。" },
    ] }) }] }, output: [{ role: "assistant", content: answer }] },
    { role: "assistant", content: answer },
  ] };
  const refs = citationInventory(raw, evidenceInputId, 2).references;
  assert.deepEqual(refs.map(ref => ref.status), ["resolved", "resolved", "unknown"]);
  assert.equal(refs[0].sources[0].origin, "tool_return");
  assert.match(refs[0].sources[0].quote, /100台提升至200台/u);
  assert.doesNotMatch(refs[0].sources[0].quote, /6000/u);
  assert.equal(refs[1].sources[0].origin, "model_visible");
  assert.match(refs[1].sources[0].quote, /6000/u);
});

test("a source after the final answer and malformed result blocks cannot resolve a final reference", () => {
  const raw = { messages: [
    { role: "tool", content: "<referencable-result>\nID: 1\n未闭合" },
    { role: "assistant", content: "判断[^1][^2]" },
    { role: "tool", content: "<referencable-result>\nID: 2\n晚到\n</referencable-result>" },
  ] };
  assert.deepEqual(citationInventory(raw, evidenceInputId, 1).references.map(ref => ref.status), ["unknown", "unknown"]);
});

test("model-visible source blocks exclude user questions, history and metadata after the results", () => {
  const current = "finquery_result:\nserial_number: RSTY3kK\nquery: 行业ETF\nrow_count: 108\n\ndatas:\n|代码|值|\n|---|---|\n|510630.SH|27.97773|";
  const literal = '{"serial_number":"NOTREAL","query":"示例","datas":[12]}';
  const answer = '<trace ref="RSTY3kK"/><trace ref="NOTREAL"/>';
  const raw = { messages: [{ type: "llm_turn", input_messages: [{ role: "user", content:
    literal + "\n你取到的金融数据：\n" + current + "\n\n你调用客服工具拿到的内容：\n用户 KYC / 记忆信息：\n" + literal }],
    output: [{ role: "assistant", content: answer }] },
  { role: "assistant", content: answer }] };
  const refs = citationInventory(raw, evidenceInputId, 1).references;
  assert.equal(refs[0].status, "resolved");
  assert.equal(refs[0].sources[0].quote.trim(), current);
  assert.doesNotMatch(refs[0].sources[0].quote, /KYC|NOTREAL/u);
  assert.equal(refs[1].status, "unknown");
});

test("model-visible references use the actual answer context before a later independent planner", () => {
  const answer = '实际最终回答<trace ref="AbCd123"/>';
  const source = '{"serial_number":"AbCd123","title":"实际回答来源","summary":"真实正文"}';
  const raw = { messages: [
    { type: "llm_turn", input_messages: { messages: [{ role: "user", content: "你通过网络搜索查到的内容：\n" + source }] },
      output: [{ role: "assistant", content: answer }] },
    { type: "llm_turn", input_messages: [{ role: "user", content:
      '你通过网络搜索查到的内容：\n{"serial_number":"AbCd123","title":"独立规划来源","summary":"另一个任务"}' }],
      output: [{ role: "assistant", content: "后续独立规划" }] },
    { role: "assistant", content: answer },
  ] };
  const ref = citationInventory(raw, evidenceInputId, 2).references[0];
  assert.equal(ref.status, "resolved");
  assert.equal(ref.sources.length, 1);
  assert.equal(ref.sources[0].message_index, 0);
  assert.equal(ref.sources[0].read_request.path, "/input_messages/messages/0/content");
  assert.equal(ref.sources[0].quote, source);
  assert.equal(resolveEvidence(raw, ref.sources[0], "answer", audit, "/evidence", evidenceInputId).quote, source);
});

test("an unanchored final answer cannot acquire IDs from the last planner context", () => {
  const raw = { messages: [
    { type: "llm_turn", input_messages: [{ role: "user", content:
      '你通过网络搜索查到的内容：\n{"serial_number":"AbCd123","title":"独立规划来源","summary":"另一个任务"}' }],
      output: [{ role: "assistant", content: "独立规划" }] },
    { role: "assistant", content: '无回答上下文<trace ref="AbCd123"/>' },
  ] };
  const result = citationInventory(raw, evidenceInputId, 1);
  assert.deepEqual(result.protocols, []);
  assert.equal(result.references[0].status, "unknown");
  assert.deepEqual(result.references[0].sources, []);
});

test("case01868 action anchors index original traceable shell results and the actual answer context", () => {
  const outputs = [
    { action_id: "jmxXFOm", exit_code: 0, stderr: "", stdout: "3 个月至 1 年内                   4,000,000,000.00              3.25", traceability: 1 },
    { action_id: "oRUPDls", exit_code: 0, stderr: "", stdout: "11369:      转融通融入资金                      10,000,000,000.00   4,000,000,000.00", traceability: 1 },
    { action_id: "jmfi0hX", exit_code: 0, stderr: "", stdout: "3 个月至 1 年内                   10,000,000,000.00          2.50-2.80", traceability: 1 },
  ];
  const answer = '2019年末利率3.25%，2020年末利率2.50%–2.80%<trace anchor="jmxXFOm" /> <trace anchor="oRUPDls" />，利息支出变化<trace anchor="jmfi0hX" />。';
  const raw = { messages: [
    ...outputs.map(output => ({ type: "tool_result", name: "shell", output })),
    { type: "llm_turn", input_messages: { messages: outputs.map(output => ({ role: "tool", content: JSON.stringify({ ...output, traceability: true }) })) },
      output: [{ role: "assistant", content: answer }] },
    { role: "assistant", content: answer },
  ] };
  const result = citationInventory(raw, evidenceInputId, 4);
  assert.deepEqual(result.references.map(ref => [ref.reference, ref.status]),
    [["jmxXFOm", "resolved"], ["oRUPDls", "resolved"], ["jmfi0hX", "resolved"]]);
  for (const ref of result.references) {
    assert.deepEqual(ref.sources.map(source => source.origin), ["tool_return", "model_visible"]);
    assert.equal(ref.sources[0].read_request.path, "");
    assert.equal(ref.occurrences[0].quote, `<trace anchor="${ref.reference}" />`);
    for (const source of ref.sources) {
      assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
      const selected = selectEvidenceSource(evidenceSources(raw.messages[source.message_index]), source.read_request.path)!;
      assert.equal(selected.source.text.slice(selected.start + source.read_request.offset,
        selected.start + source.end_offset), source.quote);
    }
  }
  // Source existence never asserts that every clause associated with an anchor is supported.
  assert.doesNotMatch(result.references[1].sources[0].quote, /2\.50-2\.80/u);
  assert.equal(Object.hasOwn(result.references[1], "supports_sentence"), false);
});

test("case04748 action anchors retain full data and are distinct from search refs", () => {
  const answer = '营收与利润<trace anchor="RtPAcSq" /><trace ref="RtPAcSq"/>；季度表<trace anchor="l8bGl21" />。';
  const action = { traceability: true, action_id: "l8bGl21", stdout:
    "单季度_营业收入[20260630] = 72.631 亿\n单季度_归母净利润[20260630] = 6.568 亿\n单季度_销售毛利率[20260630] = 25.26 %" };
  const raw = { messages: [
    { type: "tool_result", name: "shell", output: { action_id: "RtPAcSq", traceability: 1, stdout: '{"status":"ok","item_count":3}' } },
    { type: "tool_result", output: { ref: "RtPAcSq", title: "独立搜索来源", summary: "另一事实" } },
    { type: "llm_turn", input_messages: { messages: [
      { role: "system", content: '{"action_id":"FAKE123","traceability":true,"stdout":"指令示例"}' },
      { role: "tool", content: JSON.stringify(action) },
    ] }, output: [{ role: "assistant", content: answer }] },
    { role: "assistant", content: answer },
  ] };
  const refs = citationInventory(raw, evidenceInputId, 3).references;
  assert.equal(refs.length, 3);
  assert.equal(refs[0].sources[0].message_index, 0);
  assert.match(refs[0].sources[0].quote, /item_count/u);
  assert.equal(refs[1].sources[0].message_index, 1);
  assert.match(refs[1].sources[0].quote, /独立搜索来源/u);
  assert.equal(refs[2].sources[0].origin, "model_visible");
  assert.match(refs[2].sources[0].quote, /72\.631/u);
  assert.match(refs[2].sources[0].quote, /25\.26/u);
  for (const ref of refs) assert.equal(ref.status, "resolved");
});

test("action anchors require an actual traceable action, not a ref alias or instruction example", () => {
  const answer = '<trace anchor="AbCd123"/><trace ref="XyZa456"/><trace anchor="FAKE123"/><trace anchor="NOPE123"/>';
  const raw = { messages: [
    { type: "tool_result", output: { ref: "AbCd123", title: "搜索来源", summary: "只定义ref" } },
    { type: "tool_result", output: { action_id: "XyZa456", traceability: true, stdout: "只定义anchor" } },
    { type: "tool_result", output: { action_id: "NOPE123", traceability: false, stdout: "不可追溯" } },
    { type: "llm_turn", input_messages: [{ role: "system", content: '{"action_id":"FAKE123","traceability":true,"stdout":"指令示例"}' }],
      output: [{ role: "assistant", content: answer }] },
    { role: "assistant", content: answer },
  ] };
  assert.deepEqual(citationInventory(raw, evidenceInputId, 4).references.map(ref => ref.status),
    ["unknown", "unknown", "unknown", "unknown"]);
});

test("case01868 vis-html references locate the actual shell resource and its complete renderer wrapper", () => {
  const id = "html-df7addbd-8cdd-4889-b798-a29a1f6fc90f";
  const stdout = `{"type":"vis-html","id":"${id}"}`;
  const wrapper = { traceability: true, action_id: "pd5ClTJ", stdout, stderr: "", exit_code: 0 };
  const projected = JSON.stringify(wrapper);
  const answer = `<vis-html ref="${id}"/>`;
  const messages: Record<string, unknown>[] = Array.from({ length: 65 }, () => ({}));
  messages[58] = { type: "tool_call", name: "view_skill", input: { name: "data-visualizer" } };
  messages[59] = { type: "tool_result", name: "view_skill", output: `Example:\n${stdout}` };
  messages[61] = { type: "tool_call", name: "shell", input: { command: "node /opt/skills-wencai/data-visualizer/routes/viz-standard-chart/workflow.js render-data --spec '{}'" } };
  messages[62] = { type: "tool_result", name: "shell", output: wrapper };
  messages[63] = { type: "llm_turn", input_messages: { messages: [{ role: "tool", content: projected }] },
    output: [{ role: "assistant", content: answer }] };
  messages[64] = { type: "final_answer", role: "assistant", content: answer };
  const raw = { messages };
  const result = citationInventory(raw, evidenceInputId, 64);
  const ref = result.references[0];
  assert.equal(ref?.format, "vis-html");
  assert.equal(ref.status, "resolved");
  assert.equal(ref.reference, id);
  assert.deepEqual(ref.sources.map(source => [source.message_index, source.origin, source.quote]),
    [[62, "tool_return", stdout], [63, "model_visible", projected]]);
  assert.deepEqual(ref.sources[0].read_request, { message_index: 62, path: "/output/stdout", offset: 0, max_chars: 68 });
  assert.equal(ref.sources[0].end_offset, 68);
  assert.equal(ref.sources[0].evidence_id, `ev_${evidenceInputId}_62_text_0_68_/output/stdout`);
  for (const source of ref.sources) {
    assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
    const selected = selectEvidenceSource(evidenceSources(raw.messages[source.message_index]), source.read_request.path)!;
    assert.equal(selected.source.text.slice(selected.start + source.read_request.offset,
      selected.start + source.end_offset), source.quote);
  }
  assert.equal(Object.hasOwn(ref, "rendered"), false);
  assert.equal(Object.hasOwn(ref, "supports_sentence"), false);
});

test("visual sources parse complete multiple JSON resources, arrays and stdout envelopes without fabricating coordinates", () => {
  const first = '{"type":"vis-html","id":"html-one"}';
  const second = '{\n "type":"vis-html", "id":"html-two", "title":"escaped \\\"quote\\\""\n}';
  const documents = "  " + first + "\n\n" + second + "  ";
  const wrapped = JSON.stringify({ stdout: documents, exit_code: 0 });
  const answer = '<vis-html ref="html-one"/><vis-html ref="html-two"/><vis-html ref="html-three"/><vis-html ref="html-four"/>';
  const raw = { messages: [
    { type: "tool_result", name: "shell", output: { stdout: documents } },
    { type: "tool_result", output: { resources: [{ type: "vis-html", id: "html-three" }] } },
    { type: "tool_result", output: '[{"type":"vis-html","id":"html-four"}]' },
    { type: "llm_turn", input_messages: [{ role: "tool", content: wrapped }], output: [{ role: "assistant", content: answer }] },
    { type: "final_answer", role: "assistant", content: answer },
  ] };
  const refs = citationInventory(raw, evidenceInputId, 4).references;
  assert.deepEqual(refs.map(ref => ref.status), ["resolved", "resolved", "resolved", "resolved"]);
  assert.equal(refs[0].sources[0].quote, first);
  assert.equal(refs[0].sources[0].read_request.offset, 2);
  assert.equal(refs[1].sources[0].quote, second);
  assert.equal(refs[1].sources[0].read_request.offset, 2 + first.length + 2);
  assert.equal(refs[0].sources[1].quote, wrapped);
  assert.equal(refs[1].sources[1].quote, wrapped);
  assert.equal(refs[2].sources[0].read_request.path, "");
  assert.match(refs[2].sources[0].quote, /"type": "vis-html"/u);
  for (const ref of refs) for (const source of ref.sources) {
    assert.equal(resolveEvidence(raw, source, "answer", audit, "/evidence", evidenceInputId).quote, source.quote);
    const selected = selectEvidenceSource(evidenceSources(raw.messages[source.message_index]), source.read_request.path)!;
    assert.equal(selected.source.text.slice(selected.start + source.read_request.offset,
      selected.start + source.end_offset), source.quote);
  }
});

test("visual directory excludes skill examples, input arguments, incomplete output and unrelated planner material", () => {
  const resource = (id: string) => JSON.stringify({ type: "vis-html", id });
  const answer = ["html-doc", "html-example", "html-system", "html-planner", "html-call", "html-late", "html-bad"].map(id => `<vis-html ref="${id}"/>`).join("");
  const raw = { messages: [
    { type: "tool_result", name: "view_skill", output: "示例资源：\n```json\n" + resource("html-doc") + "\n```" },
    { type: "tool_result", name: "view_skill", output: { example: { type: "vis-html", id: "html-example" } } },
    { type: "tool_call", name: "shell", input: { stdout: resource("html-call") } },
    { type: "tool_result", name: "shell", output: { stdout: resource("html-bad") + "\n{bad" } },
    { type: "llm_turn", input_messages: [{ role: "system", content: resource("html-system") }], output: [{ role: "assistant", content: answer }] },
    { type: "llm_turn", input_messages: [{ role: "tool", content: resource("html-planner") }], output: [{ role: "assistant", content: "独立规划" }] },
    { type: "final_answer", role: "assistant", content: answer },
    { type: "tool_result", output: resource("html-late") },
  ] };
  const result = citationInventory(raw, evidenceInputId, 6);
  assert.deepEqual(result.protocols, []);
  assert.deepEqual(result.references.map(ref => ref.status), Array(7).fill("unknown"));
  assert.ok(result.references.every(ref => ref.sources.length === 0));
});

test("both current agent request schemas accept the visual inventory with complete original coordinates", () => {
  const raw = { messages: [
    { type: "tool_result", output: { stdout: '{"type":"vis-html","id":"html-chart"}' } },
    { type: "final_answer", role: "assistant", content: '<vis-html ref="html-chart"/>' },
  ] };
  const inventory = citationInventory(raw, evidenceInputId, 1);
  for (const profile of [attributionProfile, comparisonProfile]) {
    const validate = new Ajv2020({ strict: false }).compile({
      $defs: profile.requestSchema!.$defs, $ref: "#/$defs/citationInventory",
    });
    assert.equal(validate(inventory), true, JSON.stringify(validate.errors));
    const missingContext = { ...inventory, references: inventory.references.map(ref => ({ ...ref,
      occurrences: ref.occurrences.map(({ context: _context, ...marker }) => marker),
    })) };
    assert.equal(validate(missingContext), false, "each marker requires its actual original context");
  }
});

test("identical complete returned sources retain every location without becoming an ambiguous footnote", () => {
  const source = "<referencable-result>\nID: 13\n标题: 原网页\n溯源地址: https://example.test/report\n发布时间: 2026-09-24 12:00\n摘要: 完整相同来源正文。\n</referencable-result>";
  const raw = { messages: [{ type: "function_call_output", output: source },
    { type: "function_call_output", output: source }, { role: "assistant", content: "来源中的陈述[^13]。" }] };
  const reference = citationInventory(raw, evidenceInputId, 2).references[0];
  assert.equal(reference.status, "resolved");
  assert.equal(reference.sources.length, 2);
  assert.notEqual(reference.sources[0].evidence_id, reference.sources[1].evidence_id);
  for (const evidence of reference.sources)
    assert.equal(resolveEvidence(raw, evidence, "answer", audit, "/evidence", evidenceInputId).quote, source);
  raw.messages[1].output = source.replace("完整相同来源正文", "修订过的来源正文");
  assert.equal(citationInventory(raw, evidenceInputId, 2).references[0].status, "ambiguous", "same URL is insufficient when the actual full body differs");
});
