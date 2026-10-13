import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { rm } from "node:fs/promises";
import { emptyUsage, object, type JsonObject, type RunState, type SubmissionReceipt, type TaskPlan } from "@eval/contracts";
import { readJson, writeJson, writeJsonl, writeRunOverview } from "@eval/data";
import { analysisRunOverview, buildPlan, comparisonRepository, createResultWriter, type Checkpoint, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";
import { createEris } from "@eval/assistant";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, raw } from "../../fixtures/comparison.js";

async function saveCheckpoint(file: string, saved: Checkpoint) {
  await writeJson(file, saved);
  await writeRunOverview(path.dirname(file), analysisRunOverview(saved));
}

async function register(config: EvalConfig, accepted?: (state: RunState, plan: TaskPlan) => Promise<void>) {
  const plan = await buildPlan(config);
  const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
    format: "evaluation-run", runId: "source", status: "running", debug: false,
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
    tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 0,
  } };
  await accepted?.(state, plan);
  await comparisonRepository.writeRun(path.join(config.output.path, "source"), state);
  const source = new LocalAnalysisData(config.output.path);
  source.raw = async () => { throw new Error("Directory queries must not read source messages"); };
  return source;
}

test("cumulative overview never opens individual run checkpoints", async (t) => {
  const fixture = await fixtureConfig();
  try {
    const source = await register(fixture.config, async state => { state.manifest.status = "finished"; });
    const read = fs.readFile;
    const probe = t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) => {
      assert(!String(args[0]).endsWith("/state.json"), "overview must not scan full run checkpoints");
      return read(...args);
    });
    syncBuiltinESMExports();
    try {
      const overview = await source.list({ view: "statistics" });
      assert.equal(overview.kind, "statistics");
      assert(overview.kind === "statistics" && overview.currentRuns.length === 0);
    } finally { probe.mock.restore(); syncBuiltinESMExports(); }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("an unavailable historical index cannot block valid runs or an explicit run query", async () => {
  const fixture = await fixtureConfig();
  try {
    const source = await register(fixture.config);
    const saved = await readJson<Checkpoint>(path.join(fixture.config.output.path, "source/state.json"));
    await saveCheckpoint(path.join(fixture.config.output.path, "broken/state.json"), { ...saved, runId: "broken", status: "finished" });
    await rm(path.join(fixture.config.output.path, "broken/overview.json"));
    const directory = await source.list({});
    assert.equal(directory.kind, "runs");
    assert.equal(object(directory.currentRun).runId, "source");
    assert.equal(object(directory.runCounts).scope, "readable_registered_runs");
    assert.equal(directory.runDirectory.complete, false);
    assert.equal(directory.runDirectory.errors[0]!.runId, "broken");
    const selected = await source.list({ view: "inputs" });
    assert(selected.kind === "inputs");
    assert.equal(selected.runId, "source");
    assert("runDirectory" in selected && !selected.runDirectory.complete);
    const explicit = await source.list({ runId: "broken" });
    assert.equal(explicit.kind, "inputs", "an explicit query reads the checkpoint, not its optional directory index");
    await fs.writeFile(path.join(fixture.config.output.path, "broken/state.json"), "{");
    await writeRunOverview(path.join(fixture.config.output.path, "broken"), analysisRunOverview({ ...saved, runId: "broken" }));
    const partial = await source.list({ view: "statistics" });
    assert(partial.kind === "statistics");
    assert.deepEqual(partial.currentRuns.map(run => run.runId), ["source"]);
    assert.equal(partial.runDirectory.complete, false);
    await assert.rejects(source.list({ runId: "broken" }), /JSON|position|property/i);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

async function registerAccepted(config: EvalConfig, compare = (data: TaskData) => comparisonResult(Object.keys(data.candidates))) {
  let accepted: Record<string, SubmissionReceipt> = {};
  const source = await register(config, async (state, plan) => {
    for (const task of plan.tasks) {
      const evaluation = task.stage === "criteria" ? criteriaResult() : task.stage === "attribution" ? attributionResult()
        : compare(task.data as TaskData);
      state.receipts[task.id] = { taskId: task.id, attemptId: task.id, submissionId: randomUUID(), evaluation,
        evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", acceptedAt: 0 };
      state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
    }
    await createResultWriter(path.join(config.output.path, "source"), plan.inputs)(state);
    accepted = state.receipts;
  });
  return { source, accepted };
}

test("random case selection samples distinct questions and exhausts them across tiers", async () => {
  const fixture = await fixtureConfig(Array.from({ length: 4 }, () => [raw("one"), raw("two"), raw("three")]));
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const { source } = await registerAccepted(fixture.config);
    const sample = await source.list({ runId: "source", view: "comparisons", outcome: "all", sample: true, limit: 2 });
    assert(sample.kind === "comparisons");
    assert.equal(new Set(sample.items.map(item => item.case.caseId)).size, 2);
    assert.deepEqual(sample.selection, { mode: "random", availableCaseCount: 3, remainingCaseCount: 1 });
    assert.equal(sample.nextOffset, null, "a random sample cannot be resumed with a page offset");
    const excludeCases = sample.items.map(item => item.case);
    const next = await source.list({ runId: "source", view: "comparisons", outcome: "all", sample: true, limit: 1, excludeCases });
    assert(next.kind === "comparisons");
    assert.equal(next.items.length, 1);
    assert(!excludeCases.some(item => item.caseId === next.items[0]!.case.caseId));
    const empty = await source.list({ runId: "source", view: "comparisons", outcome: "all", sample: true, excludeCases: [...excludeCases, next.items[0]!.case] });
    assert(empty.kind === "comparisons");
    assert.equal(empty.items.length, 0);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris samples a comparison without a preliminary run lookup and returns the resolved scope", async () => {
  const question = "为什么原油期货大涨而石油股票不涨？";
  const fixture = await fixtureConfig(Array.from({ length: 4 }, () => [{ ...raw(), messages: [
    { type: "message", role: "user", content: question }, { type: "message", role: "assistant", content: "需要区分成本、业务结构与市场预期。" },
  ] }]));
  try {
    const { source } = await registerAccepted(fixture.config, data => {
      const labels = Object.keys(data.candidates), result = comparisonResult(labels);
      result.ranking = labels.map(label => [label]);
      return result;
    });
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
    const eris = createEris({ code: { execute: unexpected, read: unexpected }, data: source,
      specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
    const result = await eris.tools.find(tool => tool.name === "list_data")!.execute(
      { view: "comparisons", sample: true, limit: 1, includeAnalysis: true },
      { scope: { userId: "test", sessionId: "test" }, callId: "sample", signal: new AbortController().signal, progress() {}, async complete(request) {
        assert.deepEqual(request.draft, { questions: [{ index: 0, question }] });
        return { text: JSON.stringify({ decisions: [{ index: 0, eligible: true, reason: "需分辨成本传导和市场预期的因果差异" }] }), elapsedMs: 5, usage: {} };
      } });
    const sample = JSON.parse(result.content[0].text!);
    assert.equal(sample.kind, "comparisons");
    assert.equal(sample.runId, "source");
    assert.equal(sample.selectionReason, "running_with_inputs");
    assert.equal(sample.selection.mode, "quality_random");
    assert.equal(sample.items.length, 1);
    assert.equal(sample.items[0].reference.runId, sample.runId);
    assert(sample.items[0].question.length > 0);
    assert(sample.items[0].outcomes[0].reason.length > 0);
    const material = await source.read({ runId: sample.runId, query: sample.items[0].question }, { view: "case" });
    assert.deepEqual(material.reference, sample.items[0].reference, "a unique question does not need a redundant tier argument");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("comparison summaries filter exact tiers and outcomes without loading raw answers or changing statistics", async () => {
  const fixture = await fixtureConfig(Array.from({ length: 4 }, () => [raw("good"), raw("bad"), raw("winner")]));
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const { source } = await registerAccepted(fixture.config, data => {
      const labels = Object.keys(data.candidates), result = comparisonResult(labels);
      const caseId = Object.values(data.candidates)[0]!.case_id;
      if (caseId === "bad") for (const assessment of Object.values(result.assessments)) assessment.meets_core = false;
      if (caseId === "winner") result.ranking = labels.map(label => [label]);
      return result;
    });
    const defaults = await source.list({ runId: "source", view: "comparisons" });
    assert(defaults.kind === "comparisons");
    assert.equal(defaults.total, 4);
    assert(defaults.items.every(item => item.outcomes.every(pair => pair.result !== "both_good")));
    const sample = await source.list({ runId: "source", view: "comparisons", sample: true, limit: 20 });
    assert(sample.kind === "comparisons");
    assert.equal(sample.selection?.availableCaseCount, 2);
    assert(sample.items.every(item => item.case.caseId !== "good"));
    const batch = await source.list({ runId: "source", view: "comparisons", comparisonTier: "Fast", outcome: "both_bad", includeAnalysis: true, limit: 20 });
    assert(batch.kind === "comparisons");
    assert.equal(batch.total, 1);
    const item = batch.items[0]!, record = batch.summary.formalComparisonStats!.records.find(record => record.reference.taskId === item.reference.taskId)!;
    assert("question" in item, "batch analysis includes the full question");
    assert.equal(item.question, record.question);
    assert.deepEqual(item.assessments, record.scope.assessments);
    assert.equal(item.tradeoff, record.scope.tradeoff);
    assert.equal(item.outcomes[0]!.reason, record.scope.comparisons[0]!.reason);
    assert.deepEqual(batch.summary, defaults.summary);
    assert.equal(batch.summary.formalComparisonStats!.comparisonCount, 6);
    const good = await source.list({ runId: "source", view: "comparisons", outcome: "both_good" });
    assert(good.kind === "comparisons");
    assert.equal(good.total, 2);
    const first = await source.list({ runId: "source", view: "comparisons", outcome: "all", includeAnalysis: true, limit: 2 });
    assert(first.kind === "comparisons");
    assert.equal(first.total, 6);
    const rest = await source.list({ runId: "source", view: "comparisons", outcome: "all", includeAnalysis: true, offset: first.nextOffset!, limit: 20 });
    assert(rest.kind === "comparisons");
    assert.equal(rest.items.length, 4);
    assert.equal(rest.hasMore, false);
    assert.equal(new Set([...first.items, ...rest.items].map(item => item.reference.taskId)).size, 6);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("batch evidence parses one input and preserves exact per-node slices, citations and missing-node errors", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  let loads = 0;
  source.raw = async () => { loads++; return { messages: [
    { role: "assistant", content: "查询口径：前50名" },
    { type: "function_call_output", output: "返回数据：前100名；区间涨跌幅-2.268431%" },
    { content: { first: "第一段", second: "第二段" } },
  ] }; };
  const result = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 1, offset: 5, limit: 8 }, { messageIndex: 99 }, { messageIndex: 0 }, { messageIndex: 2, offset: 2, limit: 4 }] });
  assert.equal(loads, 1, "batching must share raw input parsing, not loop over the single-node reader");
  assert.equal(result.readCount, 3);
  assert.equal(result.requestedCount, 4);
  const items = result.items as { reference: { messageIndex: number }; text?: string; evidence?: { evidence_id: string; quote: string }[]; error?: string; hasMore?: boolean; nextOffset?: number }[];
  assert.deepEqual(items.map(item => item.reference.messageIndex), [1, 99, 0, 2]);
  assert.match(items[1].error!, /out of range/);
  assert.equal(items[0].hasMore, true);
  assert.equal(items[0].nextOffset, 13);
  assert.equal(items[2].hasMore, false);
  for (const [index, messageIndex, offset, limit] of [[0, 1, 5, 8], [2, 0, 0, 16000], [3, 2, 2, 4]]) {
    assert.deepEqual(items[index], await source.read({ ...reference, messageIndex }, { offset, limit }), "batch and single reads must agree on exact source coordinates");
  }
  assert.equal(items[3].text, "段\n第二");
  assert.equal(items[3].evidence!.length, 2, "a slice crossing text parts cites both original fields");
  const next = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 1, offset: items[0].nextOffset }] });
  const whole = await source.read({ ...reference, messageIndex: 1 });
  assert.equal(items[0].text + (next.items as { text: string }[])[0].text, (whole.text as string).slice(5));
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const tools = createEris({ data: source, code: { execute: unexpected, read: unexpected }, specialists: { invoke: unexpected, read: unexpected },
    search: { search: unexpected }, web: { read: unexpected } }).tools;
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "read", signal: new AbortController().signal, progress() {} };
  const batchArgs = { reference, messages: [{ messageIndex: 1, offset: 5, limit: 8 }, { messageIndex: 99 }, { messageIndex: 0 }, { messageIndex: 2, offset: 2, limit: 4 }] };
  for (const [name, args, original] of [["read_evidence", batchArgs, result], ["read_data", { reference: { ...reference, messageIndex: 1 } }, whole]] as const) {
    const tool = tools.find(tool => tool.name === name)!;
    const model = JSON.parse((await tool.execute(args, context)).content[0].text!);
    const expected = name === "read_evidence" ? (original.items as Record<string, unknown>[]) : [original];
    const actual = name === "read_evidence" ? model.items : [model];
    assert.deepEqual(actual.map(({ nextRead: _next, ...item }: JsonObject) => item), expected.map(({ evidence: _evidence, ...item }) => item), "exact source text, node coordinates, errors and page boundaries survive the model projection");
    for (const item of actual) if (item.nextRead) {
      assert.equal(item.nextRead.tool, name);
      const continued = JSON.parse((await tool.execute(item.nextRead.args, context)).content[0].text!);
      const page = name === "read_evidence" ? continued.items[0] : continued;
      assert.equal(page.offset, item.nextOffset);
      assert.deepEqual(page.reference, item.reference);
      assert.equal(page.format, item.format);
    }
    const user = JSON.parse((await tool.execute(args, { ...context, audience: "user" })).content[0].text!);
    if (name === "read_evidence") user.items = user.items.map(({ nextRead: _next, ...item }: JsonObject) => item);
    else delete user.nextRead;
    assert.deepEqual(user, original, "the inspector and copy workflow retain full material");
  }
  source.raw = async () => { throw new Error("Source unavailable"); };
  await assert.rejects(source.read(reference, { view: "evidence", messages: [{ messageIndex: 0 }] }), /Source unavailable/);
});

test("batch evidence preserves decisive text beyond 8000 characters and exact continuation boundaries", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  const medium = "甲".repeat(9000) + "决定性反例：已给期现分类说明", long = "乙".repeat(18000);
  source.raw = async () => ({ messages: [{ content: medium }, { content: long }] });
  const batch = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 0 }, { messageIndex: 1 }] });
  const [first, second] = batch.items as JsonObject[];
  assert.equal(first.text, medium);
  assert.equal(first.hasMore, false);
  assert.equal(second.text, long.slice(0, 16000));
  assert.equal(second.nextOffset, 16000);
  const tail = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 1, offset: second.nextOffset as number }] });
  assert.equal(String(second.text) + (tail.items as JsonObject[])[0].text, long);
  const explicit = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 0, limit: 1000 }] });
  assert.equal((explicit.items as JsonObject[])[0].text, medium.slice(0, 1000));
  assert.equal((await source.read({ ...reference, messageIndex: 0 })).limit, 8000, "single-message reads retain their own budget");
});

