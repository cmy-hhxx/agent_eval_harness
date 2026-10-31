import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject } from "@eval/contracts";
import { cite, evidenceSources } from "@eval/tools";
import { adapt, type RawInput } from "@eval/workflows/inputs";
import { bindAttribution } from "./index.js";
import { finalCapabilities } from "./component-groups.js";
import { componentTask, sourceCompactReceipt } from "../../../../tests/fixtures/compact.js";

type Member = { name: string; role: string; component_family?: string; component_role?: string;
  message_indices: number[]; contains_final_generation?: boolean };
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
    [["规划", "delivery", false], ...finalCapabilities.map(([name]) => [name, "delivery", true])], "plan-level review and the final answer share the delivery scope");
  assert.deepEqual(delivery!.raw.map(member => [member.name, member.component_family, member.component_role]),
    [["规划", "finquery", "planning"], ...finalCapabilities.map(([name]) => [name, "answer_synthesis", "delivery"])],
    "only the final generation call owns the delivery identity; planning stays a planning model");
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
  const dataFields = new Map(data!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(dataFields.get("finquery"), ["finquery", "tool"]);
  assert.deepEqual(dataFields.get("planner-search"), ["model", "planning"]);
  const searchFields = new Map(search!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(searchFields.get("web_search"), ["web_search", "tool"]);
  assert.deepEqual(searchFields.get("planner-search"), ["model", "planning"]);
});

test("an expert finquery chain groups skill, planner, scripts and tool by the first invocation target", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "expert-finquery", messages: [
    { type: "user_question", content: "查询A公司2025年营收并交付。" },
    { type: "llm_turn", name: "planner-finquery", parent_span: "p1", output: "运行 finquery.py 查询营收。" },
    call("s1", "shell", { command: "python /opt/skills/aime-finquery/finquery.py --query A" }, "p1"), result("s1", "shell", { exit_code: 0, stdout: "A公司2025年营收100亿元。" }),
    call("s2", "shell", { command: "python scripts/finquery.py --query A" }), result("s2", "shell", { exit_code: 0, stdout: "A公司2025年营收100亿元。" }),
    call("v", "view_skill", { name: "aime-finquery" }), result("v", "view_skill", { content: '<skill_content name="aime-finquery">查询公司财务。</skill_content>' }),
    { type: "llm_turn", name: "答案合成", output: "A公司2025年营收100亿元。" }, { type: "final_answer", content: "A公司2025年营收100亿元。" },
  ] };
  const [chain] = groups(raw, ["shell"]), fields = new Map(chain!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(fields.get("aime-finquery"), ["aime-finquery", "skill"]);
  assert.deepEqual(fields.get("finquery.py 请求生成"), ["finquery", "request_generation"]);
  assert.deepEqual(fields.get("planner-finquery"), ["finquery", "planning"]);
  assert.deepEqual(fields.get("/opt/skills/aime-finquery/finquery.py"), ["finquery", "script"]);
  assert.deepEqual(fields.get("scripts/finquery.py"), ["finquery", "script"]);
  assert.deepEqual(fields.get("shell"), ["shell", "tool"]);
});

test("an unrecognized shell chain stays in the shell family instead of guessing finquery", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "shell-only", messages: [
    { type: "user_question", content: "检查 finquery 是否可用。" },
    call("s", "shell", { command: "finquery --help" }), result("s", "shell", { exit_code: 0, stdout: "usage" }),
    { type: "final_answer", content: "已检查。" },
  ] };
  const [chain] = groups(raw, ["shell"]), fields = new Map(chain!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(fields.get("shell"), ["shell", "tool"]);
  assert.deepEqual(fields.get("shell 请求生成"), ["shell", "request_generation"]);
});

test("a direct web_fetch chain separates the tool from its program-named request generation", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "web-fetch", messages: [
    { type: "user_question", content: "读取公告。" },
    call("w", "web_fetch", { url: "https://example.com/notice" }), result("w", "web_fetch", { content: "公告内容。" }),
    { type: "final_answer", content: "公告已读取。" },
  ] };
  const [chain] = groups(raw, ["web_fetch"]), fields = new Map(chain!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(fields.get("web_fetch"), ["web_fetch", "tool"]);
  assert.deepEqual(fields.get("web_fetch 请求生成"), ["web_fetch", "request_generation"]);
});

test("a planning model takes the target it actually calls, not its group's first link", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "planner-target", messages: [
    { type: "user_question", content: "查询行业数据。" },
    { type: "llm_turn", name: "planner-search", parent_span: "p1", output: "搜索行业数据。" },
    call("w", "web_search", { query: "行业数据" }, "p1"), result("w", "web_search", { items: [] }),
    { type: "final_answer", content: "未找到数据。" },
  ] };
  const [chain] = groups(raw, ["web_search"]), fields = new Map(chain!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(fields.get("planner-search"), ["web_search", "planning"]);
});

test("a generic planning model with several targets has no single family", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "planning-mixed", messages: [
    { type: "user_question", content: "取数并搜索。" },
    { type: "llm_turn", name: "规划", parent_span: "p1", output: "先取数。" },
    call("f", "finquery", { query: "A" }, "p1"), result("f", "finquery", "A=1"),
    { type: "llm_turn", name: "规划", parent_span: "p2", output: "再搜索。" },
    call("w", "web_search", { query: "A" }, "p2"), result("w", "web_search", { items: [] }),
    { type: "final_answer", content: "A=1。" },
  ] };
  const [data, search] = groups(raw, ["finquery", "web_search"]);
  for (const chain of [data!, search!]) {
    const planner = chain.raw.find(member => member.name === "规划")!;
    assert.deepEqual([planner.component_family, planner.component_role], ["model", "planning"]);
  }
});

test("a view_skill group never copies its own family onto shell or inner-script request generation", () => {
  const raw: RawInput = { batch_id: "batch", case_id: "view-skill-shell", messages: [
    { type: "user_question", content: "查看 skill 目录。" },
    call("v", "view_skill", { name: "aime-finquery" }), result("v", "view_skill", { content: "查询公司财务。" }),
    call("s", "shell", { command: "ls /opt/skills/aime-finquery/" }), result("s", "shell", { exit_code: 0, stdout: "finquery.py" }),
    { type: "final_answer", content: "目录已查看。" },
  ] };
  const [chain] = groups(raw, ["view_skill"]), fields = new Map(chain!.raw.map(member => [member.name, [member.component_family, member.component_role]]));
  assert.deepEqual(fields.get("view_skill 请求生成"), ["view_skill", "request_generation"]);
  assert.deepEqual(fields.get("shell 请求生成"), ["shell", "request_generation"]);
  assert.deepEqual(fields.get("aime-finquery"), ["aime-finquery", "skill"]);
});
