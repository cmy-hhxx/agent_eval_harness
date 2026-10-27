import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, ValidationError, type AttemptSpec, type RunState, type WorkflowDefinition } from "@eval/contracts";
import { AgentRegistry, RunStore } from "@eval/host";
import { RunHotStore, runJournalIdentity } from "@eval/data";
import { comparisonWorkflow, comparisonRepository } from "@eval/workflows/comparison";
import { cite, evidenceSources } from "@eval/tools";
import { attributionAgent } from "@eval/agents/attribution";
import { fixtureConfig, emptyAudit, fakeEvaluatorVersion, fakeIdentity, criteriaResultForTask } from "../../../../tests/fixtures/comparison.js";
import { planAttribution, planAttributionUnit, bindAttribution, attributionRepository, attributionWorkflow, type AttributionConfig, type AttributionTaskData } from "./index.js";
import type { RawInput } from "../inputs/types.js";

function trace(sessionId: string, question: string, answer: string, tools: string) {
  return {
    meta: { trace_id: `${sessionId}-trace-${question}`, session_id: sessionId, n_messages: 4, tool_names_text: tools, skill_names_text: "" },
    messages: [
      { type: "user_question", role: "user", content: question },
      { type: "llm_turn", name: "expert", input_messages: [{ role: "user", content: question }],
        output: [{ role: "assistant", content: "", tool_calls: [{ id: `call-${question}`, function: { name: tools.split(",")[0], arguments: "{}" } }] }] },
      { type: "tool_result", name: tools.split(",")[0], output: { rows: [] } },
      { type: "final_answer", role: "assistant", content: answer },
    ],
  };
}

function session(sessionId = "session-1"): RawInput {
  return { batch_id: "batch", case_id: sessionId, has_standard_answer: false,
    meta: { session_id: sessionId, case_id: sessionId, n_traces: 2, n_messages: 8 },
    traces: [trace(sessionId, "第一问", "第一答", "FinQuery,Search"), trace(sessionId, "第二问", "第二答", " web_search ")] } as unknown as RawInput;
}

