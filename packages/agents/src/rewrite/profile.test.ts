import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { rewriteAgent, rewriteProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
test("cell rewrites cannot copy the winning model label onto the other model's facts", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "comparison.0.B.summary", label: "B组Fast的点评", text: "没有给出结果。", context: "A组Fast给出结果。",
      forbiddenPrefixes: ["A组Fast：", "B组Fast：", "没有已证实的单方优势："] },
  ] } };
  for (const prefix of request.input.items[0]!.forbiddenPrefixes)
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0]!.id, text: prefix + "没有给出结果。" }] }, audit), /不要把对照信息/);
  rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0]!.id, text: "没有给出结果。" }] }, audit);
});
test("pair rewrites must state the accepted preference and retain ties", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "verdict.A__vs__B.reason", label: "偏好", text: "双方均达标，B组Fast补充了近期事件催化。", preference: "B组Fast更好" },
  ] } };
  for (const text of ["双方都完成了核心要求，未见共同遗漏。", "A组Fast更好：更完整。", "B组Fast更好："])
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id, text }] }, audit), /已确定偏好/);
  rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id, text: "B组Fast更好：补充了近期事件催化，解释更贴题。" }] }, audit);
  request.input.items[0].preference = "双方都好";
  rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id,
    text: "双方都好：均已完成核心任务，现有差异不足以证明某一方更可用。" }] }, audit);
});
test("both-bad rewrites retain relative preference while keeping the accepted verdict prefix", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "verdict.A__vs__B.reason", label: "偏好", text: "双方都没给回测结果，B组Fast相对更好，提供了代码，A组Fast只有方法。", preference: "双方都差" },
  ] } };
  const result = { rewrites: [{ id: request.input.items[0].id, text: "双方都差：都没给回测结果，B组Fast相对更好，提供了代码，A组Fast只有方法。" }] };
  rewriteProfile.validate!(request, result, audit);
  for (const text of ["B组Fast更好：提供了代码。", "双方都好：都提供了方法。", "双方都差："]) {
    result.rewrites[0].text = text;
    assert.throws(() => rewriteProfile.validate!(request, result, audit), /已确定偏好/);
  }
});
test("Rewrite returns exactly the requested slots and nothing else", () => {
  assert.deepEqual(Object.keys(rewriteAgent.profiles), ["default"]);
  rewriteProfile.validate!(example.request, example.result, audit);

  const missing = structuredClone(example.result);
  missing.rewrites.pop();
  assert.throws(() => rewriteProfile.validate!(example.request, missing, audit), /每个槽位/);

  const unknown = structuredClone(example.result);
  unknown.rewrites[0]!.id = "assessment.C.summary";
  assert.throws(() => rewriteProfile.validate!(example.request, unknown, audit), /必须对应请求中的槽位/);

  const duplicate = structuredClone(example.result);
  duplicate.rewrites.push(structuredClone(duplicate.rewrites[0]!));
  assert.throws(() => rewriteProfile.validate!(example.request, duplicate, audit), /只能改写一次/);

  const empty = structuredClone(example.result);
  empty.rewrites[0]!.text = "";
  assert.throws(() => rewriteProfile.validate!(example.request, empty, audit), /minLength|texts/);
});

test("verdict length is a writing goal and does not discard necessary evidence", () => {
  const request = { agent: "rewrite", profile: "default", sources: {}, input: { kind: "comparison", items: [
    { id: "tradeoff", label: "裁决短评", text: "A更好。", preference:"A更好" },
  ] } };
  const text = "A更好：给出了指定期间的实际结果，并核对了筛选条件、统计对象及数据来源。B虽然耗时更短、消耗的token更少，但只提供方法，缺少用户要求的名单和计算结果。这里的偏好依据是核心任务是否完成，资源节省作为次要因素保留；同时，A对异常数据的说明仍不充分，后续需要补充缺失值的处理过程。两方的时间与token均来自本次回答的原始记录，不把裁判消耗计入，也不因记录字段名称不同而宣称无法比较。";
  assert(text.length > 160);
  const valid = new Ajv2020({ strict: false }).compile(rewriteProfile.modelSubmissionSchema!(request));
  const draft = { texts: [text] };
  assert(valid(draft), JSON.stringify(valid.errors));
  assert.deepEqual(rewriteProfile.validateSubmission?.(request, draft, audit) ?? [], []);
  const result = { rewrites: [{ id: "tradeoff", text }] };
  rewriteProfile.validate!(request, result, audit);
  assert.equal(result.rewrites[0].text, text, "validation never truncates a submitted sentence");
});

test("rewrite number fidelity is reviewed semantically instead of rejecting numeric tokens", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "tradeoff", label: "裁决短评", text: "A名单正确，B虽快且少用5,922 tokens，但名单错误。" },
    { id: "comparison.0.B.summary", label: "用时", text: "B快1.782秒。" },
  ] } };
  const result = { rewrites: [
    { id: "tradeoff", text: "A名单正确，B少用约六千 tokens，但名单错误。" },
    { id: "comparison.0.B.summary", text: "B快约1.8秒。" },
  ] };
  rewriteProfile.validate!(request, result, audit);
  result.rewrites[0]!.text = "A名单正确，B少用5922 tokens但名单错误。";
  rewriteProfile.validate!(request, result, audit);
});
