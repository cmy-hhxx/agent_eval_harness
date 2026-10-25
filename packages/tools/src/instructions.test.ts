const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { answerTurnContexts, instructionSources, normativeSources } from "./instructions.js";
import { resolveEvidence } from "./evidence.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

test("answer contexts exclude an independent planner after the actual final-output turn", () => {
  const raw = { messages: [
    { type: "llm_turn", input_messages: { messages: [{ role: "system", content: "真实回答规范" }] },
      output: [{ role: "assistant", content: "实际最终回答" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "独立规划规范" }],
      output: [{ role: "assistant", content: "下一项规划" }] },
    { role: "assistant", content: "实际最终回答" },
  ] };
  assert.deepEqual(answerTurnContexts(raw, 2), [{ message_index: 0, path: "/input_messages/messages" }]);
  assert.deepEqual(instructionSources(raw, INPUT_ID, 2).map(source => source.message_index), [0]);
});

test("normative sources include real user context without widening the instruction catalogue", () => {
  const raw = { messages: [
    { role: "user", content: [{ type: "text", text: "整理清单" }, { type: "text", text: "投资建议请先说明风险。" }] },
    { type: "llm_turn", input_messages: [{ role: "developer", content: "完整作答" },
      { role: "user", content: "本轮请使用横版表格。" }], output: [{ role: "assistant", content: "实际回答" }] },
    { type: "llm_turn", input_messages: [{ role: "user", content: "内部任务请输出规划。" }],
      output: [{ role: "assistant", content: "独立规划" }] },
    { role: "assistant", content: "实际回答" },
  ] };
  const before = structuredClone(raw);
  assert.deepEqual(normativeSources(raw, INPUT_ID, 3).map(source => [source.message_index, source.path, source.role]), [
    [0, "/content", "user"], [1, "/input_messages/0/content", "developer"], [1, "/input_messages/1/content", "user"],
  ]);
  assert.deepEqual(instructionSources(raw, INPUT_ID, 3).map(source => [source.message_index, source.role]), [[1, "developer"]]);
  for (const source of normativeSources(raw, INPUT_ID, 3)) for (const evidence of source.evidence)
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: source.message_index, quote: evidence.quote,
    });
  assert.deepEqual(raw, before);
});

test("instruction sources retain exact top-level and final-answer context coordinates", () => {
  const raw = { messages: [
    { role: "system", content: [{ type: "input_text", text: "仅投资建议需前置风险。" }] },
    { type: "llm_turn", name: "planner-search", input_messages: [{ role: "system", content: "仅输出检索计划。" }],
      output: [{ role: "assistant", content: "搜索计划" }] },
    { type: "llm_turn", name: "answer", input_messages: [{ role: "developer", content: "结论后提示风险。" }],
      output: [{ role: "assistant", content: "实际最终回答" }] },
    { role: "assistant", content: "实际最终回答" },
    { role: "developer", content: "下一轮指令不属于此回答。" },
  ] };
  const before = structuredClone(raw);
  const sources = instructionSources(raw, INPUT_ID, 3);
  assert.deepEqual(sources.map(({ message_index, path, role }) => ({ message_index, path, role })), [
    { message_index: 0, path: "/content", role: "system" },
    { message_index: 2, path: "/input_messages/0/content", role: "developer" },
  ]);
  assert.deepEqual(sources[0]!.content, raw.messages[0]!.content);
  for (const source of sources) for (const evidence of source.evidence)
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: source.message_index, quote: evidence.quote,
    });
  assert(sources[0]!.evidence.some(evidence => evidence.quote === "仅投资建议需前置风险。"));
  assert.deepEqual(raw, before);
});

