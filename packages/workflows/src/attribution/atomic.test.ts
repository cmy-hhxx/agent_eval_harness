import test from "node:test";
import assert from "node:assert/strict";
import { adapt, normalizeInput } from "@eval/workflows/inputs";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { parseEvidenceCoordinates } from "@eval/tools";
import { validateEvidenceBankSources } from "@eval/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRegistry } from "@eval/tools";
import { bindAttribution, planAttributionUnit, type AttributionTaskData } from "./index.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

const readRequestSchema = new Ajv2020({ strict: false }).compile(createRegistry().select(["read_trace"])[0]!.inputSchema);
function validateReadRequests(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["read_request", "next_request"].includes(key) && item && typeof item === "object" && "message_index" in item)
      assert(readRequestSchema(item), `generated read request must be callable verbatim: ${JSON.stringify(readRequestSchema.errors)}`);
    else validateReadRequests(item);
  }
}

test("model review entrypoints use message coordinates and retain public output beside private inputs", () => {
  const raw = { batch_id: "batch", case_id: "model-scene", messages: [
    { type: "user_question", content: "核对收入。" },
    { type: "llm_turn", name: "llm-call-1", input_messages: [{ role: "system", content: "PRIVATE_SENTINEL" },
      { role: "user", content: "核对收入。" }], output: [{ role: "assistant", content: "收入为10亿元。" }] },
    { type: "final_answer", content: "收入为10亿元。" } ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).reviewScope!.message_indices.includes(1))!;
  const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  validateReadRequests(binding.modelInput!.answer);
  assert.equal(binding.modelInput!.review_kind, "model_turn");
  assert.equal(binding.modelInput!.task_analysis, undefined, "a local model transformation does not inherit the final-delivery checklist");
  assert(JSON.stringify(binding.modelInput).includes("context_sources"));
  const material = JSON.stringify(binding.modelInput!.answer);
  assert(material.includes("收入为10亿元。"));
  assert(material.includes("核对收入。"));
  assert(!Object.hasOwn(binding.modelInput!.answer as object, "final_message_index"), "a local transformation does not direct the reviewer to the final answer");
  assert(!material.includes("PRIVATE_SENTINEL"));
  assert.deepEqual(Object.keys(binding.request.input).sort(), ["component", "review_scope", "trace_index"],
    "a component submission must not retain the full global business-chain payload");
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  assert(prepared.evidenceBank.some(id => parseEvidenceCoordinates(id)?.message_index === 1));
  const repeated = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  assert.equal(repeated.request.sources.answer.value, binding.request.sources.answer.value);
  assert.deepEqual(repeated.modelInput, binding.modelInput);
  assert.equal(repeated.preparationTimings!.directoryMs, 0, "shared immutable trace facts are not rebuilt");
  assert(!Object.hasOwn(binding.materialNavigation!.answer as object, "boundaries"));
  const isolated = bindAttribution(task, { [candidate.input_id]: normalizeInput(structuredClone(raw)) }, {});
  assert.notEqual(isolated.request.sources.answer.value, binding.request.sources.answer.value,
    "another loaded source object never inherits this trace's cached facts");
});

