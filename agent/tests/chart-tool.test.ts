import test from "node:test";
import assert from "node:assert/strict";
import { createEris, type ErisDependencies } from "@eval/assistant";

const context = { scope: { userId: "alice", sessionId: "session" }, callId: "chart", signal: new AbortController().signal, progress() {} };
const chart = {
  type: "heatmap", title: "FAST 已裁决胜场接近", scope: "FAST · 11场已裁决", unit: "场", source: "本次正式对比结果",
  categories: ["A组Fast", "B组Fast"], series: [{ name: "胜场", values: [6, 5] }], references: [{ runId: "evaluation-internal" }],
};
const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
function chartTool(data: ErisDependencies["data"], specialists: ErisDependencies["specialists"] = { invoke: unexpected, read: unexpected }) {
  return createEris({ code: { execute: unexpected, read: unexpected }, data, specialists, search: { search: unexpected }, web: { read: unexpected } }).tools.find((tool) => tool.name === "show_chart")!;
}
const noData = { list: unexpected, read: unexpected, search: unexpected, image: unexpected };
const timing = { status: "finished", batches: ["2026-10-10"], timeScope: { timeZone: "Asia/Shanghai",
  evaluation: { from: "2026-10-10T08:16:00.000+08:00", to: "2026-10-12T06:54:00.000+08:00" as string | null },
  acceptedResults: { from: "2026-10-10T08:18:00.000+08:00", through: "2026-10-10T22:02:00.000+08:00" }, sampleTimeRange: null } };

test("an out-of-range or missing-value annotation does not discard the actual chart", async () => {
  const tool = chartTool(noData);
  const input = { ...chart, references: undefined, series: [{ name: "胜场", values: [6, null] }], annotations: [
    { categoryIndex: 9, seriesIndex: 0, note: "不存在的类别" },
    { categoryIndex: 1, seriesIndex: 0, note: "没有记录的值" },
    { categoryIndex: 0, seriesIndex: 0, note: "已有6场" },
  ] };
  const before = structuredClone(input);
  const result = await tool.execute(input, context);
  const output = JSON.parse(result.content[0].text!).chart;
  assert.deepEqual(output.series, input.series);
  assert.deepEqual(output.categories, input.categories);
  assert.deepEqual(output.annotations, [input.annotations[2]]);
  assert.deepEqual(result.details, { omittedAnnotations: [0, 1] });
  assert.deepEqual(input, before);
});

test("formal statistics charts read counts once and preserve the model's analysis without copied data fields", async () => {
  const statistics = { runId: "run", comparisonTier: "Fast" };
  const references = [{ runId: "run", taskId: "accepted" }];
  const models = [
    { model: "a", modelName: "A组Fast", comparisonCount: 11, wins: 6, losses: 5, both_good: 0, both_bad: 0 },
    { model: "b", modelName: "B组Fast", comparisonCount: 11, wins: 5, losses: 6, both_good: 0, both_bad: 0 },
  ];
  const calls: unknown[] = [];
  const source = { kind: "inputs", evaluatorVersion: "fixture", summary: { ...timing,
    formalComparisonStats: { tiers: [{ comparisonTier: "Fast", comparisonCount: 11, references, models }] } } };
  const before = structuredClone(source);
  const tool = chartTool({ ...noData, async list(query) { calls.push(query); return source; } });
  const input = { title: "A 略多胜场，尚不能判断显著性", statistics, caveat: "仅覆盖该批次已裁决样本",
    annotations: [{ categoryIndex: 0, seriesIndex: 0, note: "6场胜出需要结合题型分布解读" }] };
  const result = await tool.execute(input, context);
  assert.deepEqual(calls, [{ runId: "run", limit: 1 }]);
  assert.deepEqual(JSON.parse(result.content[0].text!), { kind: "chart", chart: {
    type: "heatmap", title: input.title, scope: "2026-10-10 · Fast 11场", unit: "场", source: "本地正式对战统计",
    categories: ["A组Fast", "B组Fast"], series: [
      { name: "胜场", values: [6, 5] }, { name: "负场", values: [5, 6] },
      { name: "双方均好", values: [0, 0] }, { name: "双方均差", values: [0, 0] },
    ], caveat: input.caveat, annotations: input.annotations,
  } });
  assert.deepEqual(result.details, { references: [{ statistics, evaluatorVersion: "fixture", references,
    timeScope: timing.timeScope, batches: timing.batches }] });
  assert.deepEqual(source, before);
  assert.equal(Object.hasOwn(input, "categories"), false, "normalization must not mutate tool arguments");
  models[0]!.wins = 7; models[0]!.losses = 4;
  models[1]!.wins = 4; models[1]!.losses = 7;
  const refreshed = await tool.execute({ ...input, type: "bubble_matrix" }, context);
  assert.equal(calls.length, 2, "do not reuse stale data across executions");
  assert.deepEqual(JSON.parse(refreshed.content[0].text!).chart.series[0].values, [7, 4]);
});