test("answer lineage keeps initial agent instructions and changed developer rules without importing planners", () => {
  const call = { id: "call-1", type: "function", function: { name: "query", arguments: "{}" } };
  const early = { role: "assistant", content: "先查数据", tool_calls: [call] };
  const raw = { messages: [
    { role: "user", content: "问题" },
    { type: "llm_turn", name: "agent-0", input_messages: { messages: [
      { role: "system", content: "代理原始规范：不要以风险开场。" }, { role: "user", content: "问题" },
    ] }, output: [early] },
    { type: "llm_turn", name: "internal-0", input_messages: { messages: [
      { role: "system", content: "工具内部只输出数字。" },
    ] }, output: [{ role: "assistant", content: "内部结果" }] },
    { type: "llm_turn", name: "agent-1", input_messages: { messages: [
      { role: "developer", content: "只用当前数据。" }, early, { role: "tool", content: "内部结果" },
    ] }, output: [{ role: "assistant", content: "最终结论" }] },
    { role: "assistant", content: "最终结论" },
  ] };
  const sources = instructionSources(raw, INPUT_ID);
  assert.deepEqual(sources.map(source => [source.message_index, source.path, source.content]), [
    [1, "/input_messages/messages/0/content", "代理原始规范：不要以风险开场。"],
    [3, "/input_messages/messages/0/content", "只用当前数据。"],
  ]);
});

test("repeated answer instructions use the earliest true origin and unlinked turns supply no inferred rules", () => {
  const raw = { messages: [
    { type: "llm_turn", input_messages: [{ role: "system", content: "真实规范" }],
      output: [{ role: "assistant", content: "先查" }] },
    { type: "llm_turn", input_messages: { messages: [
      { role: "system", content: "真实规范" }, { role: "assistant", content: "先查" },
    ] }, output: [{ role: "assistant", content: "结论" }] },
    { role: "assistant", content: "结论" },
  ] };
  assert.deepEqual(instructionSources(raw, INPUT_ID).map(source => source.message_index), [0]);
  (raw.messages[1] as { output: unknown }).output = [{ role: "assistant", content: "另一个任务" }];
  assert.deepEqual(instructionSources(raw, INPUT_ID), []);
});

test("a collected answer still links its actual context when visual resource tags were rendered out", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "planner", input_messages: [{ role: "system", content: "内部规划规范" }],
      output: [{ role: "assistant", content: "计划" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "真实回答规范" }],
      output: [{ role: "assistant", content: '结论\n\n<visual>{"id":"chart"}</visual>\n\n补充' }] },
    { role: "assistant", content: "结论\n\n\n\n补充" },
  ] };
  assert.deepEqual(instructionSources(raw, INPUT_ID).map(source => source.message_index), [1]);
});

test("a rendered vis-html image retains the exact generation and its actual input history", () => {
  const call={role:'assistant',content:null,tool_calls:[{id:'chart',type:'function',function:{name:'shell',arguments:'{"command":"render"}'}}]};
  const raw={messages:[
    {type:'llm_turn',input_messages:[],output:[call]},
    {type:'llm_turn',input_messages:{messages:[call,{role:'tool',content:'{"type":"vis-html","id":"html-chart"}'}]},
      output:[{role:'assistant',content:'估值比较\n<vis-html ref="html-chart" />\n风险说明'}]},
    {type:'final_answer',content:[{type:'output_text',text:'估值比较\n'},{type:'output_image',image_url:'data:image/png;base64,AA=='},{type:'output_text',text:'\n风险说明'}]},
  ]};
  const before=structuredClone(raw);
  assert.deepEqual(answerTurnContexts(raw,2),[{message_index:0,path:'/input_messages'},{message_index:1,path:'/input_messages/messages'}]);
  assert.deepEqual(raw,before);
  raw.messages[1].output![0].content='估值比较\n<vis-html ref="html-chart" />\n另一个风险';
  assert.deepEqual(answerTurnContexts(raw,2),[]);
});

test("vis-html rendering does not guess among multiple matching generations or remove arbitrary tags",()=>{
  const turn=(content:string)=>({type:'llm_turn',input_messages:[],output:[{role:'assistant',content}]});
  const final={type:'final_answer',content:[{type:'output_text',text:'比较 完成'},{type:'output_image',image_url:'data:image/png;base64,AA=='}]};
  assert.deepEqual(answerTurnContexts({messages:[turn('比较 <vis-html ref="html-a" /> 完成'),turn('比较 <vis-html ref="html-b" /> 完成'),final]},2),[]);
  assert.deepEqual(answerTurnContexts({messages:[turn('比较 <other ref="html-a" /> 完成'),final]},1),[]);
  assert.deepEqual(answerTurnContexts({messages:[turn('比较 <vis-html ref="html-a" /> 完成'),{type:'final_answer',content:'比较 完成'}]},1),[]);
});

