import test from "node:test";
import assert from "node:assert/strict";
import { createEris } from "@eval/assistant";
import type { AnalysisQuery, AssistantTool, JsonObject } from "@eval/contracts";
import { erisQuestionSelection } from "@eval/prompts";

type Context = Parameters<AssistantTool["execute"]>[1];
const context: Context = { scope: { userId: "test", sessionId: "test" }, callId: "sample", signal: new AbortController().signal, progress() {} };
const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
const receipt = (decisions: unknown) => ({ text: JSON.stringify({ decisions }), elapsedMs: 10, usage: { input: 100, output: 20 } });
const decision = (index: number, eligible = true) => ({ index, eligible, reason: eligible ? "需要解释因果差异并核验证据" : "只是直接查数" });
function pool(questions: string[], remaining = 7) {
  return { kind: "comparisons", runId: "run", evaluatorVersion: "fixture", selectionReason: "latest_with_inputs",
    total: questions.length, offset: 0, limit: 20, hasMore: false, nextOffset: null,
    selection: { mode: "random", availableCaseCount: questions.length + remaining, remainingCaseCount: remaining },
    summaryScope: "run", summary: { caseCount: 100, formalComparisonStats: { comparisonCount: 200, records: [], tiers: [] } },
    items: questions.map((question, index) => ({ question, case: { batchId: "batch", caseId: `q${index}` },
      reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: `comparison-${index}` }, comparisonTier: "Expert", inputs: [],
      assessments: [{ model: "A", summary: "完整评语" }], tradeoff: "完整取舍",
      outcomes: [{ result: "win", winnerModel: "A", reason: "正式胜负理由，不是选题理由" }] })) };
}
function tool(result: JsonObject) {
  const queries: AnalysisQuery[] = [];
  const eris = createEris({ data: { async list(query) { queries.push(query); return result; }, read: unexpected, search: unexpected, image: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  return { execute: eris.tools.find(item => item.name === "list_data")!.execute, queries };
}

test("sampled cases require semantic approval of complete questions, without reviewing model outcomes", async () => {
  const questions = ["计算2+2", "为什么原油期货大涨而石油股票不涨？", "请详细深入专业分析。".repeat(60) + "市盈率是什么？",
    "在写入延迟不能增加且允许最多丢一秒数据的约束下，如何设计跨机房故障切换？"];
  const source = pool(questions), before = structuredClone(source), sample = tool(source);
  let checks = 0;
  const query: AnalysisQuery = { collectionId: "0_wencai/0_daily_eval", runId: "run", view: "comparisons", sample: true, limit: 1, comparisonTier: "Expert", outcome: "all",
    query: "范围", excludeCases: [{ batchId: "batch", caseId: "seen" }] };
  const result = await sample.execute(query, { ...context, async complete(request) {
    checks++;
    assert.equal(request.systemPrompt, erisQuestionSelection);
    assert.equal(request.maxThinking, "low");
    const decisions = (request.outputSchema.properties as JsonObject).decisions as JsonObject;
    assert.equal(decisions.minItems, questions.length);
    assert.equal(decisions.maxItems, questions.length);
    assert.equal(request.sourceTools, undefined, "prior verdicts and reasoning must not bias question quality");
    assert.deepEqual(request.draft, { questions: questions.map((question, index) => ({ index, question })) });
    return receipt([decision(3), decision(2, false), decision(1), decision(0, false)]);
  } });
  assert.equal(checks, 1);
  assert.deepEqual(sample.queries, [{ ...query, limit: 20, includeAnalysis: true }]);
  const output = JSON.parse(result.content[0].text!);
  assert.deepEqual(output.items, [{ ...source.items[1], questionSelectionReason: decision(1).reason }]);
  assert.equal(output.total, 1);
  assert.equal(output.limit, 1);
  assert.equal(output.hasMore, false);
  assert.equal(output.nextOffset, null);
  assert.deepEqual(output.selection, { mode: "quality_random", availableCaseCount: 11, checkedCaseCount: 4,
    qualifiedCaseCount: 2, remainingCaseCount: 8, unreviewedCaseCount: 7, rejectedCases: [source.items[0].case, source.items[2].case] });
  assert.equal(output.summary.caseCount, 100, "curation cannot change whole-run denominators");
  assert.equal(output.summary.formalComparisonStats.comparisonCount, 200);
  assert.deepEqual(result.details, { qualityCheck: { elapsedMs: 10, usage: { input: 100, output: 20 } } });
  assert.deepEqual(source, before, "question selection never changes accepted results or original wording");
});

test("insufficient high-quality cases stay insufficient, with unreviewed scope explicitly separate", async () => {
  const source = pool(["哪里打开设置", "比较两种容灾方案在成本和一致性上的取舍"]), sample = tool(source);
  const query = { view: "comparisons", sample: true, limit: 5 };
  const partial = JSON.parse((await sample.execute(query, { ...context, async complete() {
    return receipt([decision(0, false), decision(1)]);
  } })).content[0].text!);
  assert.equal(partial.items.length, 1, "never fill the requested count with a rejected question");
  const empty = JSON.parse((await sample.execute(query, { ...context, async complete() {
    return receipt([decision(0, false), decision(1, false)]);
  } })).content[0].text!);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.selection.qualifiedCaseCount, 0);
  assert.equal(empty.selection.unreviewedCaseCount, 7, "an empty inspected pool does not mean the run is exhausted");
  assert.deepEqual(empty.selection.rejectedCases, source.items.map(item => item.case));
  assert.equal(sample.queries.length, 2, "one source read per request, without scanning other runs or silently retrying");
});

test("empty pools need no model while invalid or unavailable checks cannot release a candidate", async () => {
  const empty = tool(pool([], 0));
  const output = JSON.parse((await empty.execute({ view: "comparisons", sample: true }, { ...context, complete: unexpected })).content[0].text!);
  assert.deepEqual(output.items, []);
  assert.equal(output.selection.checkedCaseCount, 0);
  const sample = tool(pool(["问题一", "问题二"]));
  const query = { view: "comparisons", sample: true, limit: 1 };
  await assert.rejects(sample.execute(query, context), /质量筛选不可用/);
  for (const text of ["not JSON", "{}", receipt([]).text, receipt([decision(0)]).text,
    receipt([decision(0), decision(0)]).text, receipt([decision(0), decision(2)]).text,
    receipt([decision(0), { ...decision(1), eligible: "true" }]).text,
    receipt([decision(0), { ...decision(1), reason: " " }]).text]) {
    let calls = 0;
    await assert.rejects(sample.execute(query, { ...context, async complete() { calls++; return { ...receipt([]), text }; } }), /筛选结果无效/);
    assert.equal(calls, 1);
  }
  await assert.rejects(sample.execute(query, { ...context, async complete() { throw new Error("Gateway failed"); } }), /Gateway failed/);
  const abort = new AbortController();
  await assert.rejects(sample.execute(query, { ...context, signal: abort.signal, async complete() {
    abort.abort(); return receipt([decision(0), decision(1)]);
  } }), /abort/i);
});

test("ordinary directories and explicit question lookups retain simple questions without a quality call", async () => {
  const source = pool(["计算2+2"]), sample = tool(source);
  const query = { collectionId: "0_wencai/0_daily_eval", runId: "run", view: "comparisons", query: "计算2+2", includeAnalysis: true };
  const output = JSON.parse((await sample.execute(query, { ...context, complete: unexpected })).content[0].text!);
  assert.deepEqual(output.items, source.items);
  assert.deepEqual(sample.queries, [query]);
});