test("statistics chart selectors cannot silently override supplied numbers or unrelated visual semantics", async () => {
  const tool = chartTool(noData);
  const input = { title: "战绩", statistics: { runId: "run", comparisonTier: "Fast" } };
  for (const invalid of [
    { ...input, statistics: { runId: "run" } }, { ...input, categories: ["A"] }, { ...input, series: chart.series },
    { ...input, unit: "%" }, { ...input, source: "另一来源" }, { ...input, scope: "全部历史" },
    { ...input, references: chart.references }, { ...input, type: "pie" },
    { ...input, type: "line" }, { ...input, maxValue: 100 }, { ...input, metric: "accuracy" },
  ]) await assert.rejects(tool.execute(invalid, context), /参数无效/);
});

test("missing or inconsistent formal counts cannot become zero-valued chart observations", async () => {
  const model = { model: "a", modelName: "A组", comparisonCount: 2, wins: 1, losses: 1, both_good: 0, both_bad: 0 };
  for (const models of [undefined, [], [{ ...model, wins: null }], [{ ...model, losses: undefined }],
    [{ ...model, both_bad: -1 }], [{ ...model, wins: 1.5 }], [{ ...model, comparisonCount: 3 }]]) {
    const tool = chartTool({ ...noData, async list() { return { kind: "inputs", summary: { ...timing,
      formalComparisonStats: { tiers: [{ comparisonTier: "Fast", comparisonCount: 2, references: [{ runId: "run", taskId: "one" }], models }] } } }; } });
    await assert.rejects(tool.execute({ title: "战绩", statistics: { runId: "run", comparisonTier: "Fast" } }, context), /完整.*计数/);
  }
});

test("manual charts default to a value matrix and derive a local source only after reference verification", async () => {
  const tool = chartTool({ ...noData, async list() { return { kind: "inputs" }; } });
  const { type: _type, source: _source, ...input } = chart;
  const { references: _references, ...external } = input;
  const caveat = "未完成样本不在此图中";
  const result = await tool.execute({ ...input, caveat }, context);
  assert.deepEqual(JSON.parse(result.content[0].text!).chart, { ...external,
    type: "heatmap", source: "本地评测材料", caveat });
  await assert.rejects(tool.execute(external, context), /source/);
  const missing = chartTool({ ...noData, async list() { return { kind: "runs" }; } });
  await assert.rejects(missing.execute(input, context), /引用不存在/);
  await assert.rejects(tool.execute({ ...input, type: "concentric" }, context), /参数无效/,
    "explicit chart choices must not be changed or padded with invented series");
});

test("charts reject unsafe configuration and invalid geometry before reading sources", async () => {
  const tool = chartTool(noData);
  for (const invalid of [
    { ...chart, html: "<script>run()</script>" }, { ...chart, url: "https://example.com/data" },
    { ...chart, series: [{ name: "胜场", values: [6] }] },
    { ...chart, series: [{ name: "胜场", values: [Infinity, 5] }] },
    { ...chart, series: [{ name: "胜场", values: [NaN, 5] }] },
    { ...chart, series: [{ name: "胜场", values: [null, null] }] },
    { ...chart, series: [chart.series[0], chart.series[0]] },
    { ...chart, categories: ["重复", "重复"] }, { ...chart, title: " " },
    { ...chart, references: [] }, { ...chart, references: [{ runId: "run", operationId: "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada" }] },
    { ...chart, references: [{ reference: { runId: "run", messageIndex: 0 } }] },
    { ...chart, type: "line" },
    { ...chart, type: "line", categories: ["2026-10-02", "2026-10-01"] },
    { ...chart, type: "line", categories: ["2026-02-30", "2026-03-01"] },
    { ...chart, type: "line", categories: ["2026", "2026-01"] },
    { ...chart, type: "pie", series: [{ name: "组成", values: [6, -1] }] },
    { ...chart, type: "pie", series: [{ name: "组成", values: [6, null] }] },
    { ...chart, type: "pie", series: [{ name: "组成", values: [0, 0] }] },
  ]) await assert.rejects(tool.execute(invalid, context));
  assert.equal(tool.readOnly, true);
});

