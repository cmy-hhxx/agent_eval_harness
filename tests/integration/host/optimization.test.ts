import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, rm } from "node:fs/promises";
import { emptyUsage, resolveEvidenceSelection, type AgentBackend, type ModelConfig, type RunState, type TaskPlan, type PlannedTask } from "@eval/contracts";
import { fileSourceReader, readJson, writeJsonl } from "@eval/data";
import { buildPlan, comparisonWorkflow } from "@eval/workflows/comparison";
import { createResultWriter } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { readRunState, reconcileRun, writeRunState } from "@eval/workflows/comparison";
import { evidenceSources, messageContentSources, cite, resolveEvidence } from "@eval/tools";
import { waitForTestState } from "../../fixtures/wait.js";
import { canonicalEvidence } from "../../fixtures/evidence.js";
import type { EvalConfig, RawInput, TaskData } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { startWorker } from "@eval/runtime/worker";
import { submitFor, inspectFor,
  inspectedReceiptFor,
  attributionResult,
  draftFor,
  invalidDraft,
  emptyAudit,
  fakeEvaluatorVersion,
  fakeIdentity,
  fakeJudge,
  comparisonResult,
  criteriaResultForTask,
  fixtureConfig,
  parsedMaterial,
  raw,
  taskResult,
} from "../../fixtures/comparison.js";

async function stateFor(config: EvalConfig, plan: TaskPlan, acceptVerifications = true): Promise<RunState> {
  const accepted = plan.tasks.filter((task) => ["criteria", "attribution", "comparison"].includes(task.stage) &&
    (acceptVerifications || !(task.data as TaskData).verificationOf));
  const acceptedIds = new Set(accepted.map((task) => task.id));
  const attributionFor = (task: PlannedTask) => {
    const inputId = task.inputIds.answer;
    const input = plan.inputs[inputId] as RawInput;
    const finalIndex = (task.data as TaskData).candidates.A.final_index;
    const final = messageContentSources(input.messages[finalIndex]).find(source => source.text.length)!;
    const userIndex = input.messages.findIndex(message => message.role === "user");
    const question = evidenceSources(input.messages[userIndex]).find(source => source.kind === "text" && source.path === "/content")!;
    const result = attributionResult(true, final.text, (task.data as TaskData).reference !== null, inputId);
    const actual = canonicalEvidence(inputId, finalIndex, final.text, final.path);
    const norm = canonicalEvidence(inputId, userIndex, question.text, question.path);
    result.correctness_evidence = result.has_standard_answer ? [actual] : [];
    result.criterion_assessments.forEach(item => { item.evidence = [actual, norm]; });
    result.findings[0]!.evidence = [actual];
    return result;
  };
  const state: RunState = {
    manifest: {
      format: "evaluation-run",
      debug: false,
      runId: "test",
      status: "finished",
      engine: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      tasks: plan.tasks,
      inputCatalog: plan.catalog,
      inputs: Object.fromEntries(Object.keys(plan.inputs).map((id) => [id, { id, name: id }])),
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, {
        status: acceptedIds.has(task.id) ? "succeeded" : "pending",
        attempts: acceptedIds.has(task.id) ? 1 : 0,
      }])),
      preflight: plan.summary,
      startedAt: 1,
    },
    receipts: Object.fromEntries(
      accepted.map((task) => [
        task.id,
        {
          taskId: task.id,
          attemptId: "old",
          submissionId: task.id,
          status: "succeeded",
          evaluatorVersion: fakeEvaluatorVersion,
          judge: fakeJudge,
          acceptedAt: 2,
          evaluation: task.stage === "criteria" ? criteriaResultForTask(task, plan.inputs) : task.stage === "attribution"
            ? attributionFor(task)
            : comparisonResult(undefined, criteriaResultForTask(task, plan.inputs)),
          audit: emptyAudit(),
          usage: emptyUsage(),
        },
      ]),
    ),
    usage: { ...emptyUsage(), totalTokens: 123 },
    recordedAttempts: accepted.length,
  };
  for (const task of accepted.filter(task => (task.data as TaskData).verificationOf))
    state.receipts[task.id] = await inspectedReceiptFor(task, state, plan.inputs);
  return state;
}
function dependenciesFor(task: PlannedTask, state: RunState) {
  return Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, state.receipts[id]]));
}

