import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { writeJsonl } from "@eval/data";
import { buildPlan } from "./input.js";
import type { Candidate } from "../inputs/types.js";
import type { TaskData } from "./types.js";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";

test("cleaning scope selects exact records, keeps unpaired attribution and preserves accepted tasks on resume", async t => {
  const fixture = await fixtureConfig([[raw("one"),raw("outside")],[],[raw("one"),raw("outside")],[]]);
  t.after(() => rm(fixture.directory,{ recursive:true,force:true }));
  const config = fixture.config;
  const records = [config.inputs.versions[0]!,config.inputs.versions[2]!].map(version => ({
    model:version.id,batch_id:String(raw().batch_id),case_id:"one",input_file:version.sources[0]!.path,input_index:0,
    package_id:"pkg",package_name:"input.7z",original_file:"input.7z/data.jsonl",original_line:17,
  }));
  config.inputs.workbench = { task:{ id:"task",name:"test",source:"wencai",category:"task" },batch_ids:["pkg"],records };
  const plan = await buildPlan(config);
  assert.equal(plan.summary.cases,1);
  assert.equal(plan.summary.comparison_tasks,1);
  assert.equal(plan.summary.attribution_tasks,2);
  assert((plan.catalog as Candidate[]).every(row => row.case_id === "one"));
  const resumed = await buildPlan(config,plan,{ acceptedTaskIds:new Set(plan.tasks.map(task => task.id)) });
  assert.equal(resumed.tasks.filter(task => task.stage.startsWith("attribution-") && !plan.tasks.some(previous => previous.id === task.id)).length,0);
  config.inputs.workbench.records = [records[0]!];
  const alone = await buildPlan(config);
  assert.equal(alone.summary.comparison_tasks,0);
  assert.equal(alone.summary.attribution_tasks,1);
  assert(alone.tasks.some(task => task.stage === "criteria"));
  assert.equal((alone.tasks.find(task => task.stage === "attribution-session")!.data as TaskData).candidates.A.case_id,"one");
  await writeJsonl(records[0]!.input_file,[raw("different"),raw("outside")]);
  await assert.rejects(buildPlan(config),/清洗范围与输入身份不一致/);
});

test("missing cleaning coordinate is a hard error rather than a smaller successful run", async t => {
  const fixture = await fixtureConfig(); t.after(() => rm(fixture.directory,{ recursive:true,force:true }));
  fixture.config.inputs.workbench = { task:{ id:"task",name:"test",source:"aime",category:"daily" },batch_ids:["pkg"],records:[{
    model:"a_fast",batch_id:"b",case_id:"c",input_file:fixture.config.inputs.versions[0]!.sources[0]!.path,input_index:100,
    package_id:"pkg",package_name:"p.7z",original_file:"p.7z/data",original_line:1,
  }] };
  await assert.rejects(buildPlan(fixture.config),/缺失或已变动/);
});