async function fixture(t: TestContext) {
  const f = await fixtureConfig([[session()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  return f;
}

for (const workflow of [attributionWorkflow, comparisonWorkflow] as WorkflowDefinition[])
  for (const resume of [false, true])
    test(`${workflow.id} ${resume ? "resumed" : "new"} multi-trace components commit through Host and preserve evidence validation`, async t => {
      const f = await fixtureConfig([[session()], [], [session()], []]);
      let store: RunStore | undefined;
      t.after(async () => { await store?.close(); await rm(f.directory, { recursive: true, force: true }); });
      const config = workflow.id === "attribution" ? { ...f.config, workflow: "attribution", inputs: {
        ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1),
      } } : f.config;
      let plan = await workflow.plan(config);
      const run = path.join(f.directory, "component-acceptance");
      const repository = workflow.id === "attribution" ? attributionRepository : comparisonRepository;
      let state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "component-acceptance",
        status: "running", engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
        tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
        states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
        preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
      for (const task of plan.tasks.filter(task => task.stage === "criteria")) {
        state.manifest.states[task.id]!.status = "succeeded";
        state.receipts[task.id] = { taskId: task.id, attemptId: "criteria", submissionId: `criteria-${task.id}`,
          status: "succeeded", acceptedAt: 1, evaluatorVersion: fakeEvaluatorVersion, judge: "fixture",
          evaluation: criteriaResultForTask(task, plan.inputs), audit: emptyAudit(), usage: emptyUsage() };
      }
      if (resume) {
        await repository.writeRun(run, state);
        state = await repository.readRun(run);
        plan = await workflow.reconcile!(run, state, config);
      }
      const agents = new AgentRegistry([attributionAgent]);
      store = new RunStore(run, state, plan.inputs, { repository, agents, taskSource: workflow },
        undefined, new RunHotStore(":memory:", runJournalIdentity(state)));
      const components = plan.tasks.filter(task => task.stage === "attribution-component" &&
        (task.data as AttributionTaskData).component === "终稿生成轮");
      assert(components.some(task => (task.data as AttributionTaskData).traceIndex === 1));
      for (const task of components) {
        const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([key, id]) => [key, state.receipts[id]]));
        const binding = workflow.bind(task, plan.inputs, dependencies, { tasks: plan.tasks });
        const prepared = agents.prepare(binding), raw = binding.request.sources.answer!.value as RawInput;
        const messageIndex = raw.messages.length - 1;
        const source = evidenceSources(raw.messages[messageIndex]).find(source => source.kind === "text")!;
        const evidence = cite(binding.request.sources.answer!.id, messageIndex, source, 0, source.text.length);
        const bank = [...prepared.evidenceBank];
        if (!bank.includes(evidence.evidence_id)) bank.push(evidence.evidence_id);
        const spec: AttemptSpec = { runId: state.manifest.runId, taskId: task.id, attemptId: `attempt-${task.id}`,
          inputRevision: 1, engine: fakeIdentity, evaluation: prepared.evaluation, prompt: prepared.prompt,
          evidenceBank: prepared.evidenceBank, policy: DEFAULT_POLICY,
          inputs: Object.entries(task.inputIds).map(([name, id]) => ({ name, id })),
          hostUrl: "http://localhost", deadline: Date.now() + 60000,
          model: { provider: "fixture", baseUrl: "http://localhost", api: "openai-completions", apiKeyEnv: "FIXTURE_KEY",
            model: "fixture", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 } };
        await store.activate(spec);
        await store.registerEvidenceBank({ taskId: task.id, attemptId: spec.attemptId, evidenceBank: bank });
        const problem = { label: "最终回答缺少可核查结论", definition: "最终回答只给出简短答复，缺少支持其结论的数据。",
          problem_phenomena: "当前问答没有展示结论依据。", reason: "原文只包含简短答复，无法核对数据与推导过程。",
          evidence: [{ index: bank.indexOf(evidence.evidence_id) + 1, reason: "直接定位本轮最终回答。" }] };
        const submission = { taskId: task.id, attemptId: spec.attemptId, submissionId: `submission-${task.id}`,
          evaluation: { problems: [problem] }, audit: { ...emptyAudit(), evidenceBank: bank }, usage: emptyUsage() };
        await assert.rejects(store.accept({ ...submission, evaluation: { problems: [{ ...problem,
          evidence: [{ index: bank.length + 1, reason: "不存在的证据不能接受。" }] }] } }), ValidationError);
        assert.equal(await store.receipt(task.id), undefined);
        const receipt = await store.accept(submission);
        assert.equal(receipt.status, "succeeded");
        assert.equal((await store.receipt(task.id))!.submissionId, submission.submissionId);
        assert.equal(state.manifest.states[task.id]!.status, "succeeded");
      }
      await store.persistCheckpoint();
      const restored = await repository.readRun(run);
      for (const task of components) assert.equal(restored.receipts[task.id]!.status, "succeeded");
    });

test("an attribution plan fans out one component task per trace component and one final session task", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config);
  assert.deepEqual(plan.summary.issues, []);
  const byStage = (stage: string) => plan.tasks.filter(task => task.stage === stage);
  assert.equal(byStage("attribution-component").length, 6);
  assert.deepEqual(byStage("attribution-component").map(task => (task.data as AttributionTaskData).component).filter(component => component === "终稿生成轮").length, 2);
  assert.equal(byStage("attribution-component").some(task => /^(?:llm[-_]?call|span)[-_: /]/iu.test((task.data as AttributionTaskData).component ?? "")), false);
  assert.equal(byStage("attribution-trace").length, 2);
  assert.equal(byStage("attribution-session").length, 1);
  const sessionTask = byStage("attribution-session")[0]!;
  assert.equal(sessionTask.dependencies.trace0, byStage("attribution-trace")[0]!.id);
  assert.equal(sessionTask.dependencies.trace1, byStage("attribution-trace")[1]!.id);
  const toolTask = byStage("attribution-component").find(task => (task.data as AttributionTaskData).component?.startsWith("finquery"))!;
  const component = bindAttribution(toolTask, plan.inputs, {});
  assert.equal(component.profile, "component");
  assert.equal((component.request.input as { component?: string }).component, "finquery 取数服务");
  assert.equal((component.request.input as { trace_index?: number }).trace_index, 0);
});

