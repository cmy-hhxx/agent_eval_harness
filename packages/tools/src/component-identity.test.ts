import assert from "node:assert/strict";
import test from "node:test";
import { traceComponentIdentities, isComponentLocator, traceComponentOwnsEvidence } from "./component-identity.js";
import { resolveEvidence, cite, evidenceSources } from "./evidence.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

const id = "11111111-1111-4111-8111-111111111111";
test("generated code belongs to its proven author, while execution returns do not",()=>{
  const raw={messages:[{type:"llm_turn",name:"llm-call-1",parent_span:"p",output:[{tool_calls:[{function:{name:"shell",arguments:JSON.stringify({command:"x >= date"})}}]}]},
    {type:"tool_call",name:"shell",parent_span:"p",input:{command:"x >= date"}},
    {type:"tool_result",name:"shell",output:{stdout:"wrong window"}}]};
  const actor=traceComponentIdentities(raw,id,9)[0];
  const proof=(index:number,path:string)=>{const s=evidenceSources(raw.messages[index]).find(s=>s.kind==="text"&&s.path===path)!;return cite(id,index,s,0,s.text.length).evidence_id;};
  const code=proof(1,"/input/command"),result=proof(2,"/output/stdout");
  assert.deepEqual(actor.generated_call_indices,[1]);
  assert(traceComponentOwnsEvidence(raw,actor,code));
  const serialized=evidenceSources(raw.messages[1]).find(source=>source.kind==='json')!;
  assert(traceComponentOwnsEvidence(raw,actor,cite(id,1,serialized,0,serialized.text.length).evidence_id));
  assert(!traceComponentOwnsEvidence(raw,actor,proof(1,'/name')));
  assert(!traceComponentOwnsEvidence(raw,actor,result));
  raw.messages[1].parent_span="another";
  assert(!traceComponentOwnsEvidence(raw,actor,code));
  raw.messages[1].parent_span="p";
  raw.messages[1].input!.command="different code";
  assert(!traceComponentOwnsEvidence(raw,actor,code));
});
test('anonymous model output and final delivery retain distinct proven roles',()=>{
  const raw={messages:[{type:'llm_turn',name:'llm-call-0',input_messages:[],output:[{role:'assistant',reasoning_content:'引入18.15%，无工具依据。',content:'18.15%，在容差内。'}]},
    {type:'final_answer',content:'18.15%，在容差内。'}]};
  const actors=traceComponentIdentities(raw,id,1);
  assert.deepEqual(actors.map(actor=>actor.component),['中间推理处理','终稿生成轮']);
  assert.deepEqual(actors.map(actor=>actor.message_indices),[[0],[1]]);
  assert.equal(actors[0]!.identity_status,'role_only');
  assert.equal(actors[1]!.identity_status,'role_only');
});
test("actor identities retain named planners and tools, while anonymous model calls keep generic roles", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "planner-search", input_messages: [], output: [] },
    { type: "llm_turn", name: "planner-finquery", input_messages: [], output: [] },
    { type: "tool_call", name: "finquery", call_id: "price-call", input: { query: "黄金" } },
    { type: "tool_result", call_id: "price-call", output: "GLD369" },
    { type: "llm_turn", name: "llm-call-0", input_messages: [{ role: "user", content: "黄金" }], output: [{ role: "assistant", content: "黄金3690" }] },
    { type: "final_answer", content: "黄金3690" },
  ] };
  const before = structuredClone(raw), actors = traceComponentIdentities(raw, id, 5);
  assert.deepEqual(actors.map(actor => actor.component), ["planner-search", "planner-finquery", "finquery", "中间推理处理", "终稿生成轮"]);
  assert.deepEqual(actors[2].message_indices, [2, 3]);
  assert.deepEqual(actors[3].message_indices, [4]);
  assert.deepEqual(actors[4].message_indices, [5]);
  assert.equal(actors[3].identity_status, "role_only");
  assert.equal(actors[4].identity_status, "role_only");
  for (const actor of actors) for (const evidence of actor.identity_evidence)
    assert.equal(resolveEvidence(raw, { evidence_id: evidence.evidence_id }, "answer", emptyAudit(), "/identity", id).quote, evidence.quote);
  assert(actors.every(actor => !isComponentLocator(actor.component)));
  assert.deepEqual(raw, before);
});

test("multiple unnamed and same-name model records remain individually navigable without invented roles or model names", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-1", model: "opaque-model", output: [] },
    { type: "llm_turn", name: "a49b50c9-d2cb-42ea-8995-5f588b93d0b0", output: [] },
    { type: "llm_turn", name: "Planner", output: [] },
    { type: "llm_turn", name: "Planner", output: [] },
    { role: "assistant", content: "完成" },
  ] };
  const actors = traceComponentIdentities(raw, id, 4);
  assert.equal(actors.length, 5);
  assert.deepEqual(actors.map(actor => actor.message_indices), [[0], [1], [2], [3], [4]]);
  assert(actors.slice(0, 2).every(actor => actor.identity_status === "role_only" && actor.identity_gap));
  assert(!JSON.stringify(actors.map(actor => actor.component)).includes("opaque-model"));
  assert.equal(actors[0].component, "中间推理处理");
  assert.equal(actors[1].component, "中间推理处理");
  assert.equal(actors[2].component, "Planner");
  assert.equal(actors[3].component, "Planner");
  assert.equal(actors[4].component, "终稿生成轮");
});

test("the final delivery role takes precedence over an execution locator", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-0", input_messages: [], output: [{ role: "assistant", content: "完成" }] },
    { type: "final_answer", name: "最终作答节点", content: "完成" },
  ] };
  const actors = traceComponentIdentities(raw, id, 1);
  assert.deepEqual(actors.map(actor => actor.component), ["中间推理处理", "终稿生成轮"]);
  assert.deepEqual(actors.map(actor => actor.message_indices), [[0], [1]]);
  assert(actors[1]!.identity_evidence.some(evidence => evidence.message_index === 1 && evidence.quote === "final_answer"));
});

test("bare execution locators are not component display names", () => {
  for (const locator of ["llm-call-0", "span-4f26f1fabe23fc3c", "4f26f1fabe23fc3c", "a49b50c9-d2cb-42ea-8995-5f588b93d0b0"])
    assert(isComponentLocator(locator), locator);
  for (const name of ["planner-finquery", "request-router", "trace-search", "finquery", "display", "最终作答节点"]) assert(!isComponentLocator(name), name);
});

test("matching final content does not prove an anonymous llm-call generated the final answer", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "llm-call-7", input_messages: [], output: [{ role: "assistant", content: "同一段结论" }] },
    { type: "final_answer", content: "同一段结论" },
  ] };
  const actors = traceComponentIdentities(raw, id, 1);
  assert.deepEqual(actors.map(actor => actor.component), ["中间推理处理", "终稿生成轮"]);
  assert.deepEqual(actors.map(actor => actor.message_indices), [[0], [1]]);
  assert.equal(actors.some(actor => isComponentLocator(actor.component)), false);
  assert.equal(actors.some(actor => actor.component.startsWith("其他工具")), false);
});