function optionsFor(
  config: EvalConfig,
  modelForStage: (stage: string) => ModelConfig,
  plan: TaskPlan,
  workerUrls: string[],
) {
  return {
    runId: "test",
    config,
    plan,
    output: config.output,
    ...services,
    engine: "pi" as const,
    identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution,
    concurrency: 1,
    retries: 0,
    retryDelaySeconds: 0,
    workerUrls,
    modelForStage,
  };
}
test("attribution and comparison workers receive blind prompts and tool views while source coordinates remain exact", async () => {
  const first = raw("q", "4 来自 secret-model");
  first.messages[0]!.content = "计算2+2；请核查 a_fast 和 b_fast 的结果";
  first.messages[1]!.model = "secret-model";
  first.meta!.usage = { type: "secret-model" };
  first.meta!.first_token_time_cost = "secret-model";
  const second = raw("q", "4 来自 secret-model");
  second.messages[0]!.content = first.messages[0]!.content;
  second.messages[1]!.model = "other-model";
  const { directory, config, modelForStage } = await fixtureConfig([[first], [], [second], []]);
  const plan = await buildPlan(config);
  const stages: string[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          const stage = options.spec.evaluation.id;
          stages.push(stage);
          const input = await readJson<RawInput>(path.join(options.workdir, `inputs/${options.spec.inputs[0]!.name}.json`));
          if (stage === "criteria") {
            assert(!options.spec.prompt.includes('"final_answer"'), "criteria are fixed before answers are exposed");
            await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
          } else if (stage === "attribution") {
            assert.doesNotMatch(options.spec.prompt, /version_id|display_name|answer_model/);
            assert.equal(options.spec.inputs[0]!.name, "answer");
            assert.deepEqual(input, plan.inputs[options.spec.inputs[0]!.id]);
            const read = await options.execute("read_trace", { candidate: "answer", message_index: 1 });
            assert.equal(read.isError, undefined, JSON.stringify(read));
            for (const identity of ["a_fast", "b_fast", "secret-model", "other-model", "A组Fast", "B组Fast"]) {
              assert(!options.spec.prompt.includes(identity), `attribution prompt leaks ${identity}`);
              assert(!JSON.stringify(read).includes(identity), `attribution trace leaks ${identity}`);
            }
            const result = taskResult(options.spec) as { summary: string };
            result.summary = "a_fast 或 b_fast 的有效计算";
            await submitFor(options, draftFor(options.spec, result));
          } else {
            assert.equal(stage, "comparison");
            assert.equal(options.spec.inputs.length, 2);
            const unbound = await fetch(`${options.spec.hostUrl}/api/inputs/${options.spec.inputs[0]!.id}`);
            assert.equal(unbound.status, 404, "the worker cannot bypass its bound blind view");
            const original = plan.inputs[options.spec.inputs[0]!.id] as RawInput;
            assert.deepEqual(input, original, "Worker-owned source files retain the exact original evidence material");
            for (const identity of ["a_fast", "b_fast", "secret-model", "other-model", "A组Fast", "B组Fast"]) {
              assert(!options.spec.prompt.includes(identity), `prompt leaks ${identity}`);
            }
            for (const source of options.spec.inputs) {
              const read = await options.execute("read_trace", { candidate: source.name, message_index: 1 });
              assert.equal(read.isError, undefined, JSON.stringify(read));
              for (const identity of ["a_fast", "b_fast", "secret-model", "other-model", "A组Fast", "B组Fast"])
                assert(!JSON.stringify(read).includes(identity), `model-visible trace leaks ${identity}`);
            }
            await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
          }
        },
        async abort() {},
        async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation(optionsFor(config, modelForStage, plan, [worker.url]));
    const saved = await readRunState(path.join(config.output.path, "test"));
    assert.equal(result.completed_comparisons, 1, JSON.stringify(saved.manifest.states));
    const comparison = saved.manifest.tasks.find((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit)!;
    const row = saved.receipts[comparison.id]!.exported!.row as {
      ground_truth: { value: string };
      evaluations: Record<string, { summary: string }>;
    };
    assert.equal(row.ground_truth.value, "4 来自 secret-model", "formal results keep the original reference");
    assert(row.evaluations.a_fast!.summary.includes("a_fast"), "attribution receipts are not blinded on export");
    assert.deepEqual(stages.sort(), ["attribution", "attribution", "comparison", "criteria"]);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight keeps unknown-batch errors under a selection and aggregates independent field errors", async () => {
  const missing = raw("missing", null);
  delete missing.batch_id;
  const invalid = {
    ...raw("invalid", null),
    request_time: "",
    has_standard_answer: "false",
  } as unknown as RawInput;
  const { directory, config } = await fixtureConfig([[missing, invalid], [], [raw("valid", null)], []]);
  try {
    config.inputs.batches = ["b1"];
    const plan = await buildPlan(config);
    const issues = plan.summary.issues as {
      case_id: string;
      errors: { code: string }[];
    }[];
    assert(issues.some((issue) => issue.case_id === "missing"));
    assert.deepEqual(
      issues.find((issue) => issue.case_id === "invalid")?.errors.map((e) => e.code),
      ["request_time_invalid", "standard_answer_flag_invalid"],
    );
    for (const request_time of [undefined, null, " 2026-09-24  "]) {
      await writeJsonl(config.inputs.versions[0].sources[0].path, [{ ...raw("valid", null), request_time }]);
      assert.deepEqual((await buildPlan(config)).summary.issues, []);
    }
    for (const request_time of ["", "  ", 12, false, {}]) {
      await writeJsonl(config.inputs.versions[0].sources[0].path, [{ ...raw("valid", null), request_time }]);
      assert.equal(((await buildPlan(config)).summary.issues as unknown[]).length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted work survives narrower selection, changed or missing inputs; new groups are added", async () => {
  const rows = ["b1", "b2"].map((batch_id) => ({
    ...raw("q", null),
    batch_id,
  }));
  const { directory, config } = await fixtureConfig([rows, [raw("q", null)], rows, []]);
  try {
    const plan = await buildPlan(config),
      state = await stateFor(config, plan),
      run = path.join(directory, "run");
    await createResultWriter(run, plan.inputs)(state);
    await writeRunState(run, state);
    const restored = await readRunState(run),
      narrowed = structuredClone(config);
    narrowed.inputs.batches = ["b1"];
    for (const version of narrowed.inputs.versions) {
      const content = await readFile(version.sources[0].path, "utf8");
      version.sources[0].path += ".moved";
      await writeJsonl(
        version.sources[0].path,
        content.trim()
          ? content
              .trim()
              .split("\n")
              .map((s) => JSON.parse(s))
          : [],
      );
    }
    const moved = await reconcileRun(run, restored, narrowed);
    assert.deepEqual(
      moved.tasks.map((t) => t.id),
      plan.tasks.map((t) => t.id),
    );
    assert.equal(Object.keys(restored.receipts).length, plan.tasks.length);
    const changed = { ...rows[0], request_time: "2026-09-24" };
    await writeJsonl(narrowed.inputs.versions[0].sources[0].path, [changed, rows[1]]);
    await writeJsonl(narrowed.inputs.versions[3].sources[0].path, [raw("q", null)]);
    const replacement = await reconcileRun(run, restored, narrowed);
    assert.equal(replacement.tasks.length, plan.tasks.length);
    assert.equal(Object.keys(restored.receipts).length, plan.tasks.length);
    const affected = replacement.tasks.find(
      (t) =>
        t.id ===
        plan.tasks.find(
          (t) => t.stage === "comparison" && (t.data as TaskData).candidates.A.batch_id === "b1",
        )!.id,
    )!;
    assert.equal((affected.data as TaskData).revision, 1);
    assert.equal(
      (affected.data as TaskData).comparisonId,
      (plan.tasks.find((t) => t.id === affected.id)!.data as TaskData).comparisonId,
    );
    assert.equal(restored.manifest.states[affected.id].attempts, 1);
    assert.equal(restored.usage.totalTokens, 123);
    await writeRunState(run, restored); // crash after state replacement, before result rebuilding
    const recovered = await readRunState(run);
    assert.equal(Object.keys(recovered.receipts).length, plan.tasks.length);
    await writeJsonl(narrowed.inputs.versions[0].sources[0].path, [{ ...changed, request_time: "" }, rows[1]]);
    const invalid = await reconcileRun(run, recovered, narrowed);
    assert.deepEqual(
      invalid.tasks.filter((t) => recovered.receipts[t.id]).map((t) => t.inputIds),
      replacement.tasks.filter((t) => recovered.receipts[t.id]).map((t) => t.inputIds),
    );
    assert((invalid.summary.issues as unknown[]).length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planned input bodies are read by record only when a task accesses them", async (t) => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  const reads = t.mock.method(fileSourceReader, "record");
  try {
    const plan = await buildPlan(config);
    assert.equal(reads.mock.callCount(), 0);
    const id = Object.keys(plan.inputs)[0];
    assert.deepEqual(plan.inputs[id], raw());
    assert.equal(reads.mock.callCount(), 1, "the planner must retain coordinates, not every original answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("each answer retains its own full system and developer constraints beyond the context budget", async () => {
  const rows = ["不能把风险放在第一位", "必须把风险放在第一位"].map((rule) => ({
    ...raw(), messages: [
      { type: "message", role: "system", content: "背景。".repeat(9000) + rule },
      { type: "message", role: "developer", content: "按自己的系统要求组织回答" },
      ...raw().messages,
    ],
  }));
  const { directory, config } = await fixtureConfig([[rows[0]], [], [rows[1]], []]);
  config.execution.initialContextChars = 1;
  try {
    const plan = await buildPlan(config);
    for (const task of plan.tasks.filter((task) => ["attribution", "comparison"].includes(task.stage) && !(task.data as TaskData).verificationOf)) {
      const bound = comparisonWorkflow.bind(task, plan.inputs, dependenciesFor(task, await stateFor(config, plan, false)), { tasks: plan.tasks });
      type Material = { initial_material: { message_index: number; value: unknown }[]; instruction_sources: {
        message_index: number; path: string; role: string; content: unknown; evidence: ReturnType<typeof cite>[];
      }[] };
      const input = bound.request.input as { answer?: Material; candidates?: Record<string, Material> };
      const materials = input.answer ? { answer: input.answer } : input.candidates!;
      type ShownMaterial = { instruction_sources: { content: unknown; evidence: { reference: { evidence_index: number } }[] }[] };
      const prepared = services.agents.prepare(bound);
      const shown = parsedMaterial(prepared) as { answer?: ShownMaterial; candidates?: Record<string, ShownMaterial> };
      const shownMaterials = shown.answer ? { answer: shown.answer } : shown.candidates!;
      for (const [label, material] of Object.entries(materials)) {
        const source = plan.inputs[task.inputIds[label]] as RawInput;
        const constraints = material.instruction_sources.filter((m) => m.message_index < 2);
        assert.equal(constraints.length, 2);
        assert.deepEqual(constraints.map((m) => m.role), ["system", "developer"]);
        assert.deepEqual(constraints.map((m) => m.path), ["/content", "/content"]);
        assert.deepEqual(constraints.map((m) => m.content), source.messages.slice(0, 2).map((message) => message.content));
        assert.equal(material.initial_material.filter((m) => m.message_index < 2).length, 0);
        if (task.stage === "attribution") assert(shownMaterials[label]!.instruction_sources.every(m => !Object.hasOwn(m, "content")),
          "attribution defers full instruction content while preserving source references");
        else assert.deepEqual(shownMaterials[label]!.instruction_sources.map((m) => m.content), constraints.map((m) => m.content));
        constraints.forEach((constraint, index) => {
          assert.equal(constraint.evidence.length, 1);
          assert.equal(resolveEvidence(source, constraint.evidence[0]!, label, emptyAudit(), "/evidence", task.inputIds[label]).quote, constraint.content);
          const selection = shownMaterials[label]!.instruction_sources[index]!.evidence[0]!.reference;
          assert.deepEqual(Object.keys(selection), ["evidence_index"]);
          const reference = resolveEvidenceSelection(prepared.evidenceBank, selection, "/instruction_sources/" + index + "/evidence/0");
          assert.deepEqual(reference, { evidence_id: constraint.evidence[0]!.evidence_id });
          assert.equal(resolveEvidence(source, reference, label, emptyAudit(), "/evidence", task.inputIds[label]).quote, constraint.content);
        });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const entireAnswer of [false, true]) test(`oversized final-answer blocks preserve original text and direct reads (entire answer: ${entireAnswer})`, async () => {
  const chart = JSON.stringify({ data: [{ y: { dtype: "f8", bdata: "A".repeat(1400000) } }], layout: { title: "业绩比较" } });
  const row = raw();
  const chartPath = entireAnswer ? "/content" : "/content/1/text";
  row.messages[1].content = entireAnswer ? chart : [
    { type: "output_text", text: "比较结论：甲优于乙。" },
    { type: "output_text", text: chart },
    { type: "output_text", text: "图表之后的风险说明。" },
  ];
  const { directory, config } = await fixtureConfig([[row], [], [row], []]);
  try {
    const plan = await buildPlan(config);
    for (const task of plan.tasks.filter((task) => ["attribution", "comparison"].includes(task.stage) && !(task.data as TaskData).verificationOf)) {
      const bound = comparisonWorkflow.bind(task, plan.inputs, dependenciesFor(task, await stateFor(config, plan, false)), { tasks: plan.tasks });
      const input = bound.request.input as any;
      const shown = parsedMaterial(services.agents.prepare(bound)) as any;
      for (const [label, material] of Object.entries(input.answer ? { answer: input.answer } : input.candidates) as [string, any][]) {
        if (entireAnswer) assert.equal(material.final_answer, "");
        else {
          assert(material.final_answer.includes("比较结论"));
          assert(material.final_answer.includes("图表之后的风险说明"));
        }
        assert(!material.final_answer.includes("deferred_final_material"), "harness metadata must not appear as the candidate's answer");
        assert(JSON.stringify(material).length < 50000, "large encoded chart data must not overwhelm the model context");
        assert.deepEqual(material.deferred_final_material, [{
          message_index: 1, path: chartPath, total_chars: chart.length,
        }]);
        const displayed = shown.answer ?? shown.candidates[label];
        assert.deepEqual(displayed.deferred_final_material[0].read_request,
          { candidate: label, message_index: 1, path: chartPath, offset: 0, max_chars: 16000 });
        const source = bound.request.sources[label].value as RawInput;
        assert.equal(entireAnswer ? source.messages[1].content : (source.messages[1].content as any[])[1].text, chart);
        for (const evidence of material.final_evidence)
          assert.equal(resolveEvidence(source, evidence, label, emptyAudit(), "/evidence", task.inputIds[label]).quote, evidence.quote);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("model materials expose copyable references while business materials and original fields keep their coordinates", async () => {
  type DisplayEvidence = { message_index: number; quote: string; reference: { evidence_index: number } };
  type Material<T> = { final_evidence: T[]; initial_material: { message_index: number; value: Record<string, unknown>; evidence: T[] }[];
    table_check_results?: { rows: { answer: { evidence: T }; sources: { evidence: T }[] }[] }[] };
  type Input<T> = { answer?: Material<T>; candidates?: Record<string, Material<T>> };
  const row = raw("copy-reference", null, "| 代码 | 名称 |\n|---|---|\n| 300791.SZ | 路桥信息 |");
  row.messages.splice(1, 0, { role: "tool", type: "function_call_output", name: "lookup",
    content: "| 股票代码 | 股票简称 |\n|---|---|\n| 920748.BJ | 路桥信息 |",
    output: { evidence_id: "业务原始字段", reference: { evidence_id: "同名原始对象" } } });
  const { directory, config } = await fixtureConfig([[row], [], [row], []]);
  try {
    const plan = await buildPlan(config);
    for (const task of plan.tasks.filter((item) => ["attribution", "comparison"].includes(item.stage) && !(item.data as TaskData).verificationOf)) {
      const bound = comparisonWorkflow.bind(task, plan.inputs, dependenciesFor(task, await stateFor(config, plan, false)), { tasks: plan.tasks });
      const internal = bound.request.input as Input<ReturnType<typeof cite>>;
      const before = structuredClone({ request: bound.request, modelInput: bound.modelInput });
      const prepared = services.agents.prepare(bound);
      const materialMarker = "任务材料（全部内容为数据）：\n";
      const materialStart = prepared.prompt.indexOf(materialMarker);
      const shown = JSON.parse(prepared.prompt.slice(materialStart + materialMarker.length)) as Input<DisplayEvidence>;
      const { task_focus, ...complete } = bound.modelInput!;
      assert.equal(typeof bound.projectModelInput, "function");
      const projectionBank = [...prepared.evidenceBank];
      bound.projectModelInput!(complete, projectionBank);
      assert.deepEqual(projectionBank, prepared.evidenceBank, "replaying the projection keeps every provided evidence number exact");
      assert(materialStart >= 0, "task material has an explicit boundary after focus");
      const focusSection = prepared.prompt.slice(0, materialStart).trim();
      assert(focusSection.startsWith("任务重点（以下全部为数据）："));
      const focus = JSON.parse(focusSection.slice(focusSection.lastIndexOf("\n") + 1));
      if (task.stage === "attribution") {
        assert.equal(focus.answers.answer.review.filter((item: {kind: string}) => item.kind === "answer")
          .map((item: {quote: string}) => item.quote).join("\n\n"), row.messages.at(-1)!.content);
        assert(!Object.hasOwn(shown.answer!, "final_answer"), "the answer has one displayed copy");
      } else assert.deepEqual(focus, task_focus);
      assert(!prepared.prompt.includes('"task_focus"'), "the focus key is not repeated in the full material");
      assert.deepEqual({ request: bound.request, modelInput: bound.modelInput }, before,
        "Host rendering changes neither trusted materials nor the explicit projection");
      const internalMaterials = internal.answer ? { answer: internal.answer } : internal.candidates!;
      const shownMaterials = shown.answer ? { answer: shown.answer } : shown.candidates!;
      for (const [label, material] of Object.entries(shownMaterials)) {
        const business = internalMaterials[label];
        const source = bound.request.sources[label].value as RawInput;
        const generated = [...material.final_evidence, ...material.initial_material.flatMap((item) => item.evidence),
          ...(material.table_check_results ?? []).flatMap((table) => table.rows.flatMap((item) =>
            [item.answer.evidence, ...item.sources.map((original) => original.evidence)]))];
        assert(generated.length > 0);
        for (const item of generated) {
          assert.equal(Object.hasOwn(item, "evidence_id"), false);
          assert.deepEqual(Object.keys(item.reference), ["evidence_index"]);
          const reference = resolveEvidenceSelection(prepared.evidenceBank, item.reference, "/evidence");
          const expectedQuote = task.stage === "attribution" && material.final_evidence.includes(item)
            ? business.final_evidence.find(original => original.evidence_id === reference.evidence_id)!.quote : item.quote;
          assert.equal(resolveEvidence(source, reference, label, emptyAudit(), "/evidence", task.inputIds[label]).quote, expectedQuote);
        }
        assert(business.final_evidence.every((item) => typeof item.evidence_id === "string" && !Object.hasOwn(item, "reference")));
        if (task.stage === "attribution") assert.deepEqual(material.initial_material, []);
        else assert.deepEqual(material.initial_material.map((item) => item.value), business.initial_material.map((item) => item.value));
        const original = business.initial_material.find((item) => item.message_index === 1)!.value;
        assert.deepEqual(original.output, { evidence_id: "业务原始字段", reference: { evidence_id: "同名原始对象" } });
        if (material.table_check_results) assert(material.table_check_results[0].rows.length > 0, "table evidence uses the same display projection");
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shared reference revisions preserve task IDs and paid content while invalidating stale recovery material", async () => {
  const { directory, config } = await fixtureConfig([
    [raw()],
    [raw("q1", null)],
    [raw("q1", null)],
    [raw("q1", null)],
  ]);
  try {
    const first = await buildPlan(config);
    await writeJsonl(config.inputs.versions[0].sources[0].path, [raw("q1", "updated")]);
    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "revised", status: "interrupted", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: first.tasks, inputCatalog: first.catalog, inputs: {}, preflight: first.summary, startedAt: 1,
      states: Object.fromEntries(first.tasks.map(task => [task.id, { status: "failed", attempts: 2, revision: 1, durationMs: 17000,
        reason: "old material failed", attemptId: "last-attempt", nextRetryAt: 100,
        failure: { contentSubmissions: 3, fileErrors: 2, errors: [{ category: "evidence", code: "old", path: "/", message: "old" }],
          repeatedErrors: 1, stopped: true, attemptId: "last-attempt", draft: { stale: true },
          evidenceBank: { stale: true }, inspection: { stale: true } },
      }])),
    } } as unknown as RunState;
    const uncertain = first.tasks[0].id;
    const ledgerIssue = { category: "transport" as const, code: "submission_ledger_unavailable", path: "/", message: "final ledger unknown" };
    state.manifest.states[uncertain].failure!.contentSubmissions = 1;
    state.manifest.states[uncertain].failure!.errors.push(ledgerIssue);
    const next = await reconcileRun(directory, state, config);
    assert.equal(next.tasks.length, 4);
    assert.deepEqual(
      next.tasks.map((t) => t.id),
      first.tasks.map((t) => t.id),
    );
    assert(next.tasks.every((t) => (t.data as TaskData).revision === 2));
    for (const task of next.tasks) {
      const progress = state.manifest.states[task.id];
      assert.equal(progress.status, "pending");
      assert.equal(progress.attempts, 2);
      assert.equal(progress.durationMs, 17000);
      assert.equal(progress.failure!.contentSubmissions, task.id === uncertain ? 1 : 3);
      assert.equal(progress.failure!.fileErrors, 2);
      assert.deepEqual(progress.failure!.errors, task.id === uncertain ? [ledgerIssue] : [],
        "source changes invalidate material feedback but cannot erase an unknown execution ledger");
      for (const field of ["draft", "evidenceBank", "inspection"]) assert(!Object.hasOwn(progress.failure!, field));
      for (const field of ["attemptId", "reason", "nextRetryAt"]) assert(!Object.hasOwn(progress, field));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume skips accepted cases after edits and evaluates only unfinished and newly added cases", async () => {
  const rows = [raw("done", null), raw("todo", null)];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const calls: string[] = [];
  let resumed = false;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            await inspectFor(options);
            const input = await readJson<RawInput>(path.join(options.workdir, `inputs/${options.spec.inputs[0]!.name}.json`));
            if (options.spec.evaluation.id === "attribution") calls.push(input.case_id!);
            if (options.spec.evaluation.id === "attribution" && input.case_id === "todo" && !resumed) throw new Error("stop before submission");
            await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = optionsFor(config, modelForStage, await buildPlan(config), [worker.url]);
    assert.equal((await runEvaluation(options)).completed_comparisons, 1);
    const run = path.join(config.output.path, "test"),
      before = await readRunState(run);
    const accepted = before.manifest.tasks.find((t) => t.stage === "attribution" && before.receipts[t.id])!;
    const original = before.receipts[accepted.id];
    const changed = [
      { ...raw("todo", null), request_time: "new-time" },
      raw("new", null),
      raw("done", "4", "changed completed answer"),
    ];
    for (const version of config.inputs.versions.filter((v) => ["a_fast", "b_fast"].includes(v.id)))
      await writeJsonl(version.sources[0].path, changed);
    resumed = true;
    assert.equal((await runEvaluation(options)).completed_comparisons, 3);
    assert.equal(calls.filter((c) => c === "done").length, 2, "accepted attribution work is not re-evaluated");
    const after = await readRunState(run);
    assert.deepEqual(after.receipts[accepted.id], original);
    assert.deepEqual(
      after.manifest.tasks.find((t) => t.id === accepted.id),
      accepted,
    );
    assert.equal((await validateRun(run)).results.valid, true);
    for (const version of config.inputs.versions) await rm(version.sources[0].path);
    assert.equal((await runEvaluation(options)).completed_comparisons, 3);
    assert.equal(calls.filter((c) => c === "done").length, 2, "accepted attribution work does not require a second model call or an input backup");
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("skip-failed resume streams healthy comparisons and rewrites before the attribution backlog drains", async () => {
  const rows = ["failed", "first", "last"].map((id) => raw(id, null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []], true);
  config.rewrite.attribution = false;
  const plan = await buildPlan(config);
  const saved = await stateFor(config, plan);
  saved.receipts = {};
  for (const state of Object.values(saved.manifest.states)) state.status = "pending";
  const failed = plan.tasks.find((task) => task.stage === "attribution" &&
    Object.values((task.data as TaskData).candidates).some((candidate) => candidate.case_id === "failed"))!;
  saved.manifest.states[failed.id] = { status: "failed", attempts: 3, revision: 1, reason: "leave this failure alone" };
  const run = path.join(config.output.path, "test");
  await writeRunState(run, saved);
  const started: { id: string; stage: string }[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          started.push({ id: options.spec.taskId, stage: options.spec.evaluation.id });
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {},
        async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), skipFailed: true });
    assert.equal(result.completed_comparisons, 2);
    assert(!started.some((task) => task.id === failed.id));
    const after = await readRunState(run);
    assert.deepEqual(after.manifest.states[failed.id], saved.manifest.states[failed.id]);
    assert(started.findIndex((task) => task.stage === "comparison") < started.findLastIndex((task) => task.stage === "attribution"));
    assert(started.findIndex((task) => task.stage === "rewrite") < started.findLastIndex((task) => task.stage === "comparison"));
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "rewrite" && after.receipts[task.id]).length, 2);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const busyProbe of [1, 2]) test(`external worker recovers from busy health probe ${busyProbe} without failing work`, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const started: string[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          started.push(options.spec.taskId);
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  let probes = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    if (String(input) === worker.url + "/api/health" && ++probes === busyProbe)
      return new Response(JSON.stringify({ ...await response.json(), activeAttempt: "still-cleaning-up" }), { status: 200 });
    return response;
  });
  try {
    const plan = await buildPlan(config);
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), signal: AbortSignal.timeout(10000) });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert.equal(started.length, plan.tasks.length);
    assert.equal(new Set(started).size, started.length);
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded" && state.attempts === 1));
  } finally {
    t.mock.restoreAll();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted model stream receives one bounded transport retry", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let interrupted = false;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          if (!interrupted) { interrupted = true; throw new Error("Stream ended without finish_reason"); }
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), retries: 1 });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded"));
    assert.equal(Object.values(after.manifest.states).reduce((n, state) => n + state.attempts, 0), plan.tasks.length + 1);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("retry backoff releases its worker slot for healthy tasks and preserves the retry budget", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const plan = await buildPlan(config), order: string[] = [];
  const first = plan.tasks.find((task) => task.stage === "attribution")!.id;
  const errors: { message: string; context: import("@eval/contracts").LogContext }[] = [];
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options);
      const id = options.spec.taskId;
      order.push(id);
      if (id === first) throw new Error("Stream ended without finish_reason");
      await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]),
      retries: 1, retryDelaySeconds: 1, signal: AbortSignal.timeout(15_000),
      logger: { evaluation: async () => true, error: async (message, context) => { errors.push({ message: String(message), context }); } } });
    assert.notEqual(order[order.indexOf(first) + 1], first, "healthy work must use the only slot while the failed task backs off");
    assert.equal(order.filter(id => id === first).length, 2, "redispatch must not reset the retry budget");
    const after = await readRunState(path.join(config.output.path, "test"));
    assert.equal(after.manifest.states[first].status, "failed");
    assert(Object.values(after.manifest.states).every(state => state.nextRetryAt === undefined));
    const attempts = errors.filter(row => row.context.event === "attempt_failed");
    assert.equal(attempts.length, 2, "record each failed attempt, including the one that will retry");
    assert.equal(new Set(attempts.map(row => row.context.attempt_id)).size, 2);
    assert(attempts.every(row => row.context.stage === "attribution" && row.context.errors?.[0].code === "transport_failed"));
    assert(attempts.every(row => /Stream ended/.test(row.message)));
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed dependencies are checkpointed as one batch", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => raw(String(i), null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config), saved = await stateFor(config, plan);
  saved.receipts = Object.fromEntries(plan.tasks.filter((task) => task.stage === "criteria").map((task) => [task.id, saved.receipts[task.id]]));
  for (const task of plan.tasks) saved.manifest.states[task.id].status = task.stage === "criteria" ? "succeeded" : task.stage === "attribution" ? "failed" : "pending";
  await createResultWriter(path.join(config.output.path, "test"), plan.inputs)(saved);
  await writeRunState(path.join(config.output.path, "test"), saved);
  let writes = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession() { throw new Error("no healthy task should dispatch"); } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), skipFailed: true,
      repository: { ...services.repository, async writeRun(...args) { writes++; return services.repository.writeRun(...args); } },
    });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert.equal(Object.values(after.manifest.states).filter(state => state.status === "blocked").length, 12);
    assert(writes <= 3, `dependency handling saved the whole run ${writes} times`);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a dependency waiting for its transport retry does not permanently block downstream work", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []], true);
  const plan = await buildPlan(config), first = plan.tasks.find(task => task.stage === "attribution")!.id;
  let release!: () => void, failed = false;
  const failureSaved = new Promise<void>(resolve => { release = resolve; });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options);
      if (options.spec.taskId === first && !failed) { failed = true; throw new Error("Stream ended without finish_reason"); }
      if (plan.tasks.find(task => task.id === options.spec.taskId)?.stage === "attribution" && options.spec.taskId !== first) await failureSaved;
      await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1].map(index => startWorker(backend, path.join(directory, 'worker-' + index))));
  try {
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, workers.map(worker => worker.url)),
      concurrency: 2, retries: 1, retryDelaySeconds: 1,
      repository: { ...services.repository, async writeRun(...args) {
        await services.repository.writeRun(...args);
        if (args[1].manifest.states[first]?.status === "failed") release();
      } },
    });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded"));
  } finally { await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true }); }
});

