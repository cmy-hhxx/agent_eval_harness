import test from "node:test";
import assert from "node:assert/strict";
import { rewriteAgent, rewriteProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
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

test("comparison rewrites cannot expand a concise verdict or aligned cell into a long essay", () => {
  const request = { agent: "rewrite", profile: "default", sources: {}, input: { kind: "comparison", items: [
    { id: "tradeoff", label: "裁决短评", text: "A更好。" },
    { id: "comparison.0.A.summary", label: "表现", text: "给出结果。" },
  ] } };
  const result = { rewrites: [{ id: "tradeoff", text: "短".repeat(160) }, { id: "comparison.0.A.summary", text: "短".repeat(160) }] };
  rewriteProfile.validate!(request, result, audit);
  result.rewrites[0].text += "长";
  assert.throws(() => rewriteProfile.validate!(request, result, audit), /最多160字/);
  result.rewrites[0].text = "A更好。";
  result.rewrites[1].text += "长";
  assert.throws(() => rewriteProfile.validate!(request, result, audit), /最多160字/);
});
