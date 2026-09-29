import test from "node:test";
import assert from "node:assert/strict";
import { rewriteAgent, rewriteProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("cell rewrites cannot copy the winning model label onto the other model's facts", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "comparison.0.B.summary", label: "AA组Fast的点评", text: "没有给出结果。", context: "A组Fast给出结果。",
      forbiddenPrefixes: ["A组Fast：", "AA组Fast：", "没有已证实的单方优势："] },
  ] } };
  for (const prefix of request.input.items[0]!.forbiddenPrefixes)
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0]!.id, text: prefix + "没有给出结果。" }] }, audit), /不要把对照信息/);
  rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0]!.id, text: "没有给出结果。" }] }, audit);
});
test("pair rewrites must state the accepted preference and retain ties", () => {
  const request = { sources: {}, input: { kind: "comparison", items: [
    { id: "verdict.A__vs__B.reason", label: "偏好", text: "双方均达标，AA组Fast补充了近期事件催化。", preference: "AA组Fast更好" },
  ] } };
  for (const text of ["双方都完成了核心要求，未见共同遗漏。", "A组Fast更好：更完整。", "AA组Fast更好："])
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id, text }] }, audit), /已确定偏好/);
  rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id, text: "AA组Fast更好：补充了近期事件催化，解释更贴题。" }] }, audit);
  for (const preference of ["双方都好", "双方都差"]) {
    request.input.items[0].preference = preference;
    assert.throws(() => rewriteProfile.validate!(request, { rewrites: [{ id: request.input.items[0].id, text: preference + "：A组Fast更可用。" }] }, audit), /没有整体胜者/);
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
  assert.throws(() => rewriteProfile.validate!(example.request, empty, audit), /minLength|rewrites/);
});

test("rewrite length is editorial guidance rather than a hard rejection", () => {
  const request = { agent: "rewrite", profile: "default", sources: {}, input: { kind: "comparison", items: [
    { id: "tradeoff", label: "裁决短评", text: "A更好。" },
    { id: "comparison.0.A.summary", label: "表现", text: "给出结果。" },
  ] } };
  const result = { rewrites: [{ id: "tradeoff", text: "短".repeat(100) }, { id: "comparison.0.A.summary", text: "短".repeat(160) }] };
  rewriteProfile.validate!(request, result, audit);
  result.rewrites[0].text += "长";
  rewriteProfile.validate!(request, result, audit);
  result.rewrites[0].text = "A更好。";
  result.rewrites[1].text += "长";
  rewriteProfile.validate!(request, result, audit);
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