test("search hits supply a directly readable window around long queries and the source node type", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  source.raw = async () => ({ messages: [
    { type: "tool_result", name: "Search", output: "前".repeat(10000) + "目标条件" + "后".repeat(9000) },
    { type: "reasoning", content: "目标条件的另一次提及" },
  ] });
  const result = await source.search(reference, "目标条件", { limit: 1, scope: "all" });
  const hit = (result.matches as { reference: typeof reference & { messageIndex: number }; type: string; name: string; offset: number; text: string; readOffset: number }[])[0];
  assert.equal(hit.type, "tool_result");
  assert.equal(hit.name, "Search");
  assert(hit.readOffset > 8000, "a match deep in a long node must not send the reader back to its first page");
  const page = await source.read(hit.reference, { offset: hit.readOffset });
  assert((page.text as string).startsWith(hit.text));
  assert((page.text as string).includes("目标条件"));
  assert.equal(result.hasMore, true);
  assert.equal((await source.search(reference, "不存在")).total, 0);
});

test("local search keeps instructions identifiable and behind evidence without losing paginated hits", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  source.raw = async () => ({ messages: [
    { role: "system", content: "扣非是检索指令" },
    { role: "developer", content: "扣非是指令示例" },
    { role: "tool", type: "tool_result", output: "实际扣非数值" },
    { role: "assistant", content: "答案中的扣非判断" },
  ] });
  const first = await source.search(reference, "扣非", { limit: 2, scope: "all" });
  const second = await source.search(reference, "扣非", { offset: first.nextOffset as number, limit: 2, scope: "all" });
  const hits = [...first.matches as JsonObject[], ...second.matches as JsonObject[]];
  assert.equal(first.total, 4);
  assert.deepEqual(hits.map(hit => object(hit.reference).messageIndex), [2, 3, 0, 1]);
  assert.deepEqual(hits.map(hit => hit.role), ["tool", "assistant", "system", "developer"]);
  assert.equal(second.hasMore, false);
  for (const hit of hits) {
    const page = await source.read(hit.reference as typeof reference, { offset: hit.readOffset as number });
    assert((page.text as string).startsWith(hit.text as string));
  }
});