const skill = '<skill_content name="stock-analysis">\n# 用户适配\n持仓未知时分别说明未持有与已持有；只查询数据时无需行动建议。\n</skill_content>';
const skillCall = () => ({ type: "tool_call", name: "view_skill", input: { name: "stock-analysis" } });
const skillResult = () => ({ type: "tool_result", name: "view_skill", output: skill });
const skillTrace = (messages: unknown[]) => ({ messages: [...messages, { role: "assistant", content: "实际回答" }] });

test("loaded skills retain actual tool identity, complete conditions and physical output coordinates", () => {
  for (const messages of [[skillCall(), skillResult()], [
    { ...skillCall(), call_id: "load-1" }, { role: "assistant", content: "等待" }, { ...skillResult(), tool_call_id: "load-1" },
  ]]) {
    const raw = skillTrace(messages), before = structuredClone(raw), sources = instructionSources(raw, INPUT_ID);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.role, "tool"); assert.equal(sources[0]!.content, skill);
    assert.equal(sources[0]!.path, "/output"); assert.equal(sources[0]!.message_index, messages.length - 1);
    for (const evidence of sources[0]!.evidence) assert.equal(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID).quote, skill);
    assert.deepEqual(raw, before);
  }
});

test("ordinary tools, unbound or failed skill returns and ambiguous identities never become instructions", () => {
  const invalid: unknown[][] = [
    [skillResult()],
    [{ ...skillCall(), name: "query" }, { ...skillResult(), name: "query" }],
    [skillCall(), { ...skillResult(), name: "query" }],
    [skillCall(), { role: "assistant", content: "无关联号不能跨消息猜配对" }, skillResult()],
    [skillCall(), skillCall(), skillResult()],
    [{ ...skillCall(), input: { name: "other" } }, skillResult()],
    [{ ...skillCall(), input: { name: "stock-analysis", path: "examples.md" } }, skillResult()],
    [skillCall(), { ...skillResult(), output: "示例：" + skill }],
    [skillCall(), { ...skillResult(), output: '```xml\n' + skill + '\n```' }],
    [skillCall(), { ...skillResult(), isError: true }],
    [{ ...skillCall(), call_id: "a" }, { ...skillResult(), call_id: "b" }],
    [{ ...skillCall(), call_id: "a" }, skillResult()],
    [{ ...skillCall(), call_id: "a" }, { ...skillCall(), call_id: "a" }, { ...skillResult(), call_id: "a" }],
    [{ ...skillCall(), call_id: "a" }, { ...skillResult(), call_id: "a", tool_call_id: "b" }],
    [{ ...skillCall(), call_id: 1 }, { ...skillResult(), call_id: 1 }],
  ];
  for (const messages of invalid) assert.deepEqual(instructionSources(skillTrace(messages), INPUT_ID), []);
  const recovered = skillTrace([skillCall(), { ...skillResult(), isError: true }, skillCall(), skillResult()]);
  assert.deepEqual(instructionSources(recovered, INPUT_ID).map(source => source.message_index), [3]);
});

test("nested planner material, known independent parent calls and later skill loads are excluded", () => {
  const raw = skillTrace([
    { type: "llm_turn", parent_span: "planner", input_messages: [skillCall(), skillResult()],
      output: [{ role: "assistant", content: "独立计划" }] },
    { ...skillCall(), parent_span: "planner" }, skillResult(),
    { type: "llm_turn", parent_span: "answer", input_messages: [{ role: "user", content: "原问题" }],
      output: [{ role: "assistant", content: "实际回答" }] },
  ]);
  assert.deepEqual(instructionSources(raw, INPUT_ID), []);
  raw.messages.push(skillCall(), skillResult());
  assert.deepEqual(instructionSources(raw, INPUT_ID, 4), []);
});
