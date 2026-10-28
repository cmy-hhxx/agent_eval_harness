import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import type { AgentBackend } from "@eval/contracts";
import { buildPlan, readRunState, prepareFailedTasks } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, inspectFor, submitFor, draftFor, taskResult } from "../../fixtures/comparison.js";

test("scoped failure retry and same-run resume preserve accepted results", async t => {
  const fixture = await fixtureConfig([[raw("one"),raw("other")],[],[],[]]);
  t.after(() => rm(fixture.directory,{ recursive:true,force:true }));
  const config = fixture.config;
  config.comparisons = [];
  config.inputs.records = ["one", "other"].map((case_id, input_index) => ({
    model: config.inputs.versions[0]!.id, batch_id: "b1", case_id,
    input_file: config.inputs.versions[0]!.sources[0]!.path, input_index,
  }));
  const calls:string[] = [];
  let fail = true;
  let failedTaskId:string|undefined;
  const backend:AgentBackend = { identity:fakeIdentity,async createSession(options) { return {
    async run() {
      calls.push(options.spec.taskId);
      if (fail && options.spec.evaluation.id === 'attribution' && options.spec.evaluation.profile === 'component') {
        failedTaskId ??= options.spec.taskId;
        if (options.spec.taskId === failedTaskId) throw new Error('fixture connection failed');
      }
      await inspectFor(options);
      const result = await submitFor(options,draftFor(options.spec,taskResult(options.spec)));
      assert.equal(result.isError,undefined,JSON.stringify(result));
    },async abort(){},async dispose(){},
  }; } };
  const worker = await startWorker(backend,path.join(fixture.directory,'worker')); t.after(() => worker.close());
  const plan = await buildPlan(config), run = path.join(config.output.path,'batch-recovery');
  const options = { ...services,runId:'batch-recovery',output:config.output,engine:'pi' as const,identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
    config,plan,policy:config.execution,modelForStage:fixture.modelForStage,concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url] };
  await runEvaluation(options);
  const before = await readRunState(run), accepted = structuredClone(before.receipts);
  assert(Object.keys(accepted).length > 0, 'the healthy input must already have accepted results');
  const failed = before.manifest.tasks.find(task => task.stage.startsWith('attribution-') && before.manifest.states[task.id].status === 'failed')!;
  fail = false;
  const repair = await prepareFailedTasks(run,{ taskIds:[failed.id],apply:true });
  assert(repair.count >= 1);
  assert(repair.selected.some(task => task.task_id === failed.id));
  assert(repair.selected.every(task => !accepted[task.task_id]), 'recovery includes only unaccepted dependencies');
  config.execution.retries = 1;
  await runEvaluation({ ...options,retries:1,plan:{ tasks:[],inputs:{},summary:{} } });
  const after = await readRunState(run);
  for (const [id,receipt] of Object.entries(accepted)) assert.deepEqual(after.receipts[id],receipt);
  assert(after.receipts[failed.id],JSON.stringify(after.manifest.states[failed.id]));
  assert.equal(after.manifest.states[failed.id].attempts,2);
  assert.equal(calls.filter(id => id === failed.id).length,2);
  assert.equal(after.manifest.runId,'batch-recovery');
});