test("external material charts skip provenance references instead of borrowing a run", async () => {
  const tool = chartTool(noData);
  const { references: _, ...external } = chart;
  const response = await tool.execute(external, context);
  assert.equal(response.details, undefined, "external charts have no local source coordinates to store");
  const receipt = JSON.parse(response.content[0].text!);
  assert.deepEqual(receipt, { kind: "chart", chart: external });
  await assert.rejects(tool.execute({ ...chart, references: [] }, context), /references/);
});

test("chart output keeps source coordinates in metadata and preserves measured values and gaps", async () => {
  const calls: unknown[] = [];
  const tool = chartTool({ ...noData, async list(query) { calls.push(query); return { kind: "inputs", total: 56, evaluatorVersion: "fixture" }; } });
  const response = await tool.execute(chart, context);
  const { references: _, ...spec } = chart;
  const receipt = JSON.parse(response.content[0].text!);
  assert.deepEqual(receipt, { kind: "chart", chart: spec });
  assert.deepEqual(response.details, { references: [{ runId: "evaluation-internal", evaluatorVersion: "fixture" }] });
  assert.deepEqual(calls, [{ runId: "evaluation-internal", limit: 1 }]);
  assert(!response.content[0].text?.includes("evaluation-internal"));
  for (const valid of [
    { ...chart, series: [{ name: "增减", values: [-6, 5] }] },
    { ...chart, type: "line", categories: ["2025", "2026"], series: [{ name: "已记录数量", values: [null, 5] }] },
    { ...chart, type: "line", categories: ["2026-01", "2026-03"] },
    { ...chart, type: "pie", series: [{ name: "组成", values: [6, 0] }] },
  ]) {
    const result = await tool.execute(valid, context);
    assert.deepEqual(JSON.parse(result.content[0].text!).chart.series, valid.series);
  }
});

test("charts require existing materials and accepted specialist results", async () => {
  const operationId = "6a1b4a17-1039-4ead-ac32-9a37b0bf4ada";
  const tool = chartTool({ ...noData,
    async list() { return { kind: "runs" }; },
    async read(reference) {
      if ("inputId" in reference && reference.inputId === "answer") return { kind: "message", text: "来源材料" };
      if ("taskId" in reference && reference.taskId === "accepted") return { result: { conclusion: "已有结论" }, evaluatorVersion: "fixture" };
      return {};
    },
  }, { invoke: unexpected, async read(_, id) { return { operationId: id, kind: "comparison", state: id === operationId ? "succeeded" : "running", evaluatorVersion: "fixture" }; } });
  const references = [{ reference: { runId: "run", inputId: "answer", messageIndex: 0 } }, { reference: { runId: "run", taskId: "accepted" } }, { operationId }];
  const result = await tool.execute({ ...chart, references }, context);
  assert.deepEqual(result.details, { references: [
    references[0], { ...references[1], evaluatorVersion: "fixture" }, { operationId, evaluatorVersion: "fixture", reference: undefined },
  ] });
  for (const reference of [{ runId: "run" }, { reference: { runId: "run", taskId: "missing" } }, { reference: { runId: "run", inputId: "missing" } }, { operationId: "51b9dc2a-1292-4c4c-a71d-2db0b3f64d96" }])
    await assert.rejects(tool.execute({ ...chart, references: [reference] }, context), /不存在|已接受/);
});

