import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@eval/contracts";
import { cite, evidenceSources } from "@eval/tools";
import { adapt, type RawInput } from "@eval/workflows/inputs";
import { bindAttribution } from "./index.js";
import { finalCapabilities } from "./component-groups.js";
import { componentTask, sourceCompactReceipt } from "../../../../tests/fixtures/compact.js";

type Member = { name: string; role: string; message_indices: number[]; contains_final_generation?: boolean };
function groups(raw: RawInput, names: string[], errors: (candidate: ReturnType<typeof adapt>) => JsonObject[] = () => []) {
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1), inputs = { [candidate.input_id]: raw };
  const compact = sourceCompactReceipt(candidate, raw);
  (compact.evaluation as { turns: JsonObject[] }).turns[0]!.tool_errors = errors(candidate);
  return names.map(name => {
    const binding = bindAttribution(componentTask(candidate, compact, inputs, name), inputs, { compact });
    return { members: (binding.request.input.components as Member[]).map(member => [member.name, member.role]),
      raw: binding.request.input.components as Member[], input: binding.modelInput!, errors: binding.request.input.tool_errors as JsonObject[] };
  });
}
const call = (id: string, name: string, input: JsonObject, parent?: string) => ({ type: "tool_call", name, call_id: id, input, ...(parent ? { parent_span: parent } : {}) });
const result = (id: string, name: string, output: unknown) => ({ type: "tool_result", name, call_id: id, output });

test("an anonymous main loop is linked by its generated arguments and named per tool by the program", () => {
  const generated = (id: string, query: string) => ({ type: "llm_turn",
    output: [{ role: "assistant", tool_calls: [{ id, type: "function", function: { name: "finquery", arguments: JSON.stringify({ query }) } }] }] });
  const raw: RawInput = { batch_id: "batch", case_id: "expert", messages: [
    { type: "user_question", content: "查询A公司2025年营收。" },
    generated("c1", "A 2024 营收"), call("c1", "finquery", { query: "A 2024 营收" }), result("c1", "finquery", "A公司2024年营收90亿元。"),
    generated("c2", "A 2025 营收"), call("c2", "finquery", { query: "A 2025 营收" }), result("c2", "finquery", "A公司2025年营收100亿元。"),
    { type: "llm_turn", output: "A公司2025年营收100亿元。" }, { type: "final_answer", content: "A公司2025年营收100亿元。" },
  ] };
  const [chain, delivery] = groups(raw, ["finquery", "答案合成·取值"]);
  assert.deepEqual(chain!.members, [["finquery", "tool"], ["finquery 请求生成", "request_generation"]]);
  assert.deepEqual(chain!.raw[1]!.message_indices, [1, 4], "every generating call answers for the program-named slot");
  assert.equal(chain!.input.investigation_scope, "tool_chain");
  assert.deepEqual((chain!.input.invocations as { request_components: string[] }[]).map(link => link.request_components), [["finquery 请求生成"], ["finquery 请求生成"]]);
  assert.deepEqual(delivery!.raw.map(member => [member.name, member.role, member.contains_final_generation === true]),
    [["规划", "delivery", false], ...finalCapabilities.map(([name]) => [name, "delivery", true])], "plan-level review and the final answer form the delivery group");
  assert.equal((delivery!.input.invocations as unknown[]).length, 2, "delivery checks the final answer against every invocation");
});

test("a skill owns scripts under its directory, a planner answers for every tool it invoked, and errors stay with their chain", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "fast", messages: [
    { type: "user_question", content: "用 valuation skill 分析A股估值并对比行业。" },
    call("s", "view_skill", { name: "valuation" }), result("s", "view_skill", '<skill_content name="valuation">运行 /skills/valuation/run.py。</skill_content>'),
    { type: "llm_turn", name: "planner-shell", parent_span: "p1", output: "运行估值脚本。" },
    call("r", "shell", { command: "python /skills/valuation/run.py --ticker A" }, "p1"), result("r", "shell", { exit_code: 0, stdout: "PE=12" }),
    { type: "llm_turn", name: "planner-search", parent_span: "p2", output: "搜索行业估值并核对个股PE。" },
    call("w", "web_search", { query: "行业PE" }, "p2"), result("w", "web_search", { error: "timeout" }),
    call("f", "finquery", { query: "A PE" }, "p2"), result("f", "finquery", "A PE=12"),
    { type: "final_answer", content: "A股PE 12，行业数据暂缺。" },
  ] };
  const [skill, search, data, delivery] = groups(raw, ["valuation", "web_search", "finquery", "答案合成·取值"], candidate => {
    const source = evidenceSources(raw.messages[8]).find(item => item.path === "/output/error")!;
    return [{ tool_error_idx: 1, tool_error_content: "web_search 超时。", evidence: [cite(candidate.input_id, 8, source, 0, source.text.length)] }];
  });
  assert.deepEqual(skill!.members, [["view_skill", "tool"], ["valuation", "skill"], ["shell", "tool"], ["/skills/valuation/run.py", "script"],
    ["planner-shell", "request_generation"], ["view_skill 请求生成", "request_generation"]], "an unrecorded generator still gets a per-tool slot");
  assert.deepEqual(search!.members, [["web_search", "tool"], ["planner-search", "request_generation"]]);
  assert.deepEqual(data!.members, [["finquery", "tool"], ["planner-search", "request_generation"]]);
  assert.deepEqual(delivery!.members, finalCapabilities.map(([name]) => [name, "delivery"]));
  assert.deepEqual(search!.errors.map(error => error.tool_error_idx), [1]);
  for (const other of [skill, data, delivery]) assert.deepEqual(other!.errors, [], "delivery and unrelated chains never dispose another chain's error");
});