test("normal runs persist drafts before cleanup, carry them to one repair attempt, then clear them", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  let calls = 0,
    firstTask: string | undefined;
  const attempts = new Map<string, number>();
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        let stopped = false;
        return {
          async run() {
            if (stopped) return; // Ignore the bounded nudge so this test reaches a new attempt.
            await inspectFor(options);
            calls++;
            if (options.spec.evaluation.id === "attribution") firstTask ??= options.spec.taskId;
            const attempt = (attempts.get(options.spec.taskId) || 0) + 1;
            attempts.set(options.spec.taskId, attempt);
            if (attempt === 1 && options.spec.taskId === firstTask) {
              const rejected = await submitFor(options, invalidDraft(options.spec));
              assert.equal(rejected.isError, true, "the invalid draft reaches content validation before recovery");
              const state = await readRunState(path.join(config.output.path, "test"));
              assert(state.manifest.states[options.spec.taskId].failure?.draft);
              stopped = true;
            } else {
              if (attempt > 1 && options.spec.taskId === firstTask) {
                assert(options.spec.recovery?.draft);
                assert.deepEqual(
                  await readJson(path.join(options.workdir, "submission-rejected.json")),
                  options.spec.recovery.draft,
                );
              }
              await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
            }
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const stats = await runEvaluation(optionsFor(config, modelForStage, await buildPlan(config), [worker.url]));
    assert.equal(calls, 5);
    assert.equal(stats.completed_comparisons, 1);
    const state = await readRunState(path.join(config.output.path, "test"));
    assert.equal(state.manifest.states[firstTask!].failure?.draft, undefined);
    assert.equal(state.receipts[firstTask!].submissionStats?.contentSubmissions, 2);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a responsive external worker is not discarded after a one-second health delay", async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
      await inspectFor(options); await submitFor(options, draftFor(options.spec, taskResult(options.spec))); },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === worker.url + "/api/health")
      await delay(1100, undefined, { signal: init?.signal || undefined });
    return fetch(input, init);
  });
  try {
    const result = await runEvaluation(optionsFor(config, modelForStage, await buildPlan(config), [worker.url]));
    assert.equal(result.completed_comparisons, 1);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [kind, observationError] of [
  ["timeout", new DOMException("Status observation timed out", "TimeoutError")],
  ["connection reset", new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })],
] as const)
test(`a status observation ${kind} keeps the original worker attempt running`, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  let launches = 0, cancellations = 0, timeouts = 0;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      launches++;
      return {
        async run() {
          await inspectFor(options);
          await delay(100);
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.startsWith(worker.url) && url.endsWith("/cancel")) cancellations++;
    if (!timeouts && url.startsWith(worker.url + "/api/attempts/") && init?.method === "GET" &&
        !url.endsWith("/record") && !url.includes("/events")) {
      timeouts++;
      throw observationError;
    }
    return fetch(input, init);
  });
  try {
    const plan = await buildPlan(config);
    const result = await runEvaluation(optionsFor(config, modelForStage, plan, [worker.url]));
    assert.equal(timeouts, 1);
    assert.equal(cancellations, 0, "a transient read failure must not cancel a healthy attempt");
    assert.equal(launches, plan.tasks.length, "accepted work must not be relaunched");
    assert.equal(result.completed_comparisons, 1);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interruption stops the current scheduling scan before preparing more tasks", async (t) => {
  const rows = [raw("one", null), raw("two", null)];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController();
  const original = services.agents.prepare.bind(services.agents);
  const prepared = t.mock.method(services.agents, "prepare", (...args: Parameters<typeof original>) => {
    controller.abort();
    return original(...args);
  });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession() { throw new Error("must not start after interruption"); } };
  const workers = await Promise.all([0, 1, 2, 3].map((i) => startWorker(backend, path.join(directory, `worker-${i}`))));
  try {
    const result = await runEvaluation({ ...optionsFor(config, modelForStage, await buildPlan(config), workers.map((w) => w.url)), signal: controller.signal, concurrency: 4 });
    assert.equal(result.status, "interrupted");
    assert.equal(prepared.mock.callCount(), 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("live concurrency prepares only available slots and shrinking lets healthy attempts finish", async (t) => {
  const rows = [1, 2, 3, 4].map((id) => raw(String(id), null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const prepared = t.mock.method(services.agents, "prepare");
  const started: string[] = [],
    releases = new Map<string, () => void>();
  let aborted = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          started.push(options.spec.taskId);
          await new Promise<void>((resolve) => releases.set(options.spec.taskId, resolve));
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {
          aborted++;
          releases.get(options.spec.taskId)?.();
        },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all(
    [1, 2, 3].map((i) => startWorker(backend, path.join(directory, "w" + i))),
  );
  let execution: Promise<unknown> | undefined;
  try {
    execution = runEvaluation(
      optionsFor(
        config,
        modelForStage,
        await buildPlan(config),
        workers.map((w) => w.url),
      ),
    );
    await waitForTestState(async () => [...started], tasks => tasks.length === 1,
      "initial concurrency starts one task", 3000);
    assert.equal(prepared.mock.callCount(), 1, "a full scheduler must not prepare the rest of the batch");
    const lock = await readJson<{ url: string; token: string }>(
      path.join(config.output.path, "test", ".run-lock"),
    );
    const adjust = async (concurrency: number) => {
      const response = await fetch(lock.url + "/api/control/concurrency", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-run-token": lock.token,
        },
        body: JSON.stringify({ concurrency }),
      });
      assert.equal(response.status, 200);
    };
    await adjust(3);
    await waitForTestState(async () => [...started], tasks => tasks.length === 3,
      "increased concurrency starts three tasks", 3000);
    assert.equal(prepared.mock.callCount(), 3, "growing concurrency prepares only the newly available slots");
    await adjust(1);
    const autoRelease = setInterval(() => {
      for (const id of started) releases.get(id)?.();
    }, 10);
    releases.get(started[0])!();
    releases.get(started[1])!();
    await waitForTestState(async () => (await (await fetch(lock.url + "/api/progress")).json()) as {
      running: number;
    }, progress => progress.running === 1, "reduced concurrency drains to one running task", 3000);
    assert.equal(started.length, 3);
    assert.equal(aborted, 0);
    await execution;
    clearInterval(autoRelease);
    assert.equal(aborted, 0);
  } finally {
    for (const release of releases.values()) release();
    await Promise.all(workers.map((w) => w.close()));
    await execution?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling debug and missing optional artifacts never remove accepted receipts", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  let calls = 0;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            await inspectFor(options);
            calls++;
            await options.execute("execute_code", {
              language: "python",
              code: "print('artifact')",
            });
            await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = optionsFor(config, modelForStage, await buildPlan(config), [worker.url]);
    await runEvaluation(options);
    await runEvaluation({ ...options, debug: true });
    const run = path.join(config.output.path, "test"),
      validation = await validateRun(run);
    assert.equal(calls, options.plan.tasks.length);
    assert.equal(validation.valid, true);
    assert.equal(validation.artifacts.status, "missing");
    assert.equal(validation.completed_comparisons, 1);
    const before = await readRunState(run);
    const file = path.join(run, "results/comparison.jsonl");
    const row = JSON.parse(await readFile(file, "utf8"));
    row.evaluation_type = "invalid";
    await writeJsonl(file, [row]);
    assert.equal((await validateRun(run)).valid, false);
    assert.equal(Object.keys(before.receipts).length, options.plan.tasks.length);
    const comparisonTask = before.manifest.tasks.find((t) => t.stage === "comparison" && !(t.data as TaskData).verificationAudit)!;
    await writeJsonl(file, [before.receipts[comparisonTask.id].exported!.row]);
    const inputFile = (before.manifest.tasks[0].data as TaskData).candidates.A.source;
    await writeJsonl(inputFile, [raw("another-case", null)]);
    const changed = await validateRun(run);
    assert.equal(changed.results.valid, true);
    assert.equal(changed.evidence.valid, false);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