test("comparison charts resolve every formal source in one aggregate read, including more than sixty results", async () => {
  const calls: unknown[] = [];
  const references = Array.from({ length: 80 }, (_, index) => ({ runId: "run", taskId: `result-${index}` }));
  const statistics = { runId: "run", comparisonTier: "Fast" };
  const tool = chartTool({ ...noData, async list(query) {
    calls.push(query);
    return { kind: "inputs", evaluatorVersion: "fixture", summary: { ...timing, formalComparisonStats: {
      tiers: [{ comparisonTier: "Fast", comparisonCount: 80, references }],
    } } };
  } });
  const result = await tool.execute({ ...chart, scope: "Fast · 80场已裁决", series: [{ name: "胜场", values: [45, 35] }], references: [{ statistics }] }, context);
  assert.deepEqual(calls, [{ runId: "run", limit: 1 }]);
  assert.deepEqual(result.details, { references: [{ statistics, evaluatorVersion: "fixture", references, timeScope: timing.timeScope, batches: timing.batches }] });
  assert(!result.content[0].text?.includes("result-79"), "source coordinates belong in metadata, not model-visible chart output");
  await assert.rejects(tool.execute({ ...chart, references: [{ statistics: { ...statistics, comparisonTier: "Expert" } }] }, context), /正式统计/);
  for (const invalid of [{ statistics, runId: "run" }, { statistics, reference: references[0] }, { statistics: { runId: "run" } }])
    await assert.rejects(tool.execute({ ...chart, references: [invalid] }, context));
  for (const summary of [{}, { formalComparisonStats: { tiers: [] } }, { formalComparisonStats: { tiers: [{ comparisonTier: "Fast", comparisonCount: 0, references: [] }] } }]) {
    const empty = chartTool({ ...noData, list: async () => ({ kind: "inputs", summary }) });
    await assert.rejects(empty.execute({ ...chart, references: [{ statistics }] }, context), /正式统计/);
  }
});

test("a two-tier chart reads each run once per execution and refreshes on the next execution", async () => {
  let reads = 0;
  const tool = chartTool({ ...noData, async list() {
    reads++;
    return { kind: "inputs", summary: { ...timing, formalComparisonStats: { tiers: ["Fast", "Expert"].map(comparisonTier => ({
      comparisonTier, comparisonCount: 1, references: [{ runId: "run", taskId: `${comparisonTier}-${reads}` }],
    })) } } };
  } });
  const input = { ...chart, references: ["Fast", "Expert"].map(comparisonTier => ({ statistics: { runId: "run", comparisonTier } })) };
  const first = await tool.execute(input, context);
  assert.equal(reads, 1, "Fast and Expert must share the same freshly read run");
  assert.equal(JSON.parse(first.content[0].text!).chart.scope, "2026-10-10 · Fast 1场、Expert 1场");
  assert.match(JSON.stringify(first.details), /Expert-1/);
  const second = await tool.execute(input, context);
  assert.equal(reads, 2, "do not cache across chart executions while evaluations may advance");
  assert.match(JSON.stringify(second.details), /Expert-2/);
});

test("formal chart scope shows source batch dates and tier counts, never evaluator timing", async () => {
  let scope = structuredClone(timing);
  const tool = chartTool({ ...noData, list: async () => ({ kind: "inputs", summary: { ...scope,
    formalComparisonStats: { tiers: [{ comparisonTier: "Fast", comparisonCount: 1, references: [{ runId: "run", taskId: "one" }] }] } } }) });
  const { scope: _scope, ...input } = { ...chart, references: [{ statistics: { runId: "run", comparisonTier: "Fast" } }] };
  const read = async (args = input) => JSON.parse((await tool.execute(args, context)).content[0].text!).chart.scope as string;
  assert.equal(await read(), "2026-10-10 · Fast 1场");
  assert.equal(await read({ ...input, ...{ scope: "重复样本数和未登记说明" } }), await read());
  scope = { ...timing, status: "running", timeScope: { ...timing.timeScope, evaluation: { ...timing.timeScope.evaluation, to: null } } };
  assert.equal(await read(), "2026-10-10 · Fast 1场");
  scope = { ...timing, timeScope: { ...timing.timeScope, evaluation: { from: "2025-12-31T23:00:00+08:00", to: "2026-01-01T01:00:00+08:00" } } };
  assert.equal(await read(), "2026-10-10 · Fast 1场", "evaluation dates cannot replace source dates");
  scope = { ...scope, batches: ["2025-12-31", "2026-01-01"] };
  assert.equal(await read(), "2025-12-31、2026-01-01 · Fast 1场");
  const { references: _references, ...external } = input;
  await assert.rejects(tool.execute(external, context), /参数无效/, "non-statistical charts still require their own scope");
});
