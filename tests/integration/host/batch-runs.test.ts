import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { createFileLogger, readJson, writeJson, writeJsonl } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import type { AgentBackend } from "@eval/contracts";
import { buildPlan, readRunState, prepareFailedTasks } from "@eval/workflows/comparison";
import { type Candidate } from "@eval/workflows/inputs";
import { startDashboard } from "../../../apps/host/src/dashboard.js";
import { DashboardBatches } from "../../../apps/host/src/dashboard-batches.js";
import { DashboardErrors } from "../../../apps/host/src/dashboard-errors.js";
import { loadComparisonConfig } from "../../../apps/host/src/config.js";
import { services } from "../../fixtures/services.js";
import { fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, inspectFor, submitFor, draftFor, taskResult } from "../../fixtures/comparison.js";

test("batch API freezes scope, persists across restart, and exposes runs outside the dashboard default directory", async t => {
  const fixture = await fixtureConfig([[raw("chosen"),raw("outside")],[],[],[]]);
  t.after(() => rm(fixture.directory,{ recursive:true,force:true }));
  const configFile = path.join(fixture.directory,"config.json");
  await writeJson(configFile,{ ...fixture.config,evaluatorVersion:fakeEvaluatorVersion,
    models:{judge:{channel:"evaluation-gateway",model:"fixture",thinking:"off"}},
    bindings:Object.fromEntries(["criteria","attribution","comparison","rewrite","clustering"].map(stage=>[stage,{profile:"judge"}])) });
  const source = await listen(async (_req,res) => json(res,{
    task:{ id:"task",name:"AIME专项",source:"aime",category:"task" },batch_ids:["package"],models:["aime_fast"],comparisons:[],
    output_dir:path.join(fixture.directory,"eval_output/1_task_eval/task"),
    records:[{ model:"aime_fast",batch_id:"b1",case_id:"chosen",input_file:fixture.config.inputs.versions[0]!.sources[0]!.path,
      input_index:0,package_id:"package",package_name:"one.7z",original_file:"one.7z/member.jsonl",original_line:5 }],
  }),0);
  t.after(() => source.close());
  const options = { configPaths:[configFile],port:0,batchDirectory:path.join(fixture.directory,"launches"),dataUrl:source.url,modelCatalog:async () => [] };
  let server = await startDashboard(options); t.after(() => server.close());
  const post = (pathname:string,body:unknown) => fetch(server.url + pathname,{ method:"POST",headers:{'content-type':'application/json',origin:server.url},body:JSON.stringify(body) });
  const response = await post('/api/dashboard/batch-runs/preview',{ batch_ids:["package"] });
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const preview = await response.json();
  assert.equal(preview.summary.valid_inputs,1); assert.equal(preview.summary.attribution_tasks,1); assert.equal(preview.summary.comparison_tasks,0);
  const catalog = new DashboardBatches(options.batchDirectory,source.url), entry = (await catalog.get(preview.run_id))!;
  const host = await loadComparisonConfig([configFile,catalog.config(entry.runId)]);
  assert.equal(host.evaluation.inputs.workbench!.records[0]!.case_id,"chosen");
  assert.equal(host.evaluation.clustering.enabled,false);
  // A preview can stop after inputs.json is durable but before launch.json is published.
  await writeJson(catalog.config("unfinished-preview"), { inputs: {} });
  assert.deepEqual((await catalog.list()).map(run => run.runId), [entry.runId]);
  await server.close(); server = await startDashboard(options);
  const listed = await fetch(server.url+'/api/dashboard/batch-runs').then(response => response.json());
  assert.equal(listed.runs[0].run_id,entry.runId);
  assert.equal((await fetch(server.url+'/api/dashboard/runs')).status,200);
  // Empty gateway catalog blocks launch before touching recovery state or sending a model call.
  assert.equal((await post(`/api/dashboard/batch-runs/${entry.runId}/start`,{})).status,400);
  assert.match((await catalog.get(entry.runId))!.error!,/模型/);
  assert.equal((await post('/api/dashboard/runs',{ runId:entry.runId })).status,409);
  assert.equal((await post(`/api/dashboard/batch-runs/${entry.runId}/retry`,{})).status,409);
  // Missing registrations are incomplete, but a corrupted published registration is still an error.
  await writeFile(catalog.file("unfinished-preview"), "{bad");
  await assert.rejects(catalog.list(), SyntaxError);
});