test("planning filters execution locators and always creates one final-generation task per trace", () => {
  const candidate = { input_id: "11111111-1111-4111-8111-111111111111", case_id: "case", turns: [{
    trace_index: 0, trace_id: "trace", question: "问题", final_index: 1, component_names: ["llm-call-7", "span-4f26f1fabe23fc3c", "planner-search"],
  }] };
  const tasks = planAttributionUnit(candidate as never).tasks;
  const components = tasks.filter(task => task.stage === "attribution-component")
    .map(task => (task.data as AttributionTaskData).component);
  assert.deepEqual(components, ["中间推理处理", "流程处理", "planner-search 检索规划子模型", "终稿生成轮"]);
  assert.equal(components.some(component => /^(?:llm[-_]?call|span)[-_: /]/iu.test(component ?? "")), false);
});

test("only the session task exports one attribution row while component and trace tasks stay in state", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config), run = path.join(config.output.path, "session-run");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "session-run", status: "finished",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
    tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, states: {}, preflight: plan.summary, startedAt: 1 },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  for (const task of plan.tasks) {
    const evaluation = task.stage === "attribution-component"
      ? { component: (task.data as {component:string}).component, problems: [] }
      : task.stage === "attribution-trace"
        ? { meta: {}, summary: "该轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" }
        : { session_meta: { session_id: "session-1" }, turns: [
          { meta: {}, summary: "第一轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
          { meta: {}, summary: "第二轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
        ], session_summary: "整场完成。", session_problem: [] };
    state.receipts[task.id] = { taskId: task.id, attemptId: `attempt-${task.id}`, submissionId: `submission-${task.id}`,
      evaluatorVersion: fakeEvaluatorVersion, judge: "fixture", status: "succeeded", acceptedAt: 1,
      evaluation, audit: emptyAudit(), usage: emptyUsage() };
    state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  }
  await attributionRepository.createResultWriter(run, plan.inputs)(state);
  const files = await readdir(path.join(run, "results"));
  assert.deepEqual(files, ["attribution.jsonl"]);
  const lines = (await readFile(path.join(run, "results", "attribution.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).session_summary, "整场完成。");
  assert.equal(plan.tasks.filter(task => task.stage !== "attribution-session").every(task => !state.receipts[task.id]!.exported), true);
});

test("trace and session tasks declare no worker sources and therefore pass source binding", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config);
  for (const task of plan.tasks.filter(task => task.stage === "attribution-trace" || task.stage === "attribution-session")) {
    assert.deepEqual(task.inputIds, {});
    const binding = bindAttribution(task, plan.inputs, {});
    assert.deepEqual(binding.request.sources, {});
    assert.equal(Object.entries(task.inputIds).every(([name, id]) => binding.request.sources[name]?.id === id), true);
  }
});

test("a completed session is appended before the run ends and resume does not duplicate it", async t => {
  const f = await fixtureConfig([[session("session-1"), session("session-2")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config), run = path.join(config.output.path, "incremental-run");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "incremental-run", status: "running",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const sessionTasks = plan.tasks.filter(task => task.stage === "attribution-session");
  const complete = (taskId: string, sessionId: string) => {
    state.receipts[taskId] = { taskId, attemptId: `attempt-${taskId}`, submissionId: `submission-${taskId}`,
      evaluatorVersion: fakeEvaluatorVersion, judge: "fixture", status: "succeeded", acceptedAt: 1,
      evaluation: { session_meta: { session_id: sessionId }, turns: [
        { meta: {}, summary: "第一轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
        { meta: {}, summary: "第二轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
      ], session_summary: `${sessionId} 完成。`, session_problem: [] }, audit: emptyAudit(), usage: emptyUsage() };
    state.manifest.states[taskId] = { status: "succeeded", attempts: 1 };
  };
  const ids = plan.catalog!.map(candidate => (candidate as { input_id: string }).input_id);
  const first = sessionTasks.find(task => (task.data as AttributionTaskData).candidate.input_id === ids[0])!;
  const second = sessionTasks.find(task => (task.data as AttributionTaskData).candidate.input_id === ids[1])!;
  complete(first.id, "session-1");
  await attributionRepository.createResultWriter(run, plan.inputs)(state);
  assert.equal(state.manifest.status, "running");
  assert.equal((await readFile(path.join(run, "results", "attribution.jsonl"), "utf8")).trim().split("\n").length, 1);

  await attributionRepository.writeRun(run, state);
  const resumed = await attributionRepository.readRun(run);
  assert.equal(resumed.receipts[first.id]?.exported?.file, "attribution.jsonl");
  complete(second.id, "session-2");
  resumed.receipts[second.id] = state.receipts[second.id];
  resumed.manifest.states[second.id] = state.manifest.states[second.id]!;
  await attributionRepository.createResultWriter(run, plan.inputs)(resumed);
  await attributionRepository.createResultWriter(run, plan.inputs)(resumed);
  const rows = (await readFile(path.join(run, "results", "attribution.jsonl"), "utf8")).trim().split("\n")
    .map(line => JSON.parse(line) as { session_meta: { session_id: string } });
  assert.deepEqual(rows.map(row => row.session_meta.session_id), ["session-1", "session-2"]);
});

test("component review resolves evidence into readable position, tool component and a short exact quote", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config);
  const task = plan.tasks.find(item => item.stage === "attribution-component" && (item.data as {component:string}).component === "finquery 取数服务")!;
  const binding = bindAttribution(task, plan.inputs, {});
  const registry = new AgentRegistry([attributionAgent]); registry.prepare(binding);
  const raw = binding.request.sources.answer.value as RawInput;
  const source = evidenceSources(raw.messages[2]).find(item => item.kind === "text")!;
  const evidence = cite(binding.request.sources.answer.id, 2, source, 0, Math.min(12, source.text.length));
  const audit = { ...emptyAudit(), evidenceBank: [evidence.evidence_id] };
  const result = registry.resolve(binding, { problems: [{ label: "零行结果未识别", definition: "应返回数据的查询返回空结果。",
    problem_phenomena: "第一问把零行结果当成有数据。", reason: "工具实际返回空结果。",
    evidence: [{ index: 1, reason: "证明工具返回零行。" }] }] }, audit) as { problems: {
      evidence: { position: string; component: string; quote: string }[] }[] };
  assert.equal(result.problems[0]!.evidence[0]!.component, "tool_call: finquery 取数服务");
  assert.match(result.problems[0]!.evidence[0]!.position, /^trace_index 0 \/ message_index 2 \/ path \//u);
  assert.equal(result.problems[0]!.evidence[0]!.quote, evidence.quote);
  assert.throws(() => registry.resolve(binding, { problems: [{ label: "tmp", definition: "tmp",
    problem_phenomena: "tmp", reason: "tmp", evidence: [{ index: 1, reason: "tmp" }] }] }, audit),
  (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "placeholder_content"));
});

test("component quote validation accepts 800 chars but rejects longer exact quotes", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config);
  const task = plan.tasks.find(item => item.stage === "attribution-component" && (item.data as {component:string}).component === "finquery 取数服务")!;
  const binding = bindAttribution(task, plan.inputs, {}), raw = binding.request.sources.answer.value as RawInput;
  const registry = new AgentRegistry([attributionAgent]); registry.prepare(binding);
  const output = raw.messages[2] as Record<string, unknown>;
  const draft = { problems: [{ label: "长证据仍可精确核验", definition: "工具返回包含需要直接核对的长段原文。",
    problem_phenomena: "下游使用了该长段中的结论。", reason: "长段原文完整保留并可由坐标复核。",
    evidence: [{ index: 1, reason: "证明工具返回了该段原文。" }] }] };
  const resolveLength = (length: number) => {
    output.output = { rows: [], payload: "证".repeat(length) };
    const source = evidenceSources(output).filter(item => item.kind === "text").sort((a, b) => b.text.length - a.text.length)[0]!;
    const evidence = cite(binding.request.sources.answer.id, 2, source, 0, length);
    return () => registry.resolve(binding, draft, { ...emptyAudit(), evidenceBank: [evidence.evidence_id] });
  };
  assert.doesNotThrow(resolveLength(800));
  assert.throws(resolveLength(801), (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "quote_too_long"));
});
