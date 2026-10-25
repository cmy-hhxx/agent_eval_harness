import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { object, type AgentBackend, type JsonObject } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { loadComparisonEvaluation } from "@eval/host-app/config";
import { startWorker } from "@eval/runtime/worker";
import { parseTraceTables } from "@eval/tools";
import { buildPlan, comparisonCodec, comparisonRow, outputSchema, readRunState, resultFile, type AttributionResult, type ComparisonResult, type TaskData } from "@eval/workflows/comparison";
import { type RawInput } from "@eval/workflows/inputs";
import { canonicalEvidence } from "../../fixtures/evidence.js";
import { attributionResult, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw,
  submitFor, taskResult } from "../../fixtures/comparison.js";
import { ROOT, services, validateRun } from "../../fixtures/services.js";

function baselineAnswer(caseId: string): RawInput {
  return { batch_id: "b1", case_id: caseId, messages: [
    { role: "user", content: "计算2+2" },
    { role: "assistant", content: "2+2=5" },
  ] };
}
function shortTrace(): RawInput {
  return { batch_id: "b1", case_id: "q1", trace_id: "short-trace", messages: [
    { type: "user_question", role: "user", content: "计算2+2" },
    { type: "llm_turn", role: "assistant", model: "short-trace-model", content: "计算得到4。" },
    { type: "final_answer", role: "assistant", content: "2+2=4" },
  ] };
}

test("third-party config retains both A/B tiers and registers an answer-only baseline", async () => {
  const config = await loadComparisonEvaluation([path.join(ROOT, "configs/host.json"), path.join(ROOT, "configs/third-party.example.json")]);
  assert.deepEqual(config.inputs.versions.map(version => version.id), ["a_fast", "a_expert", "b_fast", "b_expert", "baseline_fast"]);
  assert.deepEqual(config.comparisons, [["a_fast", "b_fast", "baseline_fast"], ["a_expert", "b_expert"]]);
  assert.equal(config.inputs.versions.at(-1)!.adapter, "a");
  for (const version of config.inputs.versions)
    assert.equal(version.sources[0].path, path.join(ROOT, "data/sources/model-answers", version.id));
});

