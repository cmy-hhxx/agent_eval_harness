import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";

test("structured payload matches the complete JSON question in the paired text input", async t => {
  const payload = { datajson: '{"task":{"entity_code":"000001"}}', contentConfigComefrom: "174", query: "查看业绩" };
  const a = raw(), b = raw();
  a.messages[0]!.content = [{ type: "input_text", text: JSON.stringify(payload) }, { type: "input_text", text: "系统追加元信息" }];
  b.messages[0]!.content = payload;
  const f = await fixtureConfig([[a], [], [b], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await buildPlan(f.config);
  assert.equal(plan.tasks.filter(task => task.stage === "comparison").length, 1);
  assert.deepEqual(plan.catalog!.map(candidate => (candidate as {question:string}).question), [JSON.stringify(payload), JSON.stringify(payload)]);
  assert.deepEqual(b.messages[0]!.content, payload);
});
