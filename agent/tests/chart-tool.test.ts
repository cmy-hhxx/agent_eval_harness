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
      if (reference.inputId === "answer") return { kind: "message", text: "来源材料" };
      if (reference.taskId === "accepted") return { result: { conclusion: "已有结论" }, evaluatorVersion: "fixture" };
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
    return { kind: "inputs", evaluatorVersion: "fixture", summary: { formalComparisonStats: {
      tiers: [{ comparisonTier: "Fast", comparisonCount: 80, references }],
    } } };
  } });
  const result = await tool.execute({ ...chart, scope: "Fast · 80场已裁决", series: [{ name: "胜场", values: [45, 35] }], references: [{ statistics }] }, context);
  assert.deepEqual(calls, [{ runId: "run", limit: 1 }]);
  assert.deepEqual(result.details, { references: [{ statistics, evaluatorVersion: "fixture", references }] });
  assert(!result.content[0].text?.includes("result-79"), "source coordinates belong in metadata, not model-visible chart output");
  await assert.rejects(tool.execute({ ...chart, references: [{ statistics: { ...statistics, comparisonTier: "Expert" } }] }, context), /正式统计/);
  for (const invalid of [{ statistics, runId: "run" }, { statistics, reference: references[0] }, { statistics: { runId: "run" } }])
    await assert.rejects(tool.execute({ ...chart, references: [invalid] }, context));
  for (const summary of [{}, { formalComparisonStats: { tiers: [] } }, { formalComparisonStats: { tiers: [{ comparisonTier: "Fast", comparisonCount: 0, references: [] }] } }]) {
    const empty = chartTool({ ...noData, list: async () => ({ kind: "inputs", summary }) });
    await assert.rejects(empty.execute({ ...chart, references: [{ statistics }] }, context), /正式统计/);
  }
});