test("search ranks original tool evidence before replayed history without dropping either", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  source.raw = async () => ({ messages: [
    { type: "llm_turn", input_messages: [{ content: "关键词：复制的历史" }], output: "另一次关键词判断" },
    { role: "assistant", content: "关键词结论" },
    { type: "tool_result", name: "Search", output: "关键词的原始披露与限定" },
    { role: "system", content: "关键词指令" },
  ] });
  const evidence = await source.search(reference, "关键词");
  assert.equal(evidence.scope, "evidence");
  assert.equal(evidence.total, 1, "original source facts must not compete with repeated answer claims");
  assert.equal(object((evidence.matches as JsonObject[])[0].reference).messageIndex, 2);
  const pages = await Promise.all([0, 1, 2, 3].map(offset => source.search(reference, "关键词", { offset, limit: 1, scope: "all" })));
  const hits = pages.flatMap(page => page.matches as JsonObject[]);
  assert.deepEqual(hits.map(hit => object(hit.reference).messageIndex), [2, 1, 0, 3]);
  assert(pages.every(page => page.total === 4));
  for (const hit of hits) {
    const page = await source.read(hit.reference as typeof reference, { offset: hit.readOffset as number });
    assert((page.text as string).startsWith(hit.text as string));
  }
});

test("space-separated search terms match together in one node and retain exact term locations", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  source.raw = async () => ({ messages: [
    { type: "tool_result", output: "甲公司提供清洗设备，也有湿法刻蚀设备，目标用途待核验。" },
    { type: "tool_result", output: "甲公司仅列清洗" },
    { type: "tool_result", output: "乙公司列湿法刻蚀" },
  ] });
  const result = await source.search(reference, "甲公司 湿法刻蚀");
  assert.equal(result.total, 1, "terms must all occur in the same source node, not across unrelated results");
  const hit = (result.matches as JsonObject[])[0];
  assert.deepEqual(hit.terms, ["甲公司", "湿法刻蚀"]);
  const original = await source.read(hit.reference as typeof reference);
  for (const location of hit.termLocations as { term: string; offset: number; readOffset: number }[])
    assert.equal((original.text as string).slice(location.offset, location.offset + location.term.length), location.term);
  assert.equal((await source.search(reference, "甲公司 未记载能力")).total, 0);
  await assert.rejects(source.search(reference, "  "), /Search query required/);
});

