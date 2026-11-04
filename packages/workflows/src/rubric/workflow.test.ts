import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { emptyUsage, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { writeJsonl, runLayout } from "@eval/data";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { rubricAgent, rubricProfile, type RubricCase } from "@eval/agents/rubric";
import { fixtureConfig, sessionRaw, emptyAudit, fakeIdentity } from "../../../../tests/fixtures/comparison.js";
import { planRubric, rubricWorkflow, rubricRepository, type RubricConfig, type RubricTaskData } from "./index.js";
import { loadRubricStandard } from "./catalog.js";
import { services } from "../../../../tests/fixtures/services.js";

async function fixture(t: TestContext) {
  const f = await fixtureConfig();
  t.after(() => rm(f.directory, {recursive: true, force: true}));
  const standard = path.resolve("rubric/overseas-expert-v1.json"), category = loadRubricStandard(standard).categories.get("FIN-L2-053")!;
  const row = sessionRaw("rubric");
  const trace = row.traces[0]!;
  const meta = {...trace.meta, task: category.l1_name, subtask: category.name};
  const messages = [{type: "user_question", content: "我持有股票，是否减仓？"},
    {type: "tool_result", content: "PRIVATE_TOOL_RESULT"}, {type: "final_answer", content: "先等待，不要立即减仓。"}];
  const input = {...row, batch_id: "rsi_test", case_id: "session-rubric",
    meta: {...row.meta, case_id: "session-rubric", n_traces: 2, n_messages: 6},
    traces: [{meta: {...meta, n_messages: 3}, messages},
      {meta: {...meta, trace_id: "second-trace", n_messages: 3}, messages: messages.map(message => ({...message}))}]};
  const file = path.join(f.directory, "input.jsonl"), attribution = path.join(f.directory, "attribution.jsonl");
  await writeJsonl(file, [input]);
  const attr = {session_meta: {session_id: "session-rubric"}, session_summary: "跨轮总结", session_problem: [],
    turns: input.traces.map((trace, index) => ({meta: trace.meta, summary: `归因${index}`, is_correct: null, correct_reason: null,
      problem: [{label: "fixture", problem_phenomena: `PHENOMENON_${index}`, reason: "个案解释", evidence: []}]}))};
  await writeJsonl(attribution, [attr]);
  const config: RubricConfig = {...f.config, workflow: "rubric", inputs: {versions: [
    {id: "model", name: "model", adapter: "b", sources: [{kind: "file", path: file}]}]},
    output: {...f.config.output, layout: "business"},
    rubric: {standard, attribution, labels: {mode: "inline", paths: ["traces[].meta.subtask"]}, batchSize: 10}};
  const plan = await planRubric(config);
  const state: RunState = {manifest: {format: "evaluation-run", debug: false, runId: "rubric-test", status: "running",
    engine: fakeIdentity, evaluatorVersion: "fixture", config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, {status: "pending", attempts: 0}])),
    preflight: plan.summary, startedAt: 1}, receipts: {}, usage: emptyUsage(), recordedAttempts: 0};
  return {config, plan, state, attr, modelForStage: () => f.modelForStage("attribution")};
}

function accept(state: RunState, taskId: string, evaluation: unknown): SubmissionReceipt {
  const receipt: SubmissionReceipt = {taskId, attemptId: taskId, submissionId: taskId, status: "succeeded", acceptedAt: 1,
    evaluatorVersion: "fixture", judge: "fixture", evaluation, audit: emptyAudit(), usage: emptyUsage()};
  state.receipts[taskId] = receipt;
  state.manifest.states[taskId] = {status: "succeeded", attempts: 1};
  return receipt;
}