test("answer-only and short third-party traces survive independent pairs, formal JSONL and resume", async (t) => {
  const records = [raw("q1"), raw("q2")];
  const { directory, config, modelForStage } = await fixtureConfig([records, [], records, []]);
  const calls: string[] = [];
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    for (const [id, name, adapter, rows] of [
      ["baseline_fast", "Baseline Fast", "a", [baselineAnswer("q1"), baselineAnswer("q2")]],
      ["short_fast", "Short Fast", "b", [shortTrace()]],
    ] as const) {
      const file = path.join(directory, `${id}.jsonl`);
      await writeJsonl(file, rows);
      config.inputs.versions.push({ id, name, comparison_tier: "Fast", adapter, sources: [{ kind: "file", path: file }] });
    }
    config.comparisons = [["a_fast", "b_fast", "baseline_fast"], ["a_fast", "b_fast", "short_fast"], ["baseline_fast", "short_fast"]];
    const plan = await buildPlan(config);
    assert.equal(plan.summary.comparison_tasks, 9, "six distinct pairs for q1, three valid pairs for q2");
    assert.equal(plan.summary.attribution_tasks, 7, "each available answer is assessed once");
    assert.equal(plan.tasks.filter(task => task.stage === "criteria").length, 2);
    assert.equal((plan.summary.skipped as unknown[]).length, 3, "one missing answer skips only its three pairs");
    const identities = config.inputs.versions.flatMap(version => [version.id, version.name, version.display_name].filter(Boolean) as string[]);
    identities.push("short-trace-model");
    const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
      return { async run() {
        const task = plan.tasks.find(task => task.id === options.spec.taskId)!;
        const data = task.data as TaskData;
        calls.push(task.id);
        const result = taskResult(options.spec);
        if (task.stage === "attribution") {
          const candidate = data.candidates.A;
          const input = plan.inputs[candidate.input_id] as RawInput;
          const final = String(input.messages[candidate.final_index].content);
          const evaluation = result as AttributionResult;

          const evidence = canonicalEvidence(candidate.input_id, candidate.final_index, final);


          if(evaluation.Problem.length)evaluation.Problem[0].evidence = [evidence];
          if (candidate.version === "baseline_fast") {
            evaluation.is_correct = false;
            evaluation.correct_reason = "最终回答给出5，与标准答案4不一致；缺少生成链路，无法定位责任。";


            evaluation.summary = "最终计算结果错误，责任依据现有材料推断。";
            evaluation.Problem = attributionResult(false, final, true, candidate.input_id).Problem;

          }
        } else if (task.stage === "comparison") {
          for (const identity of identities)
            assert(!options.spec.prompt.includes(identity), `comparison prompt leaks ${identity}`);
          const material = object(parsedMaterial(options.spec));
          for (const [label, candidate] of Object.entries(data.candidates)) {
            const shown = object(object(material.candidates)[label]);
            if (["baseline_fast", "short_fast"].includes(candidate.version)) {
              assert.equal(object(shown.original_answer_timing).finish_seconds, null);
              const usage = object(shown.original_answer_usage);
              for (const key of ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens"])
                assert.equal(usage[key], null, `missing ${key} is unknown rather than zero`);
            }
            const read = await options.execute("read_trace", { candidate: label, message_index: candidate.final_index });
            assert.equal(read.isError, undefined, JSON.stringify(read));
            for (const identity of identities)
              assert(!JSON.stringify(read).includes(identity), `comparison trace leaks ${identity}`);
          }
          for (const assessment of Object.values((result as ComparisonResult).assessments))
            assessment.summary = "按实际计算交付比较。";
          (result as ComparisonResult).decision_basis.tradeoff = "双方实际计算交付均满足所求结果。";
        }
        const submitted = await submitFor(options, draftFor(options.spec, result));
        assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
        assert.equal(submitted.terminate, true);
      }, async abort() {}, async dispose() {} };
    } };
    worker = await startWorker(backend, path.join(directory, "worker"));
    const runId = "third-party", run = path.join(config.output.path, runId);
    const options = { ...services, runId, output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, policy: config.execution,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], modelForStage };
    const summary = await runEvaluation(options);
    const state = await readRunState(run);
    assert.equal(summary.completed_comparisons, 9, JSON.stringify(state.manifest.states));
    const validateOutput = new Ajv2020({ strict: false }).compile(outputSchema);
    const rows: JsonObject[] = [];
    for await (const row of readJsonl(path.join(run, "results/comparison.jsonl"))) rows.push(row as JsonObject);
    assert.equal(rows.length, 9);
    for (const row of rows) {
      assert(validateOutput(row), JSON.stringify(validateOutput.errors));
      assert.equal(row.status, "decided", "missing traces do not make a confirmed final-answer failure undecidable");
      const task = state.manifest.tasks.find(task => (task.data as TaskData).comparisonId === row.comparison_id)!;
      const data = task.data as TaskData;
      const versions = Object.keys(object(row.models));
      assert.equal(versions.length, 2);
      assert.deepEqual(new Set(versions), new Set(data.group));
      assert.deepEqual(new Set((row.ranking as string[][]).flat()), new Set(versions));
      assert.deepEqual(row.attribution_task_ids, Object.fromEntries(Object.entries(data.candidates)
        .map(([label, candidate]) => [candidate.version, task.dependencies[label]])));
      const relative = (row.ranking as string[][]).length === 1 ? `相对更倾向${data.candidates.A.name}。` : "";
      const resource = (object(row.decision_basis).comparisons as JsonObject[]).find(item =>
        !(item.criterion_ids as string[]).length && Object.values(object(item.assessments))
          .every(cell => !(object(cell).finding_indices as number[]).length));
      const resources = resource ? " " + Object.values(data.candidates).map(candidate =>
        `${candidate.name}：${object(object(resource.assessments)[candidate.version]).summary}`).join(" ") : "";
      assert.equal(object(row.decision_basis).tradeoff, relative + "双方实际计算交付均满足所求结果。" + resources);
      const verdict = Object.values(object(row.verdicts))[0] as JsonObject;
      for (const version of versions) {
        const evaluation = object(object(row.evaluations)[version]);

        const source = state.receipts[String(object(row.attribution_task_ids)[version])].evaluation as AttributionResult;
        assert.deepEqual(evaluation.correct_reason, source.correct_reason);





      }
      if (versions.includes("baseline_fast")) {
        assert.deepEqual(object(object(row.models).baseline_fast), { version: "Baseline Fast", llm: null, trace_id: null });
        const baseline = object(object(row.evaluations).baseline_fast);
        assert.equal(baseline.is_correct, false);

        assert.deepEqual((baseline.Problem as AttributionResult["Problem"])[0].causes, []);
        assert((baseline.Problem as AttributionResult["Problem"])[0].uncertainty?.evidence_gap);
        assert.deepEqual(object((baseline.Problem as JsonObject[])[0]).stage_trace,
          { tools: [], confidence: "none", source: "none", locations: [{ message_index: 1, tool_name: null }] });
        assert.equal(verdict.result, "win");
        assert.equal(verdict.winner_version, versions.find(version => version !== "baseline_fast"));
      } else assert.equal(verdict.result, "both_good");
      if (versions.includes("short_fast"))
        assert.deepEqual(object(object(row.models).short_fast), { version: "Short Fast", llm: "short-trace-model", trace_id: "short-trace" });
    }
    assert.equal(new Set(rows.map(row => JSON.stringify([row.case, Object.keys(object(row.models)).sort()]))).size, 9);
    const analyzed = spawnSync(process.execPath, [path.join(ROOT, "scripts/benchmark.mjs"), "summarize", "--run", run,
      "--bootstrap-rounds", "100"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(analyzed.status, 0, analyzed.stderr);
    const statistics = JSON.parse(analyzed.stdout);
    assert.equal(statistics.matrix.length, 6);
    assert.equal(statistics.coverage.planned_pair_cases, 9);
    assert.equal(statistics.coverage.decided_coverage, 1);
    const baselineQuality = statistics.models.find((model: { version: string }) => model.version === "baseline_fast");
    assert.equal(baselineQuality.answer_cases, 2);
    assert.equal(baselineQuality.core.failed, 2);
    assert.equal(baselineQuality.standard_agreement.incorrect, 2);
    await t.test("comparisonRow preserves problem evidence across stable pairs", () => {
      const projectedReceipts = new Map(Object.entries(structuredClone(state.receipts)));
      const projectedInputs = { ...plan.inputs };
      for (const task of state.manifest.tasks.filter(task => task.stage === "attribution")) {
        const candidate = (task.data as TaskData).candidates.A;
        const evaluation = projectedReceipts.get(task.id)!.evaluation as AttributionResult;
        if (candidate.version !== "baseline_fast" || !evaluation.Problem.length) continue;
        const input = structuredClone(plan.inputs[candidate.input_id]) as RawInput;
        input.messages[candidate.final_index].content += "\n\n| 项目 | 数值 |\n| --- | --- |\n| 2+2 | 5 |";
        projectedInputs[candidate.input_id] = input;
        const table = parseTraceTables(input,candidate.input_id).find(table=>table.message_index===candidate.final_index)!;
        evaluation.Problem[0].evidence.push(table.rows[0].evidence);
      }
      const names = Object.fromEntries(config.inputs.versions.map(version=>[version.id,version.display_name||version.name]));
      for (const row of rows) {
        const task=state.manifest.tasks.find(task=>(task.data as TaskData).comparisonId===row.comparison_id)!;
        const projected=comparisonRow(projectedInputs,task,state.receipts[task.id].evaluation as ComparisonResult,projectedReceipts,names,fakeEvaluatorVersion);
        assert(validateOutput(projected),JSON.stringify(validateOutput.errors));
        for (const [label,candidate] of Object.entries((task.data as TaskData).candidates)) {
          const source=projectedReceipts.get(task.dependencies[label])!.evaluation as AttributionResult;
          const result=object(object(projected.evaluations)[candidate.version]);
          assert.deepEqual((result.Problem as AttributionResult['Problem']).map(problem=>problem.evidence),source.Problem.map(problem=>problem.evidence));
        }
        assert.deepEqual(projected.verdicts,row.verdicts);
      }
    });
    assert.equal((await validateRun(run)).valid, true);
    const byReference = new Map(state.manifest.tasks.flatMap(task => {
      const exported = state.receipts[task.id]?.exported;
      return exported ? [[`${exported.file ?? resultFile(task.stage as TaskData["stage"])}:${exported.id}`, exported.row] as const] : [];
    }));
    const restored = comparisonCodec.decode(comparisonCodec.encode(state), ref => {
      const row = byReference.get(`${ref.file}:${ref.id}`);
      assert(row, `missing fixture result reference ${ref.file}:${ref.id}`);
      return row;
    });
    assert.deepEqual(restored.receipts, state.receipts);
    assert.deepEqual(restored.manifest.tasks, state.manifest.tasks);
    const formal = await readFile(path.join(run, "results/comparison.jsonl"), "utf8"), before = calls.length;
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls.length, before, "resume preserves accepted third-party results");
    assert.equal(await readFile(path.join(run, "results/comparison.jsonl"), "utf8"), formal);
    assert.equal((await validateRun(run)).valid, true);
  } finally {
    await worker?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