test("a model turn receives its actual public input once with exact continuation beyond the local budget", () => {
  const context = "原始上下文。".repeat(3000);
  const raw = { batch_id: "batch", case_id: "local-context", messages: [
    { type: "user_question", content: "核对本次处理。" },
    { type: "llm_turn", name: "planner", input_messages: [{ role: "system", content: "PRIVATE_INPUT" },
      { role: "user", content: context }, { role: "user", content: "" }], output: [{ role: "assistant", content: "处理结果。" }] },
    { type: "final_answer", content: "最终回答。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).reviewScope!.message_indices.includes(1))!;
  const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  const answer = binding.modelInput!.answer as { component_scene: { entries: { part: string; quote: string; reference: { evidence_id: string } }[];
    context_sources: { path: string; read_request?: { offset: number; max_chars: number } }[] } };
  const entries = answer.component_scene.entries.filter(entry => entry.part === "input_messages");
  assert(entries.length > 1);
  const shown = entries.map(entry => entry.quote).join("");
  assert(context.startsWith(shown));
  assert.equal(answer.component_scene.entries.reduce((sum, entry) => sum + entry.quote.length, 0), 12000);
  assert.equal(answer.component_scene.context_sources.find(source => source.path === "/input_messages/1/content")!.read_request!.offset, shown.length);
  assert(!JSON.stringify(binding.modelInput).includes("PRIVATE_INPUT"));
  assert(!JSON.stringify(binding.modelInput).includes("最终回答。"));
  validateReadRequests(binding.modelInput!.answer);
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  validateEvidenceBankSources(prepared.evidenceBank, new Map([[candidate.input_id, normalizeInput(raw)]]));
});

test("a mixed-media answer retains its image entrypoint after text scope splitting", () => {
  const raw = { batch_id: "batch", case_id: "image", messages: [
    { type: "user_question", content: "请画出函数图像。" },
    { type: "final_answer", content: [{ type: "output_text", text: "函数图像如下。" },
      { type: "output_image", image_url: "data:image/png;base64,AA==" }] } ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component")!;
  const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  assert.equal((binding.modelInput!.answer as { final_images: { image_count: number } }).final_images.image_count, 1);
  assert.equal((binding.materialNavigation!.answer as { final_message_index: number }).final_message_index, 1);
});

test("local calls retain proven argument links without inventing links to nearby model turns", () => {
  const raw = { batch_id: "batch", case_id: "arguments", messages: [
    { type: "user_question", content: "查询收入。" },
    { type: "llm_turn", name: "planner", parent_span: "call-parent", input_messages: [{ role: "user", content: "查询收入。" }],
      output: [{ role: "assistant", tool_calls: [{ id: "query", function: { name: "finquery", arguments: '{"query":"收入"}' } }] }] },
    { type: "tool_call", name: "finquery", parent_span: "call-parent", call_id: "query", input: { query: "收入" } },
    { type: "tool_result", name: "finquery", call_id: "query", output: "收入10亿元。" },
    { type: "final_answer", content: "收入10亿元。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).reviewScope!.message_indices.includes(2))!;
  const links = (value: typeof raw) => (bindAttribution(task, { [candidate.input_id]: normalizeInput(value) }, {}).modelInput!.answer as
    { direct_call_links: unknown[] }).direct_call_links;
  assert.deepEqual(links(raw), [{ request: { message_index: 2, path: "/input" },
    generated_arguments: { message_index: 1, path: "/output/0/tool_calls/0/function/arguments" } }]);
  const other = structuredClone(raw);
  other.messages[2]!.parent_span = "different-parent";
  assert.deepEqual(links(other), []);
});

test("a mixed-media tool return registers text leaves without citing image placeholders", () => {
  const raw = { batch_id: "batch", case_id: "tool-image", messages: [
    { type: "user_question", content: "画图并返回数据。" },
    { type: "tool_call", name: "CodeInterpreter", call_id: "plot", input: { code: "plot()" } },
    { type: "tool_result", name: "CodeInterpreter", call_id: "plot", output: [
      { type: "input_text", text: "图表生成成功，数据有三行。" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" } ] },
    { type: "final_answer", content: "已绘制图表。" } ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).reviewScope!.message_indices.includes(2))!;
  const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  validateEvidenceBankSources(prepared.evidenceBank, new Map([[candidate.input_id, binding.request.sources.answer!.value]]));
  assert(prepared.evidenceBank.some(id => { const point = parseEvidenceCoordinates(id)!;
    return point.message_index === 2 && point.kind === "text" && point.path === "/output/0/text"; }));
  assert(JSON.stringify(binding.modelInput).includes("图表生成成功，数据有三行。"));
  assert.equal(binding.modelInput!.review_kind, "tool_call");
  const scene = (binding.modelInput!.answer as { component_scene: { images: unknown[]; partial: boolean } }).component_scene;
  assert.equal(scene.images.length, 1);
  assert.equal(scene.partial, false);
});

test("a call exposes decoded text once and precise continuations for all material beyond the first view", () => {
  const raw = { batch_id: "batch", case_id: "long-call", messages: [
    { type: "user_question", content: "核对结果。" },
    { type: "tool_call", name: "search", call_id: "q", input: { query: "结果" } },
    { type: "tool_result", name: "search", call_id: "q", output: [
      { type: "input_text", text: "第一份原文。".repeat(1200) },
      { type: "input_text", text: "第二份原文。".repeat(1200) },
      { type: "input_text", text: "第三份原文。" } ] },
    { type: "final_answer", content: "结果已返回。" } ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).reviewScope!.message_indices.includes(2))!;
  const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  const scene = (binding.modelInput!.answer as { component_scene: { partial: boolean; entries: { quote: string }[];
    unread: { read_request: { path: string; offset: number }; end_offset: number }[] } }).component_scene;
  validateReadRequests(binding.modelInput!.answer);
  assert(scene.partial);
  assert(scene.entries.reduce((chars, item) => chars + item.quote.length, 0) <= 12000);
  assert.deepEqual(scene.unread.map(item => item.read_request.path), ["/output/0/text", "/output/1/text", "/output/2/text"]);
  assert.equal(scene.unread[2]!.read_request.offset, 0);
  assert(!JSON.stringify(scene.entries).includes('"type":"input_text"'));
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  validateEvidenceBankSources(prepared.evidenceBank, new Map([[candidate.input_id, binding.request.sources.answer!.value]]));
});

test("partial trace aggregation preserves confirmed problems without turning an unreviewed range into a defect", () => {
  const raw = { batch_id: "batch", case_id: "partial", messages: [
    { type: "user_question", content: "计算一加一。" }, { type: "final_answer", content: "2" } ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const tasks = planAttributionUnit(candidate).tasks;
  const trace = tasks.find(task => task.stage === "attribution-trace")!;
  assert.deepEqual(trace.settledDependencies, ["component0"]);
  const binding = bindAttribution(trace, { [candidate.input_id]: normalizeInput(raw) }, {});
  const registry = new AgentRegistry([attributionAgent]);
  const result = registry.resolve(binding, { summary: "回答给出2。" }, emptyAudit()) as { summary: string; problem: unknown[] };
  assert.deepEqual(result.problem, [], "a failed review is not an error in the answer");
  assert.match(result.summary, /1 项审查未完成/);
  registry.validate(binding, result, emptyAudit());
});

test("one trace goal keeps repeated component work and the complete final answer in focused reviews", () => {
  const messages = [{ type: "user_question", content: "核查两家公司收入及风险。" },
    { type: "tool_call", name: "finquery", call_id: "one", input: { query: "公司一收入" } },
    { type: "tool_result", name: "finquery", call_id: "one", output: { rows: [{ revenue: 10 }] } },
    { type: "tool_call", name: "finquery", call_id: "two", input: { query: "公司二收入" } },
    { type: "tool_result", name: "finquery", call_id: "two", output: { rows: [] } },
    { type: "final_answer", content: "## 公司一\n\n" + "公司一收入为10，需核查单位。".repeat(80) +
      "\n\n## 公司二\n\n" + "公司二没有返回收入，不能推断为零。".repeat(80) }];
  const raw = { batch_id: "batch", case_id: "atomic", messages };
  const candidate = adapt(raw,
    { id: "b_fast", name: "B Fast", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const tasks = planAttributionUnit(candidate).tasks;
  const components = tasks.filter(task => task.stage === "attribution-component");
  const queryTasks = components.filter(task => (task.data as AttributionTaskData).component === "finquery 取数服务");
  assert.equal(queryTasks.length, 1, "related queries supporting the same comparison belong to one review");
  assert.deepEqual((queryTasks[0]!.data as AttributionTaskData).reviewScope!.message_indices, [1, 2, 3, 4]);
  assert.equal(components.filter(task => (task.data as AttributionTaskData).component === "终稿生成轮").length, 1,
    "headings and character counts alone do not establish independent review goals");
  assert.equal(Object.keys(tasks.find(task => task.stage === "attribution-trace")!.dependencies).length, components.length,
    "trace aggregation must wait for every atomic review");
  const resumed = planAttributionUnit(candidate, { previousTasks: tasks });
  assert.deepEqual(resumed.tasks.map(task => task.id), tasks.map(task => task.id), "resume preserves every atomic identity");
  const finalTasks = components.filter(task => (task.data as AttributionTaskData).component === "终稿生成轮");
  const finalText = messages.at(-1)!.content!;
  const ranges = finalTasks.flatMap(task => (task.data as AttributionTaskData).reviewScope!.final_ranges!);
  assert.equal(ranges.map(range => finalText.slice(range.start, range.end)).join(""),
    finalText, "every final-answer byte belongs to the review, including separators");
  for (let index = 1; index < ranges.length; index++) assert(ranges[index]!.start >= ranges[index - 1]!.end);
  const registry = new AgentRegistry([attributionAgent]);
  for (const task of finalTasks) {
    const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
    assert.equal(binding.modelInput!.review_kind, "final_section");
    assert(binding.modelInput!.task_analysis);
    validateReadRequests(binding.modelInput!.answer);
    assert.equal((binding.modelInput!.answer as { component_scene?: unknown }).component_scene, undefined);
    assert.equal((binding.modelInput!.answer as { final_context: { partial: boolean } }).final_context.partial, true);
    const prepared = registry.prepare(binding), scope = (task.data as AttributionTaskData).reviewScope!;
    const evidence = (binding.modelInput!.answer as { final_evidence: { quote: string; reference: { evidence_id: string } }[] }).final_evidence;
    for (const entry of evidence) {
      const point = parseEvidenceCoordinates(entry.reference.evidence_id)!;
      assert(point.kind === "text");
      assert(scope.final_ranges!.some(range => range.path === point.path && range.start <= point.start && range.end >= point.end));
      assert.equal(entry.quote, finalText.slice(point.start, point.end));
      assert(entry.quote.length <= 400);
      assert(prepared.evidenceBank.includes(entry.reference.evidence_id), "shown final evidence is directly submittable");
    }
  }
});

test("repeated reasoning and skill aliases merge only within the existing component ownership", () => {
  const raw = { batch_id: "batch", case_id: "component-goal", messages: [
    { type: "user_question", content: "核对同一份计算结果。" },
    { type: "llm_turn", name: "llm-call-0", output: [{ role: "assistant", content: "先读取说明。" }] },
    { type: "tool_call", name: "view_skill", input: { name: "analysis" } },
    { type: "tool_result", name: "view_skill", output: "读取分析文件。" },
    { type: "tool_call", name: "read_file", input: { path: "analysis.md" } },
    { type: "tool_result", name: "read_file", output: "计算说明。" },
    { type: "llm_turn", name: "llm-call-1", output: [{ role: "assistant", content: "按说明计算。" }] },
    { type: "tool_call", name: "shell", input: { command: "calculate" } },
    { type: "tool_result", name: "shell", output: "2" },
    { type: "final_answer", content: "2" },
  ] };
  const candidate = adapt(raw, { id: "b_fast", name: "B Fast", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const scopes = planAttributionUnit(candidate).tasks.filter(task => task.stage === "attribution-component")
    .map(task => (task.data as AttributionTaskData).reviewScope!);
  assert.deepEqual(scopes.map(scope => [scope.component, scope.message_indices]), [
    ["中间推理处理", [1, 6]], ["view_skill / read_file 技能加载", [2, 3, 4, 5]],
    ["shell 代码解释器", [7, 8]], ["终稿生成轮", [9]],
  ]);
  assert.deepEqual(scopes.flatMap(scope => scope.message_indices).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("nested headings and chart resources share the final review and retain exact unread continuations", () => {
  const prose = "## 总结\n结论。\n\n### 公司一\n" + "收入需核查。".repeat(200) +
    "\n\n### 公司二\n" + "利润需核查。".repeat(200);
  const chart = JSON.stringify({ data: [{ name: "收入", x: Array.from({ length: 2000 }, (_, i) => i) }], layout: {} });
  const raw = { batch_id: "batch", case_id: "chart", messages: [
    { type: "user_question", content: "分析收入利润。" },
    { type: "final_answer", content: [{ type: "text", text: prose }, { type: "text", text: chart }] },
  ] };
  const candidate = adapt(raw, { id: "b_fast", name: "B Fast", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const tasks = planAttributionUnit(candidate).tasks.filter(task => task.stage === "attribution-component");
  assert.equal(tasks.length, 1);
  const chartTask = tasks.find(task => (task.data as AttributionTaskData).reviewScope!.final_ranges!
    .some(range => range.path === "/content/1/text"))!;
  const binding = bindAttribution(chartTask, { [candidate.input_id]: normalizeInput(raw) }, {});
  const answer = binding.modelInput!.answer as { final_evidence: { quote: string }[];
    final_context: { continuations: { end_offset: number; read_request: { offset: number } }[] } };
  assert.equal(answer.final_evidence.map(entry => entry.quote).join(""), prose.slice(0, 1600) + chart.slice(0, 1600));
  assert.deepEqual(answer.final_context.continuations.map(item => [item.read_request.offset, item.end_offset]),
    [[1600, prose.length], [1600, chart.length]]);
});
