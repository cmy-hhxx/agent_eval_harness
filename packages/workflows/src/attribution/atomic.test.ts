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
  assert(Number(binding.modelInput!.component_entrypoints_total) > 0);
  const material = JSON.stringify(binding.modelInput!.answer);
  assert(material.includes("收入为10亿元。"));
  assert(!material.includes("PRIVATE_SENTINEL"));
  assert.deepEqual(Object.keys(binding.request.input).sort(), ["component", "review_scope", "trace_index"],
    "a component submission must not retain the full global business-chain payload");
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  assert(prepared.evidenceBank.some(id => parseEvidenceCoordinates(id)?.message_index === 1));
  const repeated = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
  assert.equal(repeated.request.sources.answer.value, binding.request.sources.answer.value);
  assert.deepEqual(repeated.modelInput, binding.modelInput);
  assert.equal(repeated.preparationTimings!.directoryMs, 0, "shared immutable trace facts are not rebuilt");
  const navigation = binding.materialNavigation!.answer as { boundaries: { before: object[]; after: object[] }[] };
  assert(navigation.boundaries.every(boundary => [...boundary.before, ...boundary.after].every(item => !Object.hasOwn(item, "quote"))),
    "navigation stores source coordinates without duplicating original text per edge");
  const isolated = bindAttribution(task, { [candidate.input_id]: normalizeInput(structuredClone(raw)) }, {});
  assert.notEqual(isolated.request.sources.answer.value, binding.request.sources.answer.value,
    "another loaded source object never inherits this trace's cached facts");
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

test("repeated tool invocations and independent final sections do not share an unbounded review task", () => {
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
  assert.equal(components.filter(task => (task.data as AttributionTaskData).component === "finquery 取数服务").length, 2,
    "each actual invocation needs a separate bounded task, including empty returns");
  assert(components.filter(task => (task.data as AttributionTaskData).component === "终稿生成轮").length >= 2,
    "long final answers must not serialize every section in one model investigation");
  assert.equal(Object.keys(tasks.find(task => task.stage === "attribution-trace")!.dependencies).length, components.length,
    "trace aggregation must wait for every atomic review");
  const resumed = planAttributionUnit(candidate, { previousTasks: tasks });
  assert.deepEqual(resumed.tasks.map(task => task.id), tasks.map(task => task.id), "resume preserves every atomic identity");
  const finalTasks = components.filter(task => (task.data as AttributionTaskData).component === "终稿生成轮");
  const finalText = messages.at(-1)!.content!;
  const ranges = finalTasks.flatMap(task => (task.data as AttributionTaskData).reviewScope!.final_ranges!);
  assert.equal(ranges.map(range => finalText.slice(range.start, range.end)).join("").replace(/\s/gu, ""),
    finalText.replace(/\s/gu, ""), "every substantive final-answer byte belongs to a review");
  for (let index = 1; index < ranges.length; index++) assert(ranges[index]!.start >= ranges[index - 1]!.end);
  const registry = new AgentRegistry([attributionAgent]);
  for (const task of finalTasks) {
    const binding = bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {});
    assert.equal(binding.modelInput!.review_kind, "final_section");
    assert(binding.modelInput!.task_analysis);
    validateReadRequests(binding.modelInput!.answer);
    assert.equal((binding.modelInput!.answer as { component_scene?: unknown }).component_scene, undefined);
    assert.equal((binding.modelInput!.answer as { final_context: { partial: boolean } }).final_context.partial, false);
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

test("nested answer headings split independently and large chart resources have explicit unread continuations", () => {
  const prose = "## 总结\n结论。\n\n### 公司一\n" + "收入需核查。".repeat(200) +
    "\n\n### 公司二\n" + "利润需核查。".repeat(200);
  const chart = JSON.stringify({ data: [{ name: "收入", x: Array.from({ length: 2000 }, (_, i) => i) }], layout: {} });
  const raw = { batch_id: "batch", case_id: "chart", messages: [
    { type: "user_question", content: "分析收入利润。" },
    { type: "final_answer", content: [{ type: "text", text: prose }, { type: "text", text: chart }] },
  ] };
  const candidate = adapt(raw, { id: "b_fast", name: "B Fast", adapter: "b", sources: [] }, "fixture.jsonl", 1);
  const tasks = planAttributionUnit(candidate).tasks.filter(task => task.stage === "attribution-component");
  assert(tasks.filter(task => (task.data as AttributionTaskData).reviewScope!.final_ranges!
    .some(range => range.path === "/content/0/text")).length >= 2);
  const chartTask = tasks.find(task => (task.data as AttributionTaskData).reviewScope!.final_ranges!
    .some(range => range.path === "/content/1/text"))!;
  const binding = bindAttribution(chartTask, { [candidate.input_id]: normalizeInput(raw) }, {});
  const answer = binding.modelInput!.answer as { final_evidence: { quote: string }[];
    final_context: { continuations: { end_offset: number; read_request: { offset: number } }[] } };
  assert.equal(answer.final_evidence.map(entry => entry.quote).join(""), chart.slice(0, 1600));
  assert.equal(answer.final_context.continuations[0]!.read_request.offset, 1600);
  assert.equal(answer.final_context.continuations[0]!.end_offset, chart.length);
});
