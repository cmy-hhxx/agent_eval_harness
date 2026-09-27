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