test("compound search exposes every term's original context without repeating overlapping windows", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  const text = "甲公司清洗设备\n" + "填充".repeat(800) + "TSV深孔清洗，也有多种介质层湿法刻蚀工艺。" + "余文".repeat(400);
  source.raw = async () => ({ messages: [{ type: "tool_result", output: text }] });
  const result = await source.search(reference, "甲公司 TSV 深孔清洗");
  const hit = (result.matches as JsonObject[])[0];
  const contexts = [{ readOffset: hit.readOffset, text: hit.text }, ...(hit.contexts as { readOffset: number; text: string }[] ?? [])];
  assert.equal(contexts.length, 2, "distant terms are visible, neighboring terms share one exact source window");
  assert.match(contexts.map(context => context.text).join("\n"), /TSV深孔清洗，也有多种介质层湿法刻蚀/);
  for (const context of contexts) {
    const page = await source.read(hit.reference as typeof reference, { offset: context.readOffset as number, limit: (context.text as string).length });
    assert.equal(page.text, context.text, "every displayed window is directly readable without changing source coordinates");
  }
});

test("search separates retrieved documents from query metadata and prefers the entity's own source", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  source.raw = async () => ({ messages: [{ type: "tool_result", output: "甲公司 TSV 行业表格" }, { type: "tool_result", output: { items: [
    { summary: "乙公司收购甲公司，并推出自己的TSV全流程设备", title: "乙公司新闻", query: "甲公司 TSV 目标能力" },
    { summary: "介绍".repeat(500) + "TSV深孔清洗，以及多种介质层湿法刻蚀工艺。", title: "甲公司年度报告", query: "甲公司 TSV 目标能力" },
    { summary: "只有通用清洗设备", title: "丙公司", query: "甲公司 TSV 目标能力" },
  ] } }] });
  const hits = (await source.search(reference, "甲公司 TSV")).matches as JsonObject[];
  assert.equal(hits.length, 3, "query metadata cannot manufacture an evidence match in unrelated documents");
  assert.equal(object(hits[0].source).path, "/output/items/1");
  assert.equal(object(hits[0].source).title, "甲公司年度报告");
  assert.match(hits[0].text as string, /湿法刻蚀/);
  const page = await source.read(hits[0].reference as typeof reference, { offset: hits[0].readOffset as number, limit: (hits[0].text as string).length });
  assert.equal(page.text, hits[0].text);
  assert.equal((await source.search(reference, "甲公司 目标能力")).total, 0, "a repeated search request is navigation, not a source statement");
  assert.equal((await source.search(reference, "甲公司 目标能力", { scope: "all" })).total, 1, "raw fields remain explicitly searchable");
});