test("scoped failure retry and interrupted resume preserve accepted results, coordinates and error history", async t => {
  const fixture = await fixtureConfig([[raw("one"),raw("other")],[],[],[]]);
  t.after(() => rm(fixture.directory,{ recursive:true,force:true }));
  const config = fixture.config;
  config.comparisons = [];
  config.inputs.workbench = { task:{ id:"task",name:"任务",source:"aime",category:"task" },batch_ids:["pkg"],records:[0,1].map(index => ({
    model:"a_fast",batch_id:"b1",case_id:index ? "other" : "one",input_file:config.inputs.versions[0]!.sources[0]!.path,input_index:index,
    package_id:"pkg",package_name:"p.7z",original_file:"p.7z/nested/data.jsonl",original_line:index+20,
  })) };
  const calls:string[] = [];
  let fail = true;
  const backend:AgentBackend = { identity:fakeIdentity,async createSession(options) { return {
    async run() {
      calls.push(options.spec.taskId);
      if (fail && options.spec.evaluation.id === 'attribution') throw new Error('fixture connection failed');
      await inspectFor(options);
      const result = await submitFor(options,draftFor(options.spec,taskResult(options.spec)));
      assert.equal(result.isError,undefined,JSON.stringify(result));
    },async abort(){},async dispose(){},
  }; } };
  const worker = await startWorker(backend,path.join(fixture.directory,'worker')); t.after(() => worker.close());
  const logDirectory = path.join(fixture.directory,'log'),logger = createFileLogger({directory:logDirectory,lockDirectory:path.join(fixture.directory,'log-lock')});
  const plan = await buildPlan(config), run = path.join(config.output.path,'batch-recovery');
  const options = { ...services,logger,runId:'batch-recovery',output:config.output,engine:'pi' as const,identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
    config,plan,policy:config.execution,modelForStage:fixture.modelForStage,concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url] };
  await runEvaluation(options);
  const before = await readRunState(run), accepted = structuredClone(before.receipts);
  const failed = before.manifest.tasks.find(task => task.stage === 'attribution')!;
  const errors = new DashboardErrors(logDirectory);
  const displayed = await errors.read(run,new URLSearchParams());
  assert.equal(displayed.unresolved_count,2);
  assert(displayed.tasks.some(task => task.locations.some(location => location.original_line === 20 && location.package_id === 'pkg')));
  assert(displayed.records.some(item => item.record.evaluator_model === 'fixture'));
  fail = false;
  const repair = await prepareFailedTasks(run,{ taskIds:[failed.id],apply:true });
  assert.equal(repair.count,1);
  await runEvaluation({ ...options,plan:{ tasks:[],inputs:{},summary:{} } });
  const after = await readRunState(run);
  for (const [id,receipt] of Object.entries(accepted)) assert.deepEqual(after.receipts[id],receipt);
  assert(after.receipts[failed.id]);
  assert.equal(after.manifest.states[failed.id].attempts,2);
  const unresolved = await errors.read(run,new URLSearchParams());
  assert.equal(unresolved.unresolved_count,1);
  const history = await errors.read(run,new URLSearchParams({history:'true'}));
  assert(history.records.some(item => item.task?.task_id === failed.id && item.recovery === 'recovered'));
  // Expanding the unfinished scope must not discover answers appended to a cleaned file.
  await writeJsonl(config.inputs.versions[0]!.sources[0]!.path,[raw('one'),raw('other'),raw('outside')]);
  await runEvaluation({ ...options,discoverInputs:true,plan:{ tasks:[],inputs:{},summary:{} } });
  const completed = await readRunState(run);
  assert((completed.manifest.inputCatalog as Candidate[]).every(row => row.case_id !== 'outside'));
  assert.equal(Object.keys(completed.receipts).length,completed.manifest.tasks.length);
  assert.equal(calls.filter(id => id === failed.id).length,2);
  assert.equal((await errors.read(run,new URLSearchParams())).unresolved_count,0);
  assert.equal((await readJson<any>(path.join(run,'state.json'))).runId,'batch-recovery');
});
