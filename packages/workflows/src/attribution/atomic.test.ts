import test from "node:test";
import assert from "node:assert/strict";
import { adapt, normalizeInput } from "@eval/workflows/inputs";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { parseEvidenceCoordinates } from "@eval/tools";
import { bindAttribution, planAttributionUnit, type AttributionTaskData } from "./index.js";

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