test("multiple evidence pages share source extraction inside a batch and observe fresh content on the next call", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  let accesses = 0, text = "完整证据".repeat(10000);
  source.raw = async () => ({ messages: [{ get content() { accesses++; return text; } }] });
  await source.read({ ...reference, messageIndex: 0 });
  const singleAccesses = accesses;
  accesses = 0;
  const result = await source.read(reference, { view: "evidence", messages: [
    { messageIndex: 0, offset: 0, limit: 16000 }, { messageIndex: 0, offset: 16000, limit: 16000 }, { messageIndex: 0, offset: 32000, limit: 16000 },
  ] });
  assert.equal(accesses, singleAccesses, "paging one source node must not repeatedly traverse and serialize it");
  const items = result.items as { text: string }[];
  assert.equal(items.map(item => item.text).join(""), text);
  text = "更新后的原始证据";
  const next = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 0 }] });
  assert.equal((next.items as { text: string }[])[0].text, text, "no cross-call result cache");
});

test("batched search loads an answer once and preserves every single-query hit, empty query result and readable offset", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  let loads = 0;
  source.raw = async () => { loads++; return { messages: [
    { type: "tool_result", output: "前".repeat(10000) + "PCB送样，高速铜缆已投产" },
    { type: "tool_result", output: { margin: -2.268431, valid: false } },
  ] }; };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const eris = createEris({ data: source, code: { execute: unexpected, read: unexpected }, specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } });
  const tool = eris.tools.find(tool => tool.name === "search_data")!;
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "search", signal: new AbortController().signal, progress() {} };
  const terms = ["PCB", "高速铜缆", "-2.268431", "不存在"];
  const result = JSON.parse((await tool.execute({ reference, query: terms, limit: 100 }, context)).content[0].text!);
  assert.equal(loads, 1, "multiple terms must share source loading and extraction");
  assert.deepEqual(result.queries, terms.map(query => ({ query, total: query === "不存在" ? 0 : 1 })));
  for (const query of terms) {
    const single = await source.search(reference, query, { limit: 100 });
    assert.deepEqual(result.matches.filter((hit: { matchedQueries: string[] }) => hit.matchedQueries.includes(query)), single.matches);
  }
  const hit = result.matches[0];
  const page = await source.read(reference, { view: "evidence", messages: [{ messageIndex: hit.reference.messageIndex, format: hit.format, offset: hit.readOffset }] });
  assert((page.items as { text: string }[])[0].text.startsWith(hit.text));
  const next = JSON.parse((await tool.execute({ reference, query: terms, offset: 1, limit: 1 }, context)).content[0].text!);
  assert.deepEqual(next.matches, result.matches.slice(1, 2));
  assert.deepEqual(next.queries, result.queries);
  assert.equal(next.nextOffset, 2);
  assert.equal(next.nextRead.tool, "search_data");
  const remaining = JSON.parse((await tool.execute(next.nextRead.args, context)).content[0].text!);
  assert.deepEqual(remaining.matches, result.matches.slice(2, 3));
  for (const query of [[], [""], ["PCB", "PCB"], Array.from({ length: 9 }, (_, i) => String(i))]) assert.throws(() => tool.validate!({ reference, query }));
});

test("local search accepts node references and never expands an explicit node to the entire answer", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "input", messageIndex: 1 };
  source.raw = async () => ({ messages: [{ role: "tool", content: "原始数据" }, { role: "assistant", content: "原始数据的解释" }] });
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency"); };
  const tool = createEris({ data: source, code: { execute: unexpected, read: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected } }).tools.find(tool => tool.name === "search_data")!;
  const context = { scope: { userId: "test", sessionId: "test" }, callId: "node-search", signal: new AbortController().signal, progress() {} };
  const found = JSON.parse((await tool.execute({ reference, query: "原始数据" }, context)).content[0].text!);
  assert.equal(found.scope, "all");
  assert.equal(found.total, 1);
  assert.deepEqual(found.matches[0].reference, reference);
  const evidence = JSON.parse((await tool.execute({ reference, query: "原始数据", scope: "evidence" }, context)).content[0].text!);
  assert.equal(evidence.total, 0, "an explicit evidence filter remains authoritative for the selected node");
  await assert.rejects(tool.execute({ reference: { ...reference, messageIndex: 99 }, query: "原始数据" }, context), /out of range/);
});

test("structured evidence preserves native numbers, booleans and row relationships with exact JSON coordinates", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  const message = { type: "tool_result", output: { rows: [{ name: "甲", price: -2.268431, valid: false }, { name: "乙", price: 0, valid: true }] } };
  source.raw = async () => ({ messages: [message] });
  const result = await source.read(reference, { view: "evidence", messages: [{ messageIndex: 0, ...{ format: "json" as const } }] });
  const item = (result.items as { text: string; evidence: { evidence_id: string; quote: string }[] }[])[0];
  assert.deepEqual(JSON.parse(item.text), message);
  assert.equal(item.evidence[0].quote, item.text);
  assert.match(item.evidence[0].evidence_id, /_json_0_\d+_$/);
  const hit = (await source.search(reference, "-2.268431")).matches as { format: string; readOffset: number }[];
  assert.equal(hit.length, 1, "native numeric values must be searchable");
  assert.equal(hit[0].format, "json");
  const pages = await source.read(reference, { view: "evidence", messages: [
    { messageIndex: 0, limit: 35, ...{ format: "json" as const } }, { messageIndex: 0, offset: 35, ...{ format: "json" as const } },
  ] });
  assert.equal((pages.items as { text: string }[]).map(page => page.text).join(""), item.text);
});

