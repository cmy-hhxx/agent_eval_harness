import { responsibilityFixture } from "../../fixtures/responsibility.js";
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
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw,
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
          evaluation.standard_conflict = false;
          const evidence = canonicalEvidence(candidate.input_id, candidate.final_index, final);
          evaluation.correctness_evidence = [evidence];
          evaluation.numeric_checks = [{ label: "加法结果", expected: "4", actual: candidate.version === "baseline_fast" ? "5" : "4",
            scale: "1", mode: "exact", matches: candidate.version !== "baseline_fast", evidence_index: 0 }];
          evaluation.findings[0].evidence = [evidence];
          if (candidate.version === "baseline_fast") {
            evaluation.is_correct = false;
            evaluation.correctness_reason = "最终回答给出5，与标准答案4不一致；缺少生成链路，无法定位责任。";
            evaluation.core_assessment = { meets_core: false, reason: "核心计算结果错误。", criterion_ids: ["r1"] };
            evaluation.criterion_assessments[0] = { ...evaluation.criterion_assessments[0], status: "unmet",
              summary: "计算结果为5，未完成求和要求。", evidence: [evidence] };
            evaluation.summary = "最终计算结果错误，责任依据现有材料推断。";
            Object.assign(evaluation.findings[0], { type: "problem", text: "加法结果错误", reason: "2+2应为4，最终回答写成5。",
              problem: { diagnosis: "other" as const, investigation: [], component: [responsibilityFixture("最终回答组织",{evidence_ids:evaluation.findings[0].evidence.map(item=>item.evidence_id)})], label: "算术错误", definition: "最终交付的加法结果错误；现有材料不足以定位链路责任。" } });
            evaluation.findings[0].assessment.observation = final;
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
        assert.equal(evaluation.standard_conflict, false);
        const source = state.receipts[String(object(row.attribution_task_ids)[version])].evaluation as AttributionResult;
        assert.equal(source.numeric_checks.length, 1, "a real accepted numeric check reaches each formal evaluation");
        assert.deepEqual(evaluation.numeric_checks, source.numeric_checks);
        assert.deepEqual(evaluation.numeric_checks, [{ label: "加法结果", expected: "4", actual: version === "baseline_fast" ? "5" : "4",
          scale: "1", mode: "exact", matches: version !== "baseline_fast", evidence_index: 0 }]);
        assert.deepEqual(evaluation.table_resolutions, source.table_resolutions);
        assert.deepEqual((evaluation.findings as AttributionResult["findings"])[0].context_evidence, source.findings[0].context_evidence);
      }
      if (versions.includes("baseline_fast")) {
        assert.deepEqual(object(object(row.models).baseline_fast), { version: "Baseline Fast", llm: null, trace_id: null });
        const baseline = object(object(row.evaluations).baseline_fast);
        assert.equal(baseline.is_correct, false);
        assert.equal(object(baseline.core_assessment).meets_core, false);
        assert.equal((baseline.findings as AttributionResult["findings"])[0].problem!.component[0].certainty, "inferred");
        assert.deepEqual(object((baseline.findings as JsonObject[])[0]).stage_trace,
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
    await t.test("comparisonRow independently projects nonempty canonical context and table evidence without executing table verification", () => {
      const projectedReceipts = new Map(Object.entries(structuredClone(state.receipts)));
      const projectedInputs = { ...plan.inputs };
      let tableResolution: NonNullable<AttributionResult["table_resolutions"]> | undefined;
      let contextEvidence: NonNullable<AttributionResult["findings"][number]["context_evidence"]> | undefined;
      for (const task of state.manifest.tasks.filter(task => task.stage === "attribution")) {
        const evaluation = projectedReceipts.get(task.id)!.evaluation as AttributionResult;
        const candidate = (task.data as TaskData).candidates.A;
        if (candidate.version === "baseline_fast") {
          evaluation.standard_conflict = true;
          if (candidate.case_id === "q1") {
            const input = structuredClone(plan.inputs[candidate.input_id]) as RawInput;
            input.messages[0].content = "计算2+2\n\n已登记来源：\n| 项目 | 数值 |\n| --- | --- |\n| 2+2 | 4 |";
            input.messages[candidate.final_index].content = String(input.messages[candidate.final_index].content) +
              "\n\n| 项目 | 数值 |\n| --- | --- |\n| 2+2 | 5 |";
            projectedInputs[candidate.input_id] = input;
            const tables = parseTraceTables(input, candidate.input_id);
            const table = tables.find(table => table.message_index === candidate.final_index)!;
            const source = tables.find(table => table.message_index === 0)!;
            assert(table?.rows.length, "projection fixture contains an actual table row");
            assert(source?.rows.length, "projection fixture contains an independently located source row");
            contextEvidence = [canonicalEvidence(candidate.input_id, 0, "计算2+2")];
            evaluation.findings[0].context_evidence = contextEvidence;
            evaluation.criterion_assessments[0].context_evidence = contextEvidence;
            tableResolution = [{ table_id: table.table_id, row_index: table.rows[0].row_index, outcome: "conflict",
              reason: "表格实际给出5，与已登记来源和标准4不一致。", evidence: [table.rows[0].evidence, source.rows[0].evidence] }];
            evaluation.table_resolutions = tableResolution;
          }
        } else if (candidate.version === "b_fast") delete evaluation.standard_conflict;
      }
      const names = Object.fromEntries(config.inputs.versions.map(version => [version.id, version.display_name || version.name]));
      const threePairs = rows.filter(row => object(row.case).case_id === "q1" && !Object.hasOwn(object(row.models), "short_fast"));
      assert.equal(threePairs.length, 3);
      for (const row of threePairs) {
        const task = state.manifest.tasks.find(task => (task.data as TaskData).comparisonId === row.comparison_id)!;
        const projected = comparisonRow(projectedInputs, task, state.receipts[task.id].evaluation as ComparisonResult,
          projectedReceipts, names, fakeEvaluatorVersion);
        assert(validateOutput(projected), JSON.stringify(validateOutput.errors));
        for (const [version, evaluation] of Object.entries(object(projected.evaluations)))
          assert.equal(object(evaluation).standard_conflict, version === "baseline_fast" ? true : version === "a_fast" ? false : undefined);
        if (Object.hasOwn(object(projected.evaluations), "baseline_fast")) {
          const baseline = object(object(projected.evaluations).baseline_fast);
          assert.equal(tableResolution!.length, 1);
          assert.equal(contextEvidence!.length, 1);
          assert.deepEqual(baseline.table_resolutions, tableResolution);
          assert.deepEqual((baseline.findings as AttributionResult["findings"])[0].context_evidence, contextEvidence);
          assert.deepEqual((baseline.criterion_assessments as AttributionResult["criterion_assessments"])[0].context_evidence, contextEvidence);
        }
        assert.deepEqual(projected.verdicts, row.verdicts, "source fields pass through all three stable model pairs without rewriting verdicts");
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
