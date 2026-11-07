import { isTraceAttributionTask } from "@eval/workflows/attribution";
import { compactAgent } from "@eval/agents/compact";
import { compactReceipt, bindAttributionFixture as bindAttribution } from "../../../../tests/fixtures/compact.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type JsonObject, type RunState } from "@eval/contracts";
import { AgentRegistry, RunStore } from "@eval/host";
import { RunHotStore, runJournalIdentity } from "@eval/data";
import { attributionAgent } from "@eval/agents/attribution";
import { fixtureConfig, emptyAudit, fakeEvaluatorVersion, fakeIdentity } from "../../../../tests/fixtures/comparison.js";
import { compactFieldResult, attributionRepository, attributionWorkflow, type AttributionConfig, type AttributionTaskData } from "./index.js";
import { stagedAttributionPlan as planAttribution } from "../../../../tests/fixtures/shards.js";
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

test("session and trace metadata pass through unchanged without entering model material", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config), registry = new AgentRegistry([attributionAgent]);
  const traceTask = plan.tasks.find(task => isTraceAttributionTask(task))!;
  const traceBinding = bindAttribution(traceTask, plan.inputs, {});
  assert(!Object.hasOwn(traceBinding.modelInput!, "trace_meta"));
  const prepared = registry.prepare(traceBinding), audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const turn = registry.resolve(traceBinding, { summary: "该轮已完成。" }, audit) as { meta: unknown };
  assert.deepEqual(turn.meta, traceBinding.request.input.trace_meta);
  const sessionTask = plan.tasks.find(task => task.stage === "attribution-session")!;
  const sessionBinding = bindAttribution(sessionTask, plan.inputs, {
    trace0: { evaluation: turn } as never, trace1: { evaluation: turn } as never,
  });
  assert(!Object.hasOwn(sessionBinding.modelInput!, "session_meta"));
  assert(!Object.hasOwn(sessionBinding.modelInput!, "turns"));
  const result = registry.resolve(sessionBinding, { session_summary: "整场已完成。", session_problem: [] }, { ...emptyAudit(), evidenceBank: registry.prepare(sessionBinding).evidenceBank }) as { session_meta: unknown; turns: { meta: unknown }[] };
  assert.deepEqual(result.session_meta, sessionBinding.request.input.session_meta);
  assert.deepEqual(result.turns.map(trace => trace.meta), [turn.meta, turn.meta]);
});

