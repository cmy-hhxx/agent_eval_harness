import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POLICY, emptyUsage, ValidationError, type AttemptSpec, type RunState, type WorkflowDefinition } from "@eval/contracts";
import { AgentRegistry, RunStore } from "@eval/host";
import { RunHotStore, runJournalIdentity } from "@eval/data";
import { comparisonWorkflow, comparisonRepository } from "@eval/workflows/comparison";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import { attributionAgent } from "@eval/agents/attribution";
import { fixtureConfig, emptyAudit, fakeEvaluatorVersion, fakeIdentity, criteriaResultForTask } from "../../../../tests/fixtures/comparison.js";
import { planAttribution, planAttributionUnit, bindAttribution, attributionRepository, attributionWorkflow, type AttributionConfig, type AttributionTaskData } from "./index.js";
import type { RawInput } from "../inputs/types.js";

function trace(sessionId: string, question: string, answer: string, tools: string) {
  return {
    meta: { trace_id: `${sessionId}-trace-${question}`, session_id: sessionId, n_messages: 4, tool_names_text: tools, skill_names_text: "" },
    messages: [
      { type: "user_question", role: "user", content: question },
      { type: "llm_turn", name: "expert", system_prompt: "PRIVATE_SYSTEM_SENTINEL", input_messages: [{ role: "user", content: question }],
        output: [{ role: "assistant", content: "", tool_calls: [{ id: `call-${question}`, function: { name: tools.split(",")[0], arguments: "{}" } }] }] },
      { type: "tool_result", name: tools.split(",")[0], output: { rows: [] } },
      { type: "final_answer", role: "assistant", content: answer },
    ],
  };
}

function session(sessionId = "session-1"): RawInput {
  const first = trace(sessionId, "第一问", "第一答", "FinQuery,Search");
  return { batch_id: "batch", case_id: sessionId, has_standard_answer: false,
    meta: { session_id: sessionId, case_id: sessionId, n_traces: 2, n_messages: 8 },
    traces: [{ ...first, message_pool: [{ role: "user", content: "第一问" }],
      messages: first.messages.map((message, index) => index === 1 ? { ...message, input_messages: [0] } : message) },
      trace(sessionId, "第二问", "第二答", " web_search ")] } as unknown as RawInput;
}