test("多 trace 分批保留全局编号，合并、持久化、续跑并跳过已有正式 case", async t => {
  const {config, plan, state, modelForStage} = await fixture(t);
  const registry = new AgentRegistry([rubricAgent]);
  assert.equal(plan.tasks.filter(task => task.stage === "rubric-batch").length, 8);
  for (const task of plan.tasks.filter(task => task.stage === "rubric-batch")) {
    const binding = rubricWorkflow.bind(task, plan.inputs, {}, {tasks: plan.tasks});
    registry.prepare(binding);
    const material = binding.request.input as unknown as RubricCase;
    const result = rubricProfile.resolve!(binding.request, {case_id: material.case_id,
      verdicts: material.checklist.map(item => ({item_index: item.index, state: "na", reason: "测试材料不足",
        na_reason: "测试没有该条证据", evidence: []}))}, emptyAudit());
    accept(state, task.id, result);
  }
  const merge = plan.tasks.find(task => task.stage === "rubric-case")!;
  const binding = rubricWorkflow.bind(merge, plan.inputs, Object.fromEntries(Object.entries(merge.dependencies).map(([key, id]) => [key, state.receipts[id]])), {tasks: plan.tasks});
  registry.prepare(binding);
  registry.validate(binding, binding.computedResult, emptyAudit());
  const run = runLayout(config.output, state.manifest.runId).directory;
  await rubricRepository.writeRun(run, state);
  const {report: _report, ...base} = services;
  const outcome = await runEvaluation({...base, agents: registry, taskSource: rubricWorkflow, repository: rubricRepository,
    modelForStage, config, plan, output: config.output, runId: state.manifest.runId,
    engine: "pi", identity: fakeIdentity, evaluatorVersion: "fixture", policy: config.execution,
    concurrency: 1, retries: 0, retryDelaySeconds: 0, signal: AbortSignal.timeout(10_000)});
  assert.equal(outcome.outcome, "complete");
  const restored = await rubricRepository.readRun(run);
  assert.deepEqual(restored.receipts[merge.id]!.evaluation, binding.computedResult);
  const resumed = await rubricWorkflow.reconcile!(run, restored, config);
  assert.equal(resumed.tasks.length, 9);
  const final = await readFile(path.join(config.output.path, "rubric.jsonl"), "utf8");
  assert.equal(final.trim().split("\n").length, 1);
  const row = JSON.parse(final);
  assert.equal(row.result.traces.length, 2);
  assert.equal(row.trace_meta[1].trace_id, "second-trace");
  assert.equal(row.result.traces[0].l1_id, "FIN-L1-08");
  const next = await planRubric(config);
  assert.equal(next.tasks.length, 0);
  assert.equal(next.summary.skipped_cases, 1);
  await assert.rejects(planRubric({...config, output: {...config.output, path: path.join(config.output.path, "rubric.jsonl")}}), /ENOTDIR/);
});

test("专项材料和可访问消息均不泄漏归因/工具，通用归因按 trace 对齐", async t => {
  const {plan, state, config} = await fixture(t);
  for (const task of plan.tasks.filter(task => task.stage === "rubric-batch")) {
    const data = task.data as RubricTaskData;
    const binding = rubricWorkflow.bind(task, plan.inputs, {}, {tasks: plan.tasks});
    const shown = JSON.stringify(binding.request);
    if (data.group === "category") {
      assert.ok(!shown.includes("PRIVATE_TOOL_RESULT"));
      assert.ok(!shown.includes("PHENOMENON_"));
      assert.ok(shown.includes("先等待"));
    } else {
      assert.ok(shown.includes("PRIVATE_TOOL_RESULT"));
      assert.ok(shown.includes(`PHENOMENON_${data.traceIndex}`));
      assert.ok(!shown.includes(`PHENOMENON_${1 - data.traceIndex}`));
    }
  }
  const first = plan.tasks[0]!;
  accept(state, first.id, {accepted: true});
  const resumed = await rubricWorkflow.reconcile!("unused", state, config);
  assert.equal(resumed.tasks.length, plan.tasks.length);
  assert.deepEqual(state.receipts[first.id]!.evaluation, {accepted: true});
});

test("缺归因、归因标签冲突、重复归因必须阻止派发", async t => {
  const {config, attr} = await fixture(t);
  await writeJsonl(config.rubric.attribution, []);
  await assert.rejects(planRubric(config), /缺少归因/);
  attr.turns[0]!.meta.task = "错误标签";
  await writeJsonl(config.rubric.attribution, [attr]);
  await assert.rejects(planRubric(config), /L1\/L2/);
  await writeJsonl(config.rubric.attribution, [attr, attr]);
  await assert.rejects(planRubric(config), /重复会话/);
});