test("component material retains a script's later real execution and its receipt after an earlier help call", async t => {
  const command = "cat > /work/calc1.py <<'PY'\n" + "# padding\n".repeat(500) + "PY\npython scripts/calc.py --code-file /work/calc1.py";
  const input = { batch_id: "batch", case_id: "calculator", messages: [
    { type: "user_question", content: "计算数据。" },
    { type: "tool_call", name: "shell", call_id: "help", input: { command: "python scripts/calc.py --help" } },
    { type: "tool_result", name: "shell", tool_call_id: "help", output: { stdout: "usage: calc.py" } },
    { type: "tool_call", name: "shell", call_id: "run", input: { command } },
    { type: "tool_result", name: "shell", tool_call_id: "run", output: { stdout: "Calculation completed; saved calculation.json" } },
    { type: "final_answer", content: "计算完成。" },
  ] };
  const f = await fixtureConfig([[input], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions[0]!.adapter = "b";
  const plan = await planAttribution({ ...f.config, workflow: "attribution", inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig);
  const task = plan.tasks.find(task => (task.data as AttributionTaskData).compactField === "components")!;
  const binding = attributionWorkflow.bind(task, plan.inputs, {}, { tasks: plan.tasks });
  const view = (binding.modelInput!.turns as JsonObject[])[0]!;
  const excerpts = view.process_excerpts as JsonObject[];
  assert(excerpts.some(entry => entry.message_index === 3 && String(entry.quote).includes("python scripts/calc.py --code-file /work/calc1.py")));
  assert(excerpts.some(entry => entry.message_index === 4 && String(entry.quote).includes("Calculation completed; saved calculation.json")));
  assert((view.execution_facts as JsonObject).execution_links);
});

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
    const evaluation = { session_meta: raw.session_meta ?? raw.meta ?? {}, turns: [turn], session_summary: `记录${index + 1}总结`, session_problem: [] };
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


test("compact is a mandatory dependency and produces its own recoverable formal line", async t => {
  const f = await fixture(t), config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config), registry = new AgentRegistry([compactAgent, attributionAgent]);
  const fields = plan.tasks.filter(task => task.stage === "attribution-compact-field");
  assert.equal(fields.length, 17);
  assert(fields.every(task => Object.keys(task.dependencies).length === 0), "field sessions are independent");
  const compact = plan.tasks.find(task => task.stage === "attribution-compact")!, candidate = (compact.data as AttributionTaskData).candidate;
  for (const task of plan.tasks.filter(task => isTraceAttributionTask(task) || task.stage === "attribution-session")) assert.equal(task.dependencies.compact, compact.id);
  const traceTask = plan.tasks.find(task => isTraceAttributionTask(task))!;
  const binding = attributionWorkflow.bind(traceTask, plan.inputs, { compact: compactReceipt(2) }, { tasks: plan.tasks });
  assert(Array.isArray(binding.modelInput!.component_results));
  assert.throws(() => attributionWorkflow.bind(traceTask, plan.inputs, {}, { tasks: plan.tasks }), /必须先接受/);
  const draft = compactReceipt(2).evaluation as JsonObject;
  const dependencies = Object.fromEntries(fields.map(task => {
    const { compactField: field, traceIndex } = task.data as AttributionTaskData;
    const fieldBinding = attributionWorkflow.bind(task, plan.inputs, {}, { tasks: plan.tasks });
    const prepared = registry.prepare(fieldBinding);
    assert.equal(prepared.maxToolCalls, 0);
    const input = field === "components" ? { value: (fieldBinding.request.input.recorded_components as JsonObject[]).map(actor => ({
      components_kind: actor.kind, components_name: actor.anonymous === true ? "答案合成" : actor.name,
      components_content: "为回答用户问题执行对应动作；实际输出见原文。", actor_indices: [actor.component_index],
      evidence: [prepared.evidenceBank.indexOf(((actor.source_evidence as JsonObject[])[0]!.reference as JsonObject).evidence_id as string) + 1],
    })) } : compactFieldResult(draft, field!, traceIndex);
    const evaluation = registry.resolve(fieldBinding, input, { ...emptyAudit(), evidenceBank: prepared.evidenceBank });
    registry.validate(fieldBinding, evaluation, emptyAudit());
    return [traceIndex === undefined ? field! : `${traceIndex}:${field}`, { ...compactReceipt(2), taskId: task.id, evaluation }];
  }));
  const compactBinding = attributionWorkflow.bind(compact, plan.inputs, dependencies, { tasks: plan.tasks });
  assert.equal((dependencies.session_overview!.evaluation as { value: unknown[] }).value.length, 2,
    "inserting code-owned tool counts must not mutate the accepted overview field receipt");
  assert(compactBinding.computedResult, "assembly is performed by code");
  const evaluation = registry.resolve(compactBinding, compactBinding.computedResult, emptyAudit());
  registry.validate(compactBinding, evaluation, emptyAudit());
  const run = path.join(f.directory, "compact-run"), state: RunState = { manifest: { format: "evaluation-run", debug: false,
    runId: "compact-run", status: "running", engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks,
    inputCatalog: plan.catalog, inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: { ...Object.fromEntries(Object.values(dependencies).map(receipt => [receipt.taskId, receipt])),
      [compact.id]: { ...compactReceipt(2), taskId: compact.id, evaluation } },
    usage: emptyUsage(), recordedAttempts: 0 };
  state.manifest.states[compact.id]!.status = "succeeded";
  const writer = attributionRepository.createResultWriter(run, plan.inputs); await writer(state); await writer(state);
  const text = await readFile(path.join(run, "results/compact.jsonl"), "utf8");
  assert.equal(text.trim().split("\n").length, 1);
  const saved = JSON.parse(text);
  assert.deepEqual(Object.keys(saved), ["session_overview", "session_meta", "trace_meta", "turns"]);
  assert(saved.turns.every((turn: JsonObject) => Array.isArray(turn.components) && typeof turn.final_answer === "string"));
  assert(saved.session_overview[1].includes("实际调用工具"));
  await attributionRepository.writeRun(run, state);
  const checkpoint = await readFile(path.join(run, "state.json"), "utf8");
  assert(!checkpoint.includes("custom_section"), "compact body is referenced rather than copied into state");
  const resumed = await attributionRepository.readRun(run);
  assert.deepEqual(resumed.receipts[compact.id]!.evaluation, evaluation);
  for (const receipt of Object.values(dependencies)) assert.deepEqual(resumed.receipts[receipt.taskId]!.evaluation, receipt.evaluation);
  assert.deepEqual((resumed.receipts[compact.id]!.evaluation as JsonObject).session_meta, saved.session_meta);
  assert.equal((compact.data as AttributionTaskData).candidate.version, candidate.version);
  assert.throws(() => registry.resolve(compactBinding, { ...draft, turns: (draft.turns as JsonObject[]).slice(0, 1) }, emptyAudit()));
});

test("performance identity carries only record coordinates, never input bodies", () => {
  const task = { id: "t", stage: "attribution-component", dependencies: {}, inputIds: { answer: "input-1" },
    data: { stage: "attribution-component", traceIndex: 1, attributionIdentity: "identity-1",
      candidate: { input_id: "input-1", version: "aime_fast", batch_id: "2026-11-05", case_id: "case-1", session_id: "session-1" } } };
  const identity = attributionWorkflow.performanceIdentity!(task as unknown as Parameters<NonNullable<typeof attributionWorkflow.performanceIdentity>>[0]);
  assert.deepEqual(identity, { version: "aime_fast", batch_id: "2026-11-05", case_id: "case-1",
    session_id: "session-1", trace_index: 1, compact_field: null, component_group: null, attribution_identity: "identity-1" });
});
