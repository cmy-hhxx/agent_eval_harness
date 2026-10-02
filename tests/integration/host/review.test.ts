import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, deliveryCoverage, readRunState, type ComparisonResult, type TaskData } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw, taskResult } from "../../fixtures/comparison.js";

async function experiment(unresolved = false) {
  const setup = await fixtureConfig([[raw()], [], [raw()], []], false, true);
  const { directory, config, modelForStage } = setup;
  const plan = await buildPlan(config);
  let comparisons = 0, reviews = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const material = parsedMaterial(options.spec) as { review_context?: unknown };
      if (material.review_context) reviews++;
      let result: unknown;
      if (options.spec.evaluation.id === "comparison") {
        comparisons++;
        if (comparisons === 1 || unresolved) {
          // No ranking or criterion matrix is prepared just to request independent review.
          result = {
            status: "needs_review",
            assessments: {
              A: { summary: "交付范围尚待独立核实。" },
              B: { summary: "已完成可核实的核心交付。" },
            },
            review_requests: [{ candidate: "A", criterion_ids: ["r1"], finding_indices: [], reason: "交付范围需要独立核实。" }],
          };
        } else result = taskResult(options.spec);
      } else result = taskResult(options.spec);
      const draft = draftFor(options.spec, result) as Record<string, unknown>;
      if (draft.status === "needs_review")
        assert.deepEqual(Object.keys(draft).sort(), ["assessments", "review_requests", "status"]);
      const response = await options.execute("submit_evaluation", draft);
      assert.equal(response.isError, undefined, JSON.stringify(response));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const options = { ...services, plan, config, runId: "review", output: config.output,
    engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    workerUrls: [worker.url], policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0 };
  return { ...setup, plan, worker, options, counts: () => ({ comparisons, reviews }) };
}