async function fixture(t: TestContext) {
  const f = await fixtureConfig([[session()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  return f;
}

test("same session different captured traces append unchanged and resume by trace identity", async t => {
  const capture = (caseId: string, question: string) => ({
    batch_id: "batch", case_id: caseId, has_standard_answer: false,
    meta: { session_id: "shared-session", case_id: caseId, n_traces: 1, n_messages: 4 },
    traces: [trace("shared-session", question, `${question}回答`, "Search")],
  } as unknown as RawInput);
  const f = await fixtureConfig([[capture("capture-1", "第一问"), capture("capture-2", "第二问")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config), run = path.join(f.directory, "captured-traces");
  const sessions = plan.tasks.filter(task => task.stage === "attribution-session");
  assert.equal(sessions.length, 2, "captured records are evaluated independently");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "captured-traces", status: "running",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const registry = new AgentRegistry([attributionAgent]);
  const complete = (index: number, target: RunState) => {
    const task = sessions[index]!, candidate = (task.data as AttributionTaskData).candidate;
    const raw = plan.inputs[candidate.input_id] as RawInput;
    const turn = { meta: raw.turns![0]!.meta!, summary: `第${index + 1}轮总结`, problem: [], is_correct: null,
      correct_reason: "未提供标准答案。" };
    const dependency = { taskId: task.dependencies.trace0!, attemptId: "trace", submissionId: `trace-${index}`,
      evaluatorVersion: fakeEvaluatorVersion, judge: "fixture", status: "succeeded" as const, acceptedAt: 1,
      evaluation: turn, audit: emptyAudit(), usage: emptyUsage() };
    const binding = bindAttribution(task, plan.inputs, { trace0: dependency });
    const evaluation = registry.resolve(binding, { session_summary: `记录${index + 1}总结`, session_problem: [] }, emptyAudit());
    target.receipts[task.id] = { ...dependency, taskId: task.id, submissionId: `session-${index}`, evaluation };
    target.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  };
  complete(0, state);
  await attributionRepository.createResultWriter(run, plan.inputs)(state);
  const file = path.join(run, "results/attribution.jsonl");
  const original = "  " + (await readFile(file, "utf8")).trimEnd() + " \n";
  await writeFile(file, original);
  const inode = (await stat(file)).ino;
  // A same-run checkpoint's result reference is resolved from its source trace directory.
  state.receipts[sessions[0]!.id]!.exported!.id = "shared-session";
  await attributionRepository.writeRun(run, state);
  const resumed = await attributionRepository.readRun(run);
  assert.deepEqual(resumed.receipts[sessions[0]!.id]!.evaluation, state.receipts[sessions[0]!.id]!.evaluation);
  complete(1, resumed);
  const hot = new RunHotStore(":memory:", runJournalIdentity(resumed));
  for (const task of sessions) hot.append({ at: 1, receipts: { [task.id]: resumed.receipts[task.id]! } });
  const store = new RunStore(run, resumed, plan.inputs, { repository: attributionRepository, agents: registry,
    taskSource: attributionWorkflow }, undefined, hot);
  t.after(() => store.close());
  await store.flushOutbox(true);
  assert.equal(store.outboxStatus().count, 0, "pending receipts must drain through normal outbox delivery");
  assert.equal(hot.eventsAfter().length, 2, "delivery retains original accepted journal events");
  const writer = attributionRepository.createResultWriter(run, plan.inputs);
  await writer(resumed);
  await writer(resumed);
  assert.equal((await stat(file)).ino, inode, "existing output file must not be replaced");
  const text = await readFile(file, "utf8");
  assert(text.startsWith(original), "existing result bytes must remain unchanged");
  const rows = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.session_meta.session_id), ["shared-session", "shared-session"]);
  assert.deepEqual(rows.map(row => row.turns[0].meta.trace_id), ["shared-session-trace-第一问", "shared-session-trace-第二问"]);
  await attributionRepository.writeRun(run, resumed);
  const restored = await attributionRepository.readRun(run);
  assert.equal(restored.receipts[sessions[1]!.id]!.submissionId, "session-1");
  restored.receipts[sessions[1]!.id]!.evaluation = { ...(restored.receipts[sessions[1]!.id]!.evaluation as object), session_summary: "冲突正文" };
  await assert.rejects(attributionRepository.createResultWriter(run, plan.inputs)(restored), /结果 ID 对应冲突结果/);
  assert.equal(await readFile(file, "utf8"), text);
});

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
        if (resume && workflow.id === "attribution")
          for (const [name, id] of Object.entries(task.inputIds))
            assert.equal(state.manifest.inputs[id]?.id, binding.request.sources[name]!.id,
              "resumed task sources must retain their manifest IDs before dispatch");
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
        const projectedSource = evidenceSources(raw.messages[1]).find(source => source.path === "/system_prompt")!;
        const projected = cite(binding.request.sources.answer!.id, 1, projectedSource, 0, projectedSource.text.length);
        const projectedBank = [...bank, projected.evidence_id];
        await store.registerEvidenceBank({ taskId: task.id, attemptId: spec.attemptId, evidenceBank: projectedBank });
        await assert.rejects(store.accept({ ...submission, audit: { ...emptyAudit(), evidenceBank: projectedBank },
          evaluation: { problems: [{ ...problem, evidence: [{ index: projectedBank.length, reason: "展示占位符不能证明原始记录缺失。" }] }] } }), error => {
          assert(error instanceof ValidationError);
          assert(error.issues?.some(issue => issue.code === "evidence_original_scope" && issue.path === "/problems/0/evidence/0/index"));
          assert(!JSON.stringify(error.issues).includes("PRIVATE_SYSTEM_SENTINEL"));
          return true;
        });
        assert.equal(await store.receipt(task.id), undefined);
        const receipt = await store.accept({ ...submission, audit: { ...submission.audit, evidenceBank: projectedBank } });
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

test("explicit attribution records retain their requested session order instead of source scan order", async t => {
  const f = await fixtureConfig([[session("first"), session("second")], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const original = await planAttribution(config);
  const candidates = original.tasks.filter(task => task.stage === "attribution-session")
    .map(task => (task.data as AttributionTaskData).candidate);
  config.inputs.records = candidates.toReversed().map(candidate => ({ model: candidate.version, batch_id: candidate.batch_id,
    case_id: candidate.case_id, input_file: candidate.source, input_index: candidate.line - 1 }));
  const selected = await planAttribution(config);
  assert.deepEqual(selected.tasks.filter(task => task.stage === "attribution-session")
    .map(task => (task.data as AttributionTaskData).candidate.case_id), ["second", "first"]);
  assert.equal(selected.tasks.length, original.tasks.length);
});

test("component startup presents bounded original evidence with stable selectable references and precise read coverage", async t => {
  const f = await fixtureConfig([[{ batch_id: "batch", case_id: "scene", messages: [
    { type: "user_question", role: "user", content: "核对查询结果。" },
    { type: "tool_call", name: "finquery", call_id: "q1", input: { query: "收入" } },
    { type: "tool_result", name: "finquery", call_id: "q1", output: { rows: [{ value: 10 }] } },
    { type: "llm_turn", system_prompt: "PRIVATE_SYSTEM_SENTINEL", input_messages: [{ role: "user", content: "核对查询结果。" }],
      output: [{ role: "assistant", content: "收入是10。" }] },
    { type: "final_answer", content: "收入是10。" },
  ] }], [], [], []]);
  f.config.inputs.versions[0]!.adapter = "b";
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await planAttribution({ ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig);
  const task = plan.tasks.find(task => task.stage === "attribution-component" &&
    (task.data as AttributionTaskData).component === "finquery 取数服务")!;
  const binding = bindAttribution(task, plan.inputs, {}), registry = new AgentRegistry([attributionAgent]);
  const material = binding.modelInput!.answer as Record<string, any>, scene = material.component_scene;
  assert(scene?.entries.length > 0);
  assert(scene.entries.length <= 8);
  assert(!JSON.stringify(scene).includes("PRIVATE_SYSTEM_SENTINEL"));
  const prepared = registry.prepare(binding), bank = [...prepared.evidenceBank];
  const source = binding.request.sources.answer!.value as RawInput;
  for (const entry of scene.entries) {
    const point = parseEvidenceCoordinates(entry.reference.evidence_id)!;
    assert(point.kind !== "image");
    assert(entry.quote.length > 0 && entry.quote.length <= 400);
    assert.equal(entry.quote, evidenceSources(source.messages[point.message_index])
      .find(source => source.kind === point.kind && source.path === point.path)!.text.slice(point.start, point.end));
    assert(bank.includes(entry.reference.evidence_id));
    assert(binding.presentedReads!.some(read => read.message_index === point.message_index && read.path === point.path &&
      read.start <= point.start && read.end >= point.end));
  }
  prepared.renderAttempt(DEFAULT_POLICY, { ...emptyAudit(), evidenceBank: bank, errors: [], contentSubmissions: 0,
    fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "previous" });
  assert.deepEqual(prepared.evidenceBank, bank);
});

test("component entrypoints stay bounded while preserving every source call and the full navigation", async t => {
  const messages: RawInput["messages"] = [{ type: "user_question", role: "user", content: "核对十次查询。" }];
  for (let index = 0; index < 10; index++) messages.push(
    { type: "tool_call", name: "finquery", call_id: `query-${index}`, input: { query: `Q${index}` } },
    { type: "tool_result", name: "finquery", call_id: `query-${index}`, output: { rows: [{ value: index }] } });
  messages.push({ type: "llm_turn", input_messages: [{ role: "user", content: "核对十次查询。" }],
    output: [{ role: "assistant", content: "查询完成。" }] }, { type: "final_answer", content: "查询完成。" });
  const f = await fixtureConfig([[{ batch_id: "batch", case_id: "queries", messages }], [], [], []]);
  f.config.inputs.versions[0]!.adapter = "b";
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await planAttribution({ ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } });
  assert.deepEqual(plan.summary.issues, []);
  const task = plan.tasks.find(task => (task.data as AttributionTaskData).component === "finquery 取数服务")!;
  const directed = bindAttribution(task, plan.inputs, {});
  const entries = directed.modelInput!.component_entrypoints as { component: string; message_index: number;
    read_request: { tool: string; arguments: { candidate: string; transition_index: number } } }[];
  assert.equal(plan.tasks.filter(task => (task.data as AttributionTaskData).component === "finquery 取数服务").length, 10);
  assert.equal(entries.length, 1, "each task navigates directly to its own invocation");
  assert.equal(directed.modelInput!.component_entrypoints_total, 1);
  const navigation = directed.materialNavigation!.answer as { responsibility_choices: { component: string; transition_index: number }[] };
  assert.equal(navigation.responsibility_choices.filter(choice => choice.component === "finquery 取数服务").length, 10);
  assert(navigation.responsibility_choices.some(choice => choice.component !== "finquery 取数服务"),
    "cross-component context remains available for causal checks");
  assert.deepEqual((directed.request.sources.answer!.value as RawInput).messages, messages);
  for (const entry of entries) {
    assert.equal(entry.component, "finquery 取数服务");
    assert.equal(entry.read_request.tool, "read_responsibility_chain");
    assert.equal(entry.read_request.arguments.candidate, "answer");
    assert(navigation.responsibility_choices.some(choice => choice.component === entry.component &&
      choice.transition_index === entry.read_request.arguments.transition_index));
  }
});

test("planning filters execution locators and always creates one final-generation task per trace", () => {
  const candidate = { input_id: "11111111-1111-4111-8111-111111111111", case_id: "case", turns: [{
    trace_index: 0, trace_id: "trace", question: "问题", final_index: 1,
    component_scopes: ["llm-call-7", "span-4f26f1fabe23fc3c", "planner-search"].map(component => ({ component, message_indices: [0] })),
  }] };
  const tasks = planAttributionUnit(candidate as never).tasks;
  const components = tasks.filter(task => task.stage === "attribution-component")
    .map(task => (task.data as AttributionTaskData).component);
  assert.deepEqual(components, ["中间推理处理", "流程处理", "planner-search 检索规划子模型", "终稿生成轮"]);
  assert.equal(components.some(component => /^(?:llm[-_]?call|span)[-_: /]/iu.test(component ?? "")), false);
});

test("trace correctness without a standard is program-owned and survives session assembly", async t => {
  const f = await fixture(t);
  const plan = await planAttribution({ ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } });
  const task = plan.tasks.find(task => task.stage === "attribution-trace")!;
  const dependencies = Object.fromEntries(Object.keys(task.dependencies).map(label =>
    [label, { evaluation: { problems: [] } } as never]));
  const binding = bindAttribution(task, plan.inputs, dependencies), registry = new AgentRegistry([attributionAgent]);
  assert.deepEqual(binding.request.input.ground_truth, { available: false, value: null });
  const prepared = registry.prepare(binding);
  assert.deepEqual(Object.keys(prepared.evaluation.outputSchema.properties as object), ["summary"]);
  const expected = { meta: binding.request.input.trace_meta, summary: "已审查本轮。", problem: [],
    is_correct: null, correct_reason: "未提供标准答案，无法判断回答与标准答案是否一致；已确认的问题独立保留。" };
  for (const fields of [{}, ...[0, 1, null].map(is_correct => ({ is_correct, correct_reason: "与标准答案一致。" }))]) {
    const result = registry.resolve(binding, { summary: expected.summary, ...fields }, emptyAudit());
    registry.validate(binding, result, emptyAudit());
    assert.deepEqual(result, expected);
  }
  const sessionTask = plan.tasks.find(task => task.stage === "attribution-session")!;
  const sessionBinding = bindAttribution(sessionTask, plan.inputs, { trace0: { evaluation: expected } as never });
  const result = registry.resolve(sessionBinding, { session_summary: "整场汇总。", session_problem: [] }, emptyAudit()) as { turns: unknown[] };
  assert.deepEqual(result.turns, [expected]);
});

for (const reference of [0, false, "给定标准答案"]) test(`trace passes through standard ${JSON.stringify(reference)} and requires a comparison`, async t => {
  const raw = session(); raw.has_standard_answer = true; raw.meta!.std_answer = reference;
  const f = await fixtureConfig([[raw], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await planAttribution({ ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } });
  const task = plan.tasks.find(task => task.stage === "attribution-trace")!;
  const binding = bindAttribution(task, plan.inputs, {}), registry = new AgentRegistry([attributionAgent]);
  assert.deepEqual(binding.request.input.ground_truth, { available: true, value: reference });
  assert.deepEqual(registry.prepare(binding).evaluation.outputSchema.required, ["summary", "is_correct", "correct_reason"]);
  assert.throws(() => registry.resolve(binding, { summary: "已审查本轮。" }, emptyAudit()), ValidationError);
  for (const is_correct of [0, 1, null]) {
    const result = registry.resolve(binding, { summary: "已审查本轮。", is_correct, correct_reason: "依据给定标准作比较。" }, emptyAudit()) as { is_correct: unknown; correct_reason: string };
    registry.validate(binding, result, emptyAudit());
    assert.equal(result.is_correct, is_correct);
    assert.equal(result.correct_reason, "依据给定标准作比较。");
  }
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
        { meta: { trace_id: `${sessionId}-trace-第一问` }, summary: "第一轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
        { meta: { trace_id: `${sessionId}-trace-第二问` }, summary: "第二轮完成。", problem: [], is_correct: null, correct_reason: "无给定标准。" },
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
  assert.doesNotThrow(() => registry.resolve(binding, { problems: [{ label: "错误", definition: "无法判断",
    problem_phenomena: "无法判断", reason: "无法判断", evidence: [{ index: 1, reason: "无法判断" }] }] }, audit),
  "legal prose is accepted without a wording-based quality gate; semantic quality is reviewed separately");
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
