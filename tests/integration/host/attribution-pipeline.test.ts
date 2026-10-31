import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { AgentRegistry, runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { attributionAgent } from "@eval/agents/attribution";
import { compactAgent } from "@eval/agents/compact";
import { attributionWorkflow, attributionRepository, planAttribution } from "@eval/workflows/attribution";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion, taskResult, draftFor, submitFor, parsedMaterial } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

for (const failure of ["component", "trace"] as const) test(`parallel components settle independently; ${failure} failure has the right boundary`, async t => {
  const raw = { batch_id: "batch", case_id: "pipeline", messages: [
    { type: "user_question", content: "生成工作簿。" },
    { type: "llm_turn", name: "planner-excel", output: "运行脚本。" },
    { type: "tool_call", name: "shell", call_id: "build", input: { command: "python make.py" } },
    { type: "tool_result", name: "shell", call_id: "build", output: { exit_code: 0, stdout: "saved workbook.xlsx" } },
    { type: "llm_turn", name: "llm-call-final", output: "已生成工作簿。" },
    { type: "final_answer", content: "已生成工作簿。" },
  ] };
  const f = await fixtureConfig([[raw], [], [], []]); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.inputs.versions[0]!.adapter = "b";
  const config = { ...f.config, workflow: "attribution" as const, inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } };
  const plan = await planAttribution(config), agents = new AgentRegistry([compactAgent, attributionAgent]);
  let active = 0, peak = 0, release = () => {};
  const overlap = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const workers = await Promise.all([0, 1].map(index => startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const profile = options.spec.evaluation.profile;
      calls.push(String(profile));
      if (profile === "component") {
        peak = Math.max(peak, ++active); if (active === 2) release();
        await overlap;
        try {
          if (failure === "component" && (parsedMaterial(options.spec) as { current_component: { name: string } }).current_component.name === "make.py") throw new Error("component investigation unavailable");
          assert.notEqual((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).isError, true);
        } finally { active--; }
      } else {
        if (profile === "trace" && failure === "trace") throw new Error("trace summary unavailable");
        assert.notEqual((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).isError, true);
      }
    }, async abort() { release(); }, async dispose() {} };
  } }, path.join(f.directory, "worker-" + index))));
  t.after(() => Promise.all(workers.map(worker => worker.close())));
  const runId = "pipeline-" + failure;
  await runEvaluation({ ...services, report: async () => ({}), agents, repository: attributionRepository, taskSource: attributionWorkflow,
    runId, output: config.output, config, plan, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution, modelForStage: f.modelForStage, concurrency: 2, retries: 0, retryDelaySeconds: 0,
    failureGuard: { enabled: false, windowSize: 50, threshold: 5 }, workerUrls: workers.map(worker => worker.url), signal: AbortSignal.timeout(20000) });
  const state = await attributionRepository.readRun(path.join(config.output.path, runId));
  const components = state.manifest.tasks.filter(task => task.stage === "attribution-component");
  assert.equal(components.length, 4); assert.equal(peak, 2, "independent component tasks overlap within shared capacity");
  const trace = state.manifest.tasks.find(task => task.stage === "attribution-trace")!, session = state.manifest.tasks.find(task => task.stage === "attribution-session")!;
  assert.equal(calls.filter(profile => profile === "trace").length, 1);
  assert(!calls.includes("assembly"), "single-turn session assembly uses no model");
  if (failure === "component") {
    assert.equal(components.filter(task => state.manifest.states[task.id]!.status === "failed").length, 1);
    assert.equal(state.manifest.states[trace.id]!.status, "succeeded");
    assert.equal(state.manifest.states[session.id]!.status, "succeeded", JSON.stringify(state.manifest.states[session.id]));
    assert((state.receipts[session.id]!.evaluation as { turns: { summary: string }[] }).turns[0]!.summary.includes("覆盖不完整"));
  } else {
    assert.equal(state.manifest.states[trace.id]!.status, "failed");
    assert.equal(state.manifest.states[session.id]!.status, "blocked"); assert(!state.receipts[session.id]);
  }
});
