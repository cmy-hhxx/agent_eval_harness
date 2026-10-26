import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type RunState } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { cite, evidenceSources } from "@eval/tools";
import { attributionAgent } from "@eval/agents/attribution";
import { fixtureConfig, emptyAudit, fakeEvaluatorVersion, fakeIdentity } from "../../../../tests/fixtures/comparison.js";
import { planAttribution, bindAttribution, attributionRepository, type AttributionConfig } from "./index.js";
import type { RawInput } from "../inputs/types.js";

function trace(question: string, answer: string, tools: string) {
  return {
    meta: { trace_id: `trace-${question}`, session_id: "session-1", n_messages: 4, tool_names_text: tools, skill_names_text: "" },
    messages: [
      { type: "user_question", role: "user", content: question },
      { type: "llm_turn", name: "expert", input_messages: [{ role: "user", content: question }],
        output: [{ role: "assistant", content: "", tool_calls: [{ id: `call-${question}`, function: { name: tools.split(",")[0], arguments: "{}" } }] }] },
      { type: "tool_result", name: tools.split(",")[0], output: { rows: [] } },
      { type: "final_answer", role: "assistant", content: answer },
    ],
  };
}

function session(): RawInput {
  return { batch_id: "batch", case_id: "session-1", has_standard_answer: false,
    meta: { session_id: "session-1", case_id: "session-1", n_traces: 2, n_messages: 8 },
    traces: [trace("第一问", "第一答", "FinQuery,Search"), trace("第二问", "第二答", " web_search ")] } as unknown as RawInput;
}

async function fixture(t: TestContext) {
  const f = await fixtureConfig([[session()], [], [], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  return f;
}

test("an attribution plan fans out one component task per trace component and one final session task", async t => {
  const f = await fixture(t);
  const config = { ...f.config, workflow: "attribution", inputs: { ...f.config.inputs,
    versions: f.config.inputs.versions.slice(0, 1) } } as AttributionConfig;
  const plan = await planAttribution(config);
  assert.deepEqual(plan.summary.issues, []);
  const byStage = (stage: string) => plan.tasks.filter(task => task.stage === stage);
  assert.equal(byStage("attribution-component").length, 3);
  assert.equal(byStage("attribution-trace").length, 2);
  assert.equal(byStage("attribution-session").length, 1);
  const sessionTask = byStage("attribution-session")[0]!;
  assert.equal(sessionTask.dependencies.trace0, byStage("attribution-trace")[0]!.id);
  assert.equal(sessionTask.dependencies.trace1, byStage("attribution-trace")[1]!.id);
  const component = bindAttribution(byStage("attribution-component")[0]!, plan.inputs, {});
  assert.equal(component.profile, "component");
  assert.equal((component.request.input as { component?: string }).component, "finquery 取数服务");
  assert.equal((component.request.input as { trace_index?: number }).trace_index, 0);
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
});