test("Eris's paginated directory exposes persisted display names, tiers and configured comparison groups", async () => {
  const fixture = await fixtureConfig();
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    fixture.config.inputs.versions.find((version) => version.id === "a_fast")!.display_name = "A组极速";
    const source = await register(fixture.config);
    const first = await source.list({ runId: "source", limit: 1 });
    assert(first.kind === "inputs");
    const rest = await source.list({ runId: "source", offset: first.nextOffset!, limit: 100 });
    assert(first.kind === "inputs" && rest.kind === "inputs");
    assert.equal(first.total, 4);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 1);
    assert.equal(rest.hasMore, false);
    assert.equal(rest.nextOffset, null);
    assert.equal(first.summaryScope, "run");
    assert.equal(first.summary.inputCount, 4);
    assert.equal(first.summary.caseCount, 1);
    assert.deepEqual(rest.summary, first.summary, "whole-run progress does not depend on the input page");
    assert.deepEqual(first.comparisonGroups, [
      { comparisonTier: "Fast", models: [{ model: "a_fast", modelName: "A组极速" }, { model: "b_fast", modelName: "B组Fast" }] },
      { comparisonTier: "Expert", models: [{ model: "a_expert", modelName: "A组Expert" }, { model: "b_expert", modelName: "B组Expert" }] },
    ]);
    assert.deepEqual(rest.comparisonGroups, first.comparisonGroups);
    const items = [...first.items, ...rest.items];
    assert.deepEqual(items.map(({ model, modelName, comparisonTier }) => ({ model, modelName, comparisonTier })).sort((a, b) => a.model.localeCompare(b.model)), [
      { model: "a_expert", modelName: "A组Expert", comparisonTier: "Expert" },
      { model: "a_fast", modelName: "A组极速", comparisonTier: "Fast" },
      { model: "b_expert", modelName: "B组Expert", comparisonTier: "Expert" },
      { model: "b_fast", modelName: "B组Fast", comparisonTier: "Fast" },
    ]);
    assert(items.every((item) => item.reference.runId === "source" && item.reference.inputId === item.inputId));
    assert(items.every((item) => item.tasks.every((task) => task.status === "pending")), "configured groups do not imply completed results");
    assert.equal(new Set(items.flatMap(item => item.tasks).filter(task => task.purpose === "comparison_formal").map(task => task.taskId)).size, 2);
    const found = await source.list({ runId: "source", query: "A组极速" });
    assert(found.kind === "inputs");
    assert.equal(found.total, 1);
    assert.equal(found.items[0].model, "a_fast");
    const filteredEmpty = await source.list({ runId: "source", query: "inputs" });
    assert(filteredEmpty.kind === "inputs");
    assert.equal(filteredEmpty.total, 0, "query is a text filter, even when it happens to name the returned kind");
    assert.deepEqual(filteredEmpty.summary, first.summary, "a zero-match text filter cannot erase whole-run statistics");
    const unfiltered = await source.list({ runId: "source" });
    assert(unfiltered.kind === "inputs");
    assert.equal(unfiltered.total, 4, "a filtered empty page does not mean the run has no input data");
    assert.equal(new Set(unfiltered.items.map((item) => JSON.stringify([item.batchId, item.caseId]))).size, 1,
      "the four model answers cover one business question across both tiers");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("unknown task IDs direct Eris to question lookup without pretending the result is pending", async () => {
  const fixture = await fixtureConfig();
  try {
    const source = await register(fixture.config);
    const saved = await readJson<Checkpoint>(path.join(fixture.config.output.path, "source/state.json"));
    const taskId = Object.keys(saved.tasks)[0]!;
    const mistyped = taskId.slice(0, 9) + (taskId[9] === "a" ? "b" : "a") + taskId.slice(10);
    for (const options of [undefined, { view: "case" as const }]) {
      await assert.rejects(source.read({ runId: "source", taskId: mistyped }, options), (error: Error) => {
        assert.match(error.message, /taskId 未登记/);
        assert.match(error.message, /原问关键词/);
        assert.doesNotMatch(error.message, /没有已接受|read_data|read_specialist/);
        return true;
      });
      await assert.rejects(source.read({ runId: "source", taskId: "unknown" }, options), /taskId 未登记.*list_data/);
      await assert.rejects(source.read({ runId: "source", taskId }, options), /没有已接受的正式结果/);
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris exposes whole-run formal standings and read scopes from recorded results without reading answer sources", async () => {
  const fixture = await fixtureConfig();
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const { source, accepted } = await registerAccepted(fixture.config);
    const checkpointPath = path.join(fixture.config.output.path, "source/state.json");
    const saved = await readJson<Checkpoint>(checkpointPath);
    const formal = Object.values(saved.tasks).find((task) => task.receipt?.exported?.comparisonId)!;
    delete formal.receipt!.exported!.file;
    await saveCheckpoint(checkpointPath, saved);
    const directory = await source.list({ runId: "source", limit: 1, query: "a_fast" });
    assert(directory.kind === "inputs");
    const stats = directory.summary.formalComparisonStats;
    assert(stats);
    assert.equal(stats.formalResultCount, 2);
    assert.equal(stats.comparisonCount, 2);
    assert.deepEqual(stats.tiers.map(({ comparisonTier, comparisonCount, outcomes }) => ({ comparisonTier, comparisonCount, outcomes })), [
      { comparisonTier: "Fast", comparisonCount: 1, outcomes: { win: 0, both_good: 1, both_bad: 0 } },
      { comparisonTier: "Expert", comparisonCount: 1, outcomes: { win: 0, both_good: 1, both_bad: 0 } },
    ]);
    assert(stats.tiers.every((tier) => tier.models.length === 2 && tier.models.every((model) => model.both_good === 1 && model.comparisonCount === 1)));
    const defaults = await source.list({ runId: "source", view: "comparisons" });
    assert(defaults.kind === "comparisons");
    assert.equal(defaults.total, 0, "both-good cases are excluded from default example retrieval");
    const first = await source.list({ runId: "source", view: "comparisons", outcome: "all", query: "计算2+2", limit: 1 });
    assert(first.kind === "comparisons");
    assert.equal(first.total, 2, "question search must find accepted battles without reading raw messages");
    assert.equal(first.items.length, 1);
    assert.equal(first.nextOffset, 1);
    assert("questionPreview" in first.items[0], "directory entries include a question preview");
    assert.equal(first.items[0].questionPreview, "计算2+2");
    assert.equal(first.items[0].inputs.length, 2);
    for (const input of first.items[0].inputs) {
      assert.equal(input.reference.runId, "source");
      assert.equal(saved.inputs[input.reference.inputId]!.version, input.model);
      assert.equal(input.comparisonTier, first.items[0].comparisonTier);
    }
    const next = await source.list({ runId: "source", view: "comparisons", outcome: "all", offset: first.nextOffset!, limit: 1 });
    assert(next.kind === "comparisons");
    assert.equal(next.hasMore, false);
    assert.notDeepEqual(next.items[0].reference, first.items[0].reference);
    const different = await source.list({ runId: "source", view: "comparisons", outcome: "all", sample: true, limit: 1,
      excludeCases: [first.items[0].case] });
    assert(different.kind === "comparisons");
    assert.equal(different.items.length, 0, "another example excludes every tier of the already viewed case");
    const empty = await source.list({ runId: "source", view: "comparisons", outcome: "all", query: "不存在的原问" });
    assert(empty.kind === "comparisons");
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.summary.formalComparisonStats, stats, "case search must not change aggregate denominators");
    const runs = await source.list({ query: "no-match" });
    assert(runs.kind === "runs");
    assert.deepEqual(runs.currentRun!.summary.formalComparisonStats, stats, "history filtering cannot change current formal standings");
    await assert.rejects(source.read({ runId: "source", query: "计算2+2" }), (error: Error) => {
      assert.match(error.message, /匹配到 2 场/);
      assert.match(error.message, /"reference".*"taskId"/);
      assert.match(error.message, /"comparisonTier":"Fast"/);
      return true;
    });
    for (const record of stats.records) {
      assert.equal(record.question, "计算2+2");
      const result = await source.read(record.reference);
      assert.deepEqual(result.comparisonScope, record.scope);
      assert.deepEqual(result.result, accepted[record.reference.taskId]!.exported!.row, "read_data keeps the complete formal row alongside its scope");
      const material = await source.read(record.reference, { view: "case" });
      const lookup = { runId: "source", query: "计算2+2", comparisonTier: record.scope.comparisonTier! };
      assert.deepEqual(await source.read(lookup), result, "question and tier resolve the exact accepted receipt without copying an ID");
      assert.deepEqual(await source.read(lookup, { view: "case" }), material);
      assert.equal(material.kind, "case");
      assert.equal(material.question, record.question);
      assert.deepEqual(material.formal, result);
      const answers = material.answers as { reference: { runId: string; inputId: string }; answer: { text: string; complete: boolean; reference: { messageIndex: number } }; trace: { finalMessageIndex: number } }[];
      assert.equal(answers.length, 2);
      for (const answer of answers) {
        assert.equal(answer.answer.complete, true);
        assert(answer.answer.text.includes("4"));
        assert.equal(answer.answer.reference.messageIndex, answer.trace.finalMessageIndex);
        const single = await source.read(answer.reference, { view: "case" });
        assert.deepEqual(single.answers, [answer]);
        assert.equal(single.formal, undefined);
      }
    }
    await assert.rejects(source.read({ runId: "source", query: "不存在的题目", comparisonTier: "Fast" }), /没有匹配/);
    await assert.rejects(source.read({ runId: "source", query: "计算2+2", comparisonTier: "Other" }), /没有匹配/);
    await assert.rejects(source.read({ runId: "source", query: " ", comparisonTier: "Fast" }), /不能为空/);
    const duplicate = structuredClone(saved.tasks[stats.records[0]!.reference.taskId]!);
    saved.tasks[randomUUID()] = duplicate;
    await saveCheckpoint(checkpointPath, saved);
    await assert.rejects(source.read({ runId: "source", query: "计算2+2", comparisonTier: stats.records[0]!.scope.comparisonTier! }), /匹配到 2 场/);
    const broken = structuredClone(accepted[stats.records[0]!.reference.taskId]!.exported!.row);
    broken.verdicts = {};
    await writeJsonl(path.join(fixture.config.output.path, "source/results/comparison.jsonl"), [broken]);
    const usable = await source.list({ runId: "source", limit: 1 });
    assert(usable.kind === "inputs");
    assert.equal(usable.items.length, 1, "comparison corruption cannot make the input directory unreadable");
    assert.equal(usable.summary.formalComparisonStats, null);
    assert.equal(usable.summary.statisticsError?.retryable, false);
    await assert.rejects(source.list({ runId: "source", view: "comparisons" }), /comparison_statistics_unavailable/);
    const partial = await source.list({ view: "statistics" });
    assert(partial.kind === "statistics");
    assert.equal(partial.currentRuns.length, 1);
    assert.equal(partial.currentRuns[0]!.summary.formalComparisonStats, null);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris chooses a recorded running data run before recent finished runs, excluding empty maintenance and page filters", async () => {
  const fixture = await fixtureConfig();
  try {
    const source = await register(fixture.config);
    const saved = await readJson<Checkpoint>(path.join(fixture.config.output.path, "source/state.json"));
    await saveCheckpoint(path.join(fixture.config.output.path, "later/state.json"), { ...saved, runId: "later", status: "finished", startedAt: 20, finishedAt: 21 });
    await saveCheckpoint(path.join(fixture.config.output.path, "maintenance/state.json"), { ...saved, runId: "maintenance", startedAt: 30, inputs: {}, tasks: {} });
    const directory = await source.list({ limit: 1 });
    assert(directory.kind === "runs");
    assert.equal(directory.items[0]!.runId, "maintenance", "the directory still sorts by recorded start time");
    assert.equal(directory.currentRun!.runId, "source");
    assert.equal(directory.currentRun!.selectionReason, "running_with_inputs");
    assert.equal(directory.currentRun!.summary.inputCount, 4);
    assert(!Object.hasOwn(directory.items[0]!, "summary"), "history entries remain compact; only the selected run carries full progress");
    assert.deepEqual(directory.runCounts, { scope: "all_registered_runs", total: 3, states: { running: 2, finished: 1, interrupted: 0 } });
    const filtered = await source.list({ query: "no-match", offset: 1 });
    assert(filtered.kind === "runs");
    assert.equal(filtered.total, 0);
    assert.deepEqual(filtered.currentRun, directory.currentRun, "query and pagination only filter returned history entries");
    assert.deepEqual(filtered.runCounts, directory.runCounts);
    const inputs = await source.list({ view: "inputs", query: "no-match" });
    assert(inputs.kind === "inputs" && "selectionReason" in inputs);
    assert.equal(inputs.runId, "source");
    assert.equal(inputs.selectionReason, "running_with_inputs");
    assert.equal(inputs.total, 0, "no matches must not silently switch to another run");
    const explicit = await source.list({ runId: "later", view: "inputs" });
    assert(explicit.kind === "inputs");
    assert.equal(explicit.runId, "later");
    await assert.rejects(source.list({ runId: "missing", view: "comparisons" }), /ENOENT/);
    await saveCheckpoint(path.join(fixture.config.output.path, "source/state.json"), { ...saved, status: "interrupted" });
    const fallback = await source.list({ query: "source" });
    assert(fallback.kind === "runs");
    assert.equal(fallback.currentRun!.runId, "later");
    assert.equal(fallback.currentRun!.selectionReason, "latest_with_inputs");
    assert.equal(fallback.currentRun!.summary.finishedAt, 21);
    const comparisons = await source.list({ view: "comparisons", sample: true, limit: 1 });
    assert(comparisons.kind === "comparisons" && "selectionReason" in comparisons);
    assert.equal(comparisons.runId, "later");
    assert.equal(comparisons.selectionReason, "latest_with_inputs");
    assert.equal(comparisons.items.length, 0);
    await saveCheckpoint(path.join(fixture.config.output.path, "source/state.json"), { ...saved, inputs: {}, tasks: {} });
    await saveCheckpoint(path.join(fixture.config.output.path, "later/state.json"), { ...saved, runId: "later", inputs: {}, tasks: {} });
    await assert.rejects(source.list({ view: "inputs" }), /没有含输入的已登记运行/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris's directory keeps undeclared tiers unknown even when model names contain Fast", async () => {
  const fixture = await fixtureConfig();
  try {
    for (const version of fixture.config.inputs.versions) delete version.comparison_tier;
    const version = fixture.config.inputs.versions.find((item) => item.id === "a_fast")!;
    delete version.display_name;
    const source = await register(fixture.config);
    const directory = await source.list({ runId: "source" });
    assert(directory.kind === "inputs");
    assert(directory.items.every((item) => item.comparisonTier === null));
    assert.equal(directory.items.find((item) => item.model === "a_fast")!.modelName, "A Fast");
    assert.deepEqual(directory.comparisonGroups, [
      { comparisonTier: null, models: [{ model: "a_fast", modelName: "A Fast" }, { model: "b_fast", modelName: "B组Fast" }] },
    ]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});


test("entity searches expose the source body rather than just its trailing title in either scope", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  const body = "公司拥有通用清洗及湿法刻蚀设备；本记录未确认目标用途。";
  source.raw = async () => ({ messages: [{ type: "tool_result", output: { items: [
    { summary: "乙公司只有清洗设备", title: "乙公司新闻", query: "甲公司 TSV" },
    { summary: body + "余文".repeat(400), title: "甲公司年度报告", query: "甲公司 TSV" },
  ] } }, { role: "assistant", content: "甲公司只是配套，应排除" }] });
  for (const scope of ["evidence", "all"] as const) {
    const hits = (await source.search(reference, "甲公司", { scope })).matches as JsonObject[];
    assert.equal(object(hits[0].source).title, "甲公司年度报告", "a trailing title identifies its own body, even when all message kinds are requested");
    assert.match(hits[0].text as string, /湿法刻蚀/);
    assert.doesNotMatch(hits[0].text as string, /乙公司/);
    const read = object(object(hits[0].source).read);
    const result = await source.read(reference, { view: "evidence", messages: [read as {messageIndex: number; offset: number; limit: number}] });
    assert((result.items as JsonObject[])[0].text!.toString().startsWith(body));
    assert.doesNotMatch((result.items as JsonObject[])[0].text as string, /乙公司/);
  }
});


test("batched entities share one complete document without dropping matched queries or read coordinates", async () => {
  const source = new LocalAnalysisData("unused"), reference = { runId: "run", inputId: "11111111-1111-4111-8111-111111111111" };
  const summary = "甲公司具有清洗、湿法刻蚀能力，乙公司从事CMP；两者目标用途仍需核验。";
  source.raw = async () => ({ messages: [{ type: "tool_result", output: {items:[{title:"甲公司与乙公司能力",summary}]}}] });
  const result = await source.search(reference, ["甲公司", "乙公司", "湿法刻蚀"]);
  const hits = result.matches as JsonObject[];
  assert.equal(hits.length, 1, "one article must not be repeated for each entity or capability query");
  assert.deepEqual(new Set(hits[0].matchedQueries as string[]), new Set(["甲公司", "乙公司", "湿法刻蚀"]));
  assert.deepEqual(result.queries, ["甲公司", "乙公司", "湿法刻蚀"].map(query => ({query,total:1})));
  assert((hits[0].text as string).includes(summary), "the complete counterevidence survives deduplication");
  const page = await source.read(reference, {view:"evidence",messages:[object(object(hits[0].source).read) as {messageIndex:number}]});
  assert.equal((page.items as JsonObject[])[0].text, hits[0].text);
});
