import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEris } from '@eval/assistant';
import { ROOT } from '../../tests/fixtures/services.js';
const data = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-data.js')).href);
const { chartFromToolOutput } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/charts.js')).href);
const { researchOption } = await import(pathToFileURL(path.join(ROOT, 'agent/src/client/chart-research.js')).href);
const base = { title: '比较实际指标', scope: '固定期间 · 样本 n=3', source: '测试来源', unit: '次', categories: ['甲', '乙', '丙'], series: [{ name: 'A组', values: [10, 20, 30] }] };
const samples = [
  { ...base, type: 'dumbbell', series: [...base.series, { name: 'B组', values: [12, null, 27] }] },
  { ...base, type: 'heatmap', series: [...base.series, { name: 'B组', values: [5, null, 0] }], annotations: [{ categoryIndex: 2, seriesIndex: 0, note: '问题集中在丙' }] },
  { ...base, type: 'scatter', xValues: [2, 4, 9], xLabel: '时间', xUnit: '秒' },
  { ...base, type: 'waterfall', series: [{ name: '金额变动', values: [100, -130, 40] }] },
  { ...base, type: 'histogram' },
];
const context = { scope: { userId: 'test', sessionId: 'test' }, callId: 'chart', signal: new AbortController().signal, progress() {} };
const unexpected = async (): Promise<never> => { throw new Error('Unexpected dependency'); };
const eris = createEris({ data: { list: async () => ({ kind: 'inputs' }), read: unexpected, search: unexpected, image: unexpected }, specialists: { invoke: unexpected, read: unexpected }, save: unexpected, search: { search: unexpected }, web: { read: unexpected } });
const tool = eris.tools.find(t => t.name === 'show_chart')!;

test('all research charts pass the public tool contract and remain readable after serialization', async () => {
  for (const chart of samples) {
    const result = await tool.execute({ ...chart, references: [{ runId: 'test' }] }, context);
    assert.deepEqual(chartFromToolOutput(result.content[0].text, 'ok'), chart);
    const options = researchOption(chart, 514);
    assert(options.series.length > 0);
    assert.equal(options.animation, false);
    assert.equal(options.tooltip.show, false);
    assert.equal(options.tooltip.triggerOn, 'none');
  }
});

test('research chart geometry preserves unknown pairs, raw distribution counts and signed cumulative values', () => {
  const dumbbell = researchOption(samples[0]);
  assert.equal(dumbbell.series[0].data.length, 2, 'a missing endpoint has no fabricated connector');
  assert.equal(dumbbell.series[2].data.length, 2);
  const heatmap = researchOption(samples[1]);
  assert.equal(heatmap.series[0].data.length, 5, 'unknown is a missing cell; a recorded zero stays a cell');
  assert(heatmap.series[0].data.some((p: { value: number[] }) => p.value[2] === 0));
  assert.deepEqual(heatmap.series.at(-1).data[0], [2, 0]);
  assert.deepEqual(data.waterfallSteps(samples[3]).map((s: { start: number; end: number }) => [s.start, s.end]), [[0, 100], [100, -30], [-30, 10], [0, 10]]);
  for (const values of [[1, 1, 1], [-5, 0, 5, 10], [0, 0, 0, 1, 10]]) {
    const bins = data.histogramBins(values);
    assert.equal(bins.reduce((sum: number, bin: { count: number }) => sum + bin.count, 0), values.length);
    assert.equal(bins.at(-1).high, Math.max(...values));
  }
  assert.deepEqual(data.chartTable(samples[0]).rows.map((row: unknown[]) => row.at(-1)), [2, null, -3]);
  assert.equal(data.decimalSum([0.1, 0.2]), 0.3);
  assert(data.chartTable({ ...samples[0], unit: '%' }).columns.at(-1).includes('百分点'));
  assert.equal(data.chartReading(samples[1], { sourceSeries: 1, categoryIndex: 1 }, 0), '乙 · B组：未知');
  assert.equal(data.chartReading(samples[2], { sourceSeries: 0, categoryIndex: 2 }, 0), '丙 · 时间：9 秒 · A组：30 次');
});

test('invalid analytic shapes and unsupported annotations fail before source access', async () => {
  for (const chart of [
    { ...samples[0], series: base.series }, { ...samples[2], xValues: [1, 2] },
    { ...samples[2], xValues: [1, null, 3] }, { ...samples[2], xLabel: '' },
    { ...samples[3], series: [{ name: 'A', values: [1, null, 2] }] },
    { ...samples[4], series: [...base.series, ...base.series] },
    { ...samples[1], annotations: [{ categoryIndex: 1, seriesIndex: 1, note: '不存在的点' }] },
    { ...samples[1], annotations: [{ categoryIndex: 5, seriesIndex: 0, note: '越界' }] },
  ]) {
    await assert.rejects(tool.execute({ ...chart, references: [{ runId: 'test' }] }, context));
    assert.equal(chartFromToolOutput(JSON.stringify({ kind: 'chart', chart }), 'ok'), null);
  }
});

test('compact layers use observed quartiles and keep unknown differences unknown', () => {
  assert.equal(data.quantile([1, 2, 3, 4], .5), 2.5);
  assert.equal(data.quantile([1, 2, 3, 4], .25), 1.75);
  const matrix = researchOption(samples[1]);
  const delta = matrix.series.find((s: { data?: { derived?: string }[] }) => s.data?.[0]?.derived === 'difference');
  assert(delta);
  assert.deepEqual(data.pairedDifferences(samples[1]).map((p: { value: number | null }) => p.value), [-5, null, -30]);
  assert.equal(data.chartReading(samples[1], { derived: 'difference', categoryIndex: 1 }, 0), '乙 · B组 − A组：未知');
  assert(data.chartTable(samples[1]).columns.at(-1).includes('B组 − A组'));
  const scatter = researchOption(samples[2]);
  assert.deepEqual(scatter.series[0].markLine.data, [{ xAxis: 4 }, { yAxis: 20 }]);
  const histogram = researchOption(samples[4]);
  assert.equal(histogram.xAxis.type, 'value');
  assert.equal(histogram.series[1].data.length, 3, 'the rug represents the original observations');
  assert.deepEqual(histogram.series[0].markArea.data, [[{ xAxis: 15 }, { xAxis: 25 }]]);
  assert(data.compactNumber(1e-9).includes('E-9'), 'compact annotations never round a small observation to zero');
});