test("independent review preserves the source, persists lineage and gates formal delivery", async () => {
  const run = await experiment();
  try {
    const summary = await runEvaluation(run.options);
    assert.equal(summary.completed_comparisons, 1);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const directory = path.join(run.config.output.path, "review");
    const state = await readRunState(directory);
    const original = run.plan.tasks.find((task) => task.stage === "comparison")!;
    const stored = state.manifest.tasks.find((task) => task.id === original.id)!;
    const followup = state.manifest.tasks.find((task) => task.id === (stored.data as TaskData).supersededBy)!;
    assert.equal((state.receipts[original.id].evaluation as ComparisonResult).status, "needs_review");
    const pending = state.receipts[original.id].evaluation as ComparisonResult;
    assert.deepEqual(pending.ranking, []);
    assert.deepEqual(pending.decision_basis.comparisons, []);
    assert.deepEqual(pending.decision_basis.decisive_findings, []);
    assert.equal(pending.assessments.A.meets_core, null);
    assert.deepEqual(pending.assessments.A.core_failure_refs, []);
    assert.equal(pending.assessments.B.meets_core, true);
    assert(pending.decision_basis.tradeoff.trim(), "Host supplies the pending status text while preserving the result shape");
    assert.equal((followup.data as TaskData).reviewOf?.taskId, original.id);
    assert.equal((state.receipts[followup.id].evaluation as ComparisonResult).status, "decided");
    assert.equal((await readFile(path.join(directory, "results/comparison.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await readFile(path.join(directory, "results/comparison-review.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert(deliveryCoverage(state).valid);
    const validation = await validateRun(directory);
    assert(validation.valid, JSON.stringify(validation));
    await runEvaluation({ ...run.options, plan: { ...run.plan, tasks: state.manifest.tasks } });
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 }, "resume never repeats accepted source or review tasks");
  } finally { await run.worker.close(); await rm(run.directory, { recursive: true, force: true }); }
});

test("a second unresolved verdict stops review and excludes verdicts and problem-library admission", async () => {
  const run = await experiment(true);
  try {
    const summary = await runEvaluation(run.options);
    assert.equal(summary.completed_comparisons, 0);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const state = await readRunState(path.join(run.config.output.path, "review"));
    assert.equal(state.manifest.tasks.filter((task) => task.stage === "comparison").length, 2);
    assert(!deliveryCoverage(state).valid);
    const formal = await readFile(path.join(run.config.output.path, "review/results/comparison.jsonl"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    });
    assert.equal(formal.trim(), "", "neither unresolved round may publish a formal comparison");
    for (const task of state.manifest.tasks.filter(task => task.stage === "comparison")) {
      const result = state.receipts[task.id].evaluation as ComparisonResult;
      assert.equal(result.status, "needs_review");
      assert.deepEqual(result.ranking, []);
      assert.deepEqual(result.decision_basis.comparisons, []);
    }
    for (const task of state.manifest.tasks.filter((task) => task.stage === "clustering")) {
      assert.equal(state.manifest.states[task.id].status, "blocked");
      assert.equal(state.receipts[task.id], undefined);
    }
    await runEvaluation(run.options);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const resumed = await readRunState(path.join(run.config.output.path, "review"));
    for (const task of resumed.manifest.tasks.filter((task) => task.stage === "clustering"))
      assert.equal(resumed.manifest.states[task.id].status, "blocked", "ordinary resume cannot admit unresolved observations");
  } finally { await run.worker.close(); await rm(run.directory, { recursive: true, force: true }); }
});

test("recomputed table uncertainty forces the existing bounded review loop without publishing a guessed verdict", async () => {
  const source = "| 代码 | 名称 |\n|---|---|\n| 111111 | 已知标的 |";
  const answer = "| 代码 | 名称 |\n|---|---|\n| 111111 | 已知标的 |\n| 222222 | 来源未展示标的 |";
  const input = raw("table-review", null, answer);
  input.messages = [{ role: "user", content: "根据来源列出代码和名称。" }, { role: "tool", type: "function_call_output", name: "lookup", content: source },
    { role: "assistant", content: answer }];
  const setup = await fixtureConfig([[input], [], [input], []], false, true);
  const { directory, config, modelForStage } = setup;
  let comparisons = 0, reviews = 0, prevented = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const material = parsedMaterial(options.spec) as { review_context?: unknown;
        answer?: { final_message_index: number; table_check_results: { answer_table_id: string }[] }; source_review?: Record<string, string[]> };
      if (material.review_context) reviews++;
      const result = taskResult(options.spec) as Record<string, unknown>;
      if (material.answer) {
        assert(material.answer.table_check_results.length > 0, "the complete deterministic checks are provided before assessment");
        result.findings = [];
      }
      if ("decision_basis" in result) {
        comparisons++;
        const value = result as unknown as ComparisonResult;
        value.decision_basis.decisive_findings = [];
        for (const row of value.decision_basis.comparisons)
          for (const assessment of Object.values(row.assessments)) assessment.finding_indices = [];
        assert.deepEqual(Object.keys(material.source_review!).sort(), ["A", "B"]);
        const rejected = await options.execute("submit_evaluation", draftFor(options.spec, value));
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected), /source_review_required/);
        prevented++;
        value.status = "needs_review"; value.ranking = [];
        value.review_requests = ["A", "B"].map(candidate => ({ candidate, criterion_ids: ["r1"], finding_indices: [],
          reason: material.source_review![candidate].join(" ") }));
      }
      const accepted = await options.execute("submit_evaluation", draftFor(options.spec, result));
      assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    const summary = await runEvaluation({ ...services, plan, config, runId: "source-review", output: config.output,
      engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, workerUrls: [worker.url],
      policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0 });
    assert.equal(summary.completed_comparisons, 0);
    assert.equal(comparisons, 2); assert.equal(reviews, 2); assert.equal(prevented, 2);
    const state = await readRunState(path.join(config.output.path, "source-review"));
    for (const task of state.manifest.tasks.filter(task => task.stage === "clustering"))
      assert.equal(state.manifest.states[task.id].status, "blocked");
    assert.equal(state.manifest.tasks.filter(task => task.stage === "attribution").length, 4);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("independent table review resolves an unverified row using original tool prose and survives export and resume", async () => {
  const source = "| 代码 | 名称 |\n|---|---|\n| 111111 | 已知标的 |";
  const support = "来源未展示标的的股票代码为222222。";
  const answer = "| 代码 | 名称 |\n|---|---|\n| 111111 | 已知标的 |\n| 222222 | 来源未展示标的 |";
  const input = raw("table-prose-review", null, answer);
  input.messages = [
    { role: "user", content: "根据来源列出代码和名称。" },
    { role: "tool", type: "function_call_output", name: "lookup", content: source },
    { role: "tool", type: "function_call_output", name: "lookup", content: support },
    { role: "assistant", content: answer },
  ];
  const setup = await fixtureConfig([[input], [], [input], []], false, true);
  const { directory, config, modelForStage } = setup;
  let comparisons = 0, reviews = 0, prevented = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const material = parsedMaterial(options.spec) as { review_context?: unknown;
        answer?: { final_message_index: number; table_check_results: { answer_table_id: string; rows: { row_index: number; status: string; answer: { evidence: { evidence_id: string } } }[] }[] };
        source_review?: Record<string, string[]> };
      const result = taskResult(options.spec) as Record<string, unknown>;
      const resolutions: { table_id: string; row_index: number; outcome: string; reason: string; evidence: { evidence_id: string }[] }[] = [];
      if (material.answer) {
        if (material.review_context) reviews++;
        result.findings = [];
        for (const table of material.answer.table_check_results) {
          const unresolved = table.rows.find(row => row.row_index === 1)!;
          assert.equal(unresolved.status, "unverified", "the table-only check must remain uncertain even though prose can resolve it");
          if (material.review_context) {
            const searched = await options.execute("search_trace", { candidate: "answer", query: support });
            assert.notEqual(searched.isError, true, JSON.stringify(searched));
            const matches = JSON.parse(searched.content.find(item => item.type === "text")!.text!) as {
              matches: { path: string; evidence: { evidence_id: string; message_index: number; quote: string } }[] };
            const original = matches.matches.find(item => item.path === "/content" && item.evidence.message_index === 2)!.evidence;
            assert.equal(original.quote, support);
            resolutions.push({ table_id: table.answer_table_id, row_index: unresolved.row_index, outcome: "supported",
              reason: "原查询表只展示首行，另一条原始工具返回明确给出缺失行的名称和代码对应，已与最终行逐字核对。",
              evidence: [{ evidence_id: unresolved.answer!.evidence.evidence_id }, { evidence_id: original.evidence_id }] });
          }
        }
      }
      if ("decision_basis" in result) {
        comparisons++;
        const value = result as unknown as ComparisonResult;
        value.decision_basis.decisive_findings = [];
        for (const row of value.decision_basis.comparisons)
          for (const assessment of Object.values(row.assessments)) assessment.finding_indices = [];
        if (comparisons === 1) {
          assert.deepEqual(Object.keys(material.source_review!).sort(), ["A", "B"]);
          const rejected = await options.execute("submit_evaluation", draftFor(options.spec, value));
          assert.equal(rejected.isError, true);
          assert.match(JSON.stringify(rejected), /source_review_required/);
          prevented++;
          value.status = "needs_review"; value.ranking = [];
          value.review_requests = ["A", "B"].map(candidate => ({ candidate, criterion_ids: ["r1"], finding_indices: [],
            reason: material.source_review![candidate].join(" ") }));
        } else {
          assert.deepEqual(material.source_review ?? {}, {}, "independent evidence must clear the source-review gate");
          assert.equal(value.status, "decided");
        }
      }
      const draft = draftFor(options.spec, result) as Record<string, unknown>;
      // Use the actual tool-issued coordinates; the generic fixture helper only maps final/user quotations.
      if (resolutions.length) draft.table_resolutions = resolutions;
      const accepted = await options.execute("submit_evaluation", draft);
      assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    const options = { ...services, plan, config, runId: "source-prose-review", output: config.output,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, workerUrls: [worker.url],
      policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0 };
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 1);
    assert.deepEqual({ comparisons, reviews, prevented }, { comparisons: 2, reviews: 2, prevented: 1 });
    const run = path.join(config.output.path, "source-prose-review");
    const state = await readRunState(run);
    const originals = state.manifest.tasks.filter(task => task.stage === "attribution" && !(task.data as TaskData).reviewOf);
    const reviewed = state.manifest.tasks.filter(task => task.stage === "attribution" && (task.data as TaskData).reviewOf);
    assert.equal(originals.length, 2); assert.equal(reviewed.length, 2);
    for (const task of originals)
      assert.equal((state.receipts[task.id].evaluation as { table_resolutions?: unknown }).table_resolutions, undefined);
    for (const task of reviewed) {
      const value = state.receipts[task.id].evaluation as { table_resolutions: { outcome: string; row_index: number; evidence: { message_index: number; quote: string }[] }[] };
      assert.equal(value.table_resolutions[0].outcome, "supported");
      assert.equal(value.table_resolutions[0].row_index, 1);
      assert.deepEqual(value.table_resolutions[0].evidence.map(item => item.message_index).sort(), [2, 3]);
      assert(value.table_resolutions[0].evidence.some(item => item.quote === support));
    }
    const comparisonLines = (await readFile(path.join(run, "results/comparison.jsonl"), "utf8")).trim().split("\n");
    assert.equal(comparisonLines.length, 1);
    const published = JSON.parse(comparisonLines[0]) as { status: string; evaluations: Record<string, { table_resolutions: { outcome: string; evidence: { quote: string }[] }[] }> };
    assert.equal(published.status, "decided");
    for (const evaluation of Object.values(published.evaluations)) {
      assert.equal(evaluation.table_resolutions[0].outcome, "supported");
      assert(evaluation.table_resolutions[0].evidence.some(item => item.quote === support));
    }
    assert.equal((await readFile(path.join(run, "results/comparison-review.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert(deliveryCoverage(state).valid);
    const validated = await validateRun(run);
    assert(validated.valid, JSON.stringify(validated));
    await runEvaluation({ ...options, plan: { ...plan, tasks: state.manifest.tasks } });
    assert.deepEqual({ comparisons, reviews, prevented }, { comparisons: 2, reviews: 2, prevented: 1 });
    const resumedValidation = await validateRun(run);
    assert(resumedValidation.valid, JSON.stringify(resumedValidation));
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
